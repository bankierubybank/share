import { test, expect } from "./fixtures";
import { addEqualBill, createGroup, fill, openAddBill, pickOption, settled, showPanel, uniq } from "./helpers";

// v0.9: trip budget (#4), reminders (#6), offline bill entry (#8), summary image (#10), undo instead of
// "are you sure?" (#12).
const remote = !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.TARGET_URL ?? "http://localhost:8787");

async function openSettings(page: import("@playwright/test").Page) {
  await page.getByTestId("group-more").click();
  await page.getByTestId("group-settings").click();
  await expect(page.getByTestId("settings-dialog")).toHaveAttribute("data-ready", "1");
}

test("a trip budget shows what's left, then how much over", async ({ page }) => {
  await createGroup(page, `Budget ${uniq()}`, ["Ann", "Ben"], "THB");
  await openSettings(page);
  await fill(page, "edit-group-budget", "500");
  await page.getByTestId("edit-group-save").click();
  await expect(page.getByTestId("budget-text")).toHaveText("฿500.00 left of ฿500.00 budget");
  await addEqualBill(page, "Hotel", "450", "Ann");
  await expect(page.getByTestId("budget-text")).toHaveText("฿50.00 left of ฿500.00 budget");
  await expect(page.getByTestId("budget")).toHaveClass(/warn/);
  await addEqualBill(page, "Dinner", "150", "Ben");
  await expect(page.getByTestId("budget-text")).toHaveText("฿100.00 over the ฿500.00 budget");
  await expect(page.getByTestId("budget")).toHaveClass(/over/);
  // Clearing it removes the bar.
  await openSettings(page);
  await fill(page, "edit-group-budget", "");
  await page.getByTestId("edit-group-save").click();
  await expect(page.getByTestId("budget")).toHaveCount(0);
});

test("Remind shares a ready message for whoever owes", async ({ page }) => {
  await page.addInitScript(() => {
    (navigator as Navigator & { share: unknown }).share = async (d: ShareData) => { (window as unknown as { shared: ShareData[] }).shared.push(d); };
    (window as unknown as { shared: ShareData[] }).shared = [];
  });
  const name = `Remind ${uniq()}`;
  await createGroup(page, name, ["Ann", "Ben", "Cy"], "THB");
  await addEqualBill(page, "Boat", "300", "Ann");
  // I'm Ann (the creator): the header offers to remind the people who owe me.
  await page.getByTestId("hero-remind").first().click();
  const shared = () => page.evaluate(() => (window as unknown as { shared: ShareData[] }).shared);
  await expect.poll(async () => (await shared()).length).toBe(1);
  const one = (await shared())[0];
  expect(one.text).toContain(`For “${name}” you owe Ann ฿100.00.`);
  expect(one.text).toMatch(/\/g\/[A-Za-z0-9_-]{22}$/);
  await showPanel(page, "summary");
  await page.getByTestId("remind-all").click();
  await expect.poll(async () => (await shared()).length).toBe(2);
  const all = (await shared())[1].text!;
  expect(all).toContain("Ben pays Ann ฿100.00");
  expect(all).toContain("Cy pays Ann ฿100.00");
});

test("summary image: preview + download a PNG", async ({ page }) => {
  await createGroup(page, `Image ${uniq()}`, ["Ann", "Ben"], "THB");
  await addEqualBill(page, "Lunch", "200", "Ann");
  await page.getByTestId("group-more").click();
  await page.getByTestId("export-image").click();
  await expect(page.getByTestId("image-dialog")).toHaveAttribute("data-ready", "1");
  const img = page.getByTestId("summary-image");
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1080);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("image-download").click()]);
  expect(download.suggestedFilename()).toMatch(/-summary\.png$/);
});

test("deleting a comment can be undone, and only happens when not undone", async ({ page }) => {
  await createGroup(page, `Undo ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Beers", "300", "Ann");
  const open = async () => {
    await page.getByTestId("bill-item").filter({ hasText: "Beers" }).click();
    await expect(page.getByTestId("bill-dialog")).toHaveAttribute("data-ready", "1");
  };
  await open();
  await fill(page, "comment-input", "first round on me");
  await page.getByTestId("comment-post").click();
  await expect(page.getByTestId("comment")).toHaveCount(1);
  await page.getByTestId("comment-delete").click();
  await expect(page.getByTestId("comment-deleted")).toBeVisible();
  await page.getByTestId("comment-undo").click();
  await expect(page.getByTestId("comment")).toHaveCount(1);
  // Delete and close at once: it is deleted for real — even when reopened while the (slow) delete is on its way.
  // fallback(), not continue(): the fixture's context route adds the Access headers on prod.
  await page.route(/\/comments\/[^/]+$/, async (route) => {
    if (route.request().method() === "DELETE") await new Promise((r) => setTimeout(r, 1500));
    await route.fallback();
  });
  await page.getByTestId("comment-delete").click();
  await page.getByTestId("bill-cancel").click();
  await expect(page.getByTestId("bill-dialog")).toHaveCount(0);
  await expect(page.getByTestId("bill-item").filter({ hasText: "Beers" })).not.toContainText("comment");
  await open();
  await expect(page.getByTestId("comments")).toBeVisible();
  await expect(page.getByTestId("comment")).toHaveCount(0);
});

test("a bill added with no connection waits on the device and syncs once back online", async ({ page, context }) => {
  await page.addInitScript(() => localStorage.setItem("share.pollMs", "1000"));
  const dialogChunk = page.waitForResponse(/\/assets\/bill-dialog-[^/]+\.js$/); // prefetched after the page is up
  await createGroup(page, `Offline ${uniq()}`, ["Ann", "Ben"]);
  await dialogChunk;
  await context.setOffline(true);
  await openAddBill(page);
  await fill(page, "bill-amount", "120");
  await fill(page, "bill-description", "Street food");
  await pickOption(page, "bill-paid-by", "Ben");
  await page.getByTestId("bill-save").click();
  const row = page.getByTestId("bill-item").filter({ hasText: "Street food" });
  await expect(row.getByTestId("bill-queued")).toBeVisible();
  await expect(page.locator("#snackbar")).toContainText("No connection");
  await expect(page.getByTestId("my-net")).toHaveText(/You owe .*60\.00/); // counted already
  await context.setOffline(false);
  await expect(row.getByTestId("bill-queued")).toHaveCount(0, { timeout: remote ? 60_000 : 15_000 });
  await settled(page);
  await page.reload();
  await expect(page.getByTestId("bill-item").filter({ hasText: "Street food" })).toHaveCount(1);
});

test.describe("offline reopen (local: service worker allowed)", () => {
  test.skip(remote, "on prod the worker's own fetches would bypass the per-origin Access route (playwright.config.ts)");
  test.use({ serviceWorkers: "allow" });

  test("a trip opened before still opens offline, from this device's copy", async ({ page, context, browserName }) => {
    test.skip(browserName !== "chromium", "Playwright's offline mode + service workers: Chromium only");
    const name = `Reopen ${uniq()}`;
    await createGroup(page, name, ["Ann", "Ben"]);
    await addEqualBill(page, "Kayak", "400", "Ann");
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload(); // now controlled by the worker
    await expect(page.getByTestId("bill-item")).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId("offline-banner")).toBeVisible();
    await expect(page.getByTestId("group-title")).toHaveText(name);
    await expect(page.getByTestId("bill-item").filter({ hasText: "Kayak" })).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByTestId("offline-banner")).toHaveCount(0, { timeout: 20_000 });
  });
});
