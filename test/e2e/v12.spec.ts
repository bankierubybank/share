import { test, expect } from "./fixtures";
import { addEqualBill, createGroup, fill, openAddBill, saveBill, uniq } from "./helpers";
import type { Page } from "@playwright/test";

// v0.12: favourite bills (#4), leave trip (#6), several receipts at once (#10, canned locally via SCAN_FAKE),
// home search / sort / pin (#12).
const remote = !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.TARGET_URL ?? "http://localhost:8787");

async function openSettings(page: Page) {
  await page.getByTestId("group-more").click();
  await page.getByTestId("group-settings").click();
  await expect(page.getByTestId("settings-dialog")).toHaveAttribute("data-ready", "1");
}

async function receiptImage(page: Page, name = "receipt.png") {
  return { name, mimeType: "image/png", buffer: await page.screenshot({ clip: { x: 0, y: 0, width: 200, height: 300 } }) };
}

/** API calls from the page itself, so they go through the same Access route as the app (also on prod). */
const inPage = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(async ([m, p, b]) => {
    const r = await fetch(p as string, { method: m as string, headers: b ? { "Content-Type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, json: r.status === 204 ? null : await r.json() };
  }, [method, path, body] as const);

test("favourites: save a bill as one, add a new bill from it in one tap, remove it with undo", async ({ page }) => {
  await createGroup(page, `Fav ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Rent", "9000", "Ann");
  await page.getByTestId("bill-item").filter({ hasText: "Rent" }).first().click();
  await expect(page.getByTestId("bill-dialog")).toHaveAttribute("data-ready", "1");
  await page.locator("details.more summary").click();
  await page.getByTestId("fav-save").click();
  await expect(page.getByTestId("prompt-dialog")).toHaveAttribute("data-ready", "1");
  await expect(page.getByTestId("prompt-input").locator("input")).toHaveValue("Rent");
  await page.getByTestId("prompt-save").click();
  await expect(page.locator("#snackbar")).toContainText("Saved “Rent” as a favourite");
  await page.getByTestId("bill-cancel").click();
  await expect(page.getByTestId("bill-dialog")).toHaveCount(0);

  await openAddBill(page);
  await page.getByTestId("fav-chip").filter({ hasText: "Rent" }).click();
  await expect(page.getByTestId("bill-dialog")).toHaveCount(1);
  await expect(page.getByTestId("bill-dialog")).toHaveAttribute("data-ready", "1");
  await expect(page.getByTestId("bill-description").locator("input")).toHaveValue("Rent");
  await expect(page.getByTestId("bill-amount").locator("input")).toHaveValue("9000.00");
  await expect(page.getByTestId("fav-chips")).toHaveCount(0); // not offered again on a bill made from one
  await saveBill(page);
  await expect(page.getByTestId("bill-item").filter({ hasText: "Rent" })).toHaveCount(2);

  await openAddBill(page);
  await page.getByTestId("fav-chip").filter({ hasText: "Rent" }).getByRole("button", { name: /remove/i }).click();
  await expect(page.getByTestId("fav-chip")).toHaveCount(0);
  await expect(page.getByTestId("bill-dialog")).toHaveCount(1); // removing doesn't pick it
  await page.getByTestId("fav-undo").click(); // inline: the page's snackbar is behind the dialog
  await expect(page.getByTestId("fav-chip").filter({ hasText: "Rent" })).toHaveCount(1);
  await page.getByTestId("bill-cancel").click();
  await expect(page.getByTestId("bill-dialog")).toHaveCount(0);
  await openAddBill(page);
  await expect(page.getByTestId("fav-chip").filter({ hasText: "Rent" })).toHaveCount(1);
});

test("leave trip: refused while I'm the only one linked or not settled; then gone from my trips", async ({ page }) => {
  const gid = await createGroup(page, `Leave ${uniq()}`, ["Ann", "Ben"]);
  await openSettings(page);
  await page.getByTestId("leave-trip").click();
  await expect(page.locator("#snackbar")).toContainText("You're the only one who can open this trip");
  // Leaving for real would leave the trip behind on prod (the cleanup runs as me): local only from here.
  test.skip(remote, "the trip would stay on prod after I leave it");
  const ben = (await inPage(page, "GET", `/api/groups/${gid}`)).json.members[1].id;
  expect((await inPage(page, "PATCH", `/api/groups/${gid}/members/${ben}`, { email: `ben-${uniq()}@x.io` })).status).toBe(200);
  await addEqualBill(page, "Taxi", "300", "Ben");
  await openSettings(page);
  await page.getByTestId("leave-trip").click();
  await expect(page.locator("#snackbar")).toContainText("Settle up first: your balance here is");
  await addEqualBill(page, "Lunch", "300", "Ann"); // evens out: Ann paid 300, owes 150 + 150
  await openSettings(page);
  await page.getByTestId("leave-trip").click();
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#snackbar")).toContainText("You left");
  await expect(page.locator(`a[href="/g/${gid}"]`)).toHaveCount(0);
  expect((await inPage(page, "GET", `/api/groups/${gid}`)).status).toBe(403);
});

test("scan several receipts: each is read, reviewed in the bill dialog, and added", async ({ page }) => {
  test.skip(remote, "prod reads with the real model (cost, non-deterministic); locally the answer is canned (SCAN_FAKE)");
  await createGroup(page, `Scans ${uniq()}`, ["Ann", "Ben"], "THB");
  await page.getByTestId("group-more").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("scan-many").click();
  await (await chooser).setFiles([await receiptImage(page, "a.png"), await receiptImage(page, "b.png")]);
  await expect(page.getByTestId("scanq-dialog")).toHaveAttribute("data-ready", "1");
  await expect(page.locator('[data-testid=scanq-row][data-state=ready]')).toHaveCount(2);
  await expect(page.getByTestId("scanq-row").first()).toContainText("Som Tam Nua");
  await page.getByTestId("scanq-review").first().click();
  await expect(page.getByTestId("bill-dialog")).toHaveAttribute("data-ready", "1");
  await expect(page.getByTestId("bill-description").locator("input")).toHaveValue("Som Tam Nua");
  await expect(page.getByTestId("receipt-img")).toBeAttached();
  await page.getByTestId("bill-save").click();
  await expect(page.getByTestId("bill-dialog")).toHaveCount(0);
  await expect(page.locator('[data-testid=scanq-row][data-state=added]')).toHaveCount(1);
  await page.getByTestId("scanq-done").click();
  await expect(page.getByTestId("bill-item").filter({ hasText: "Som Tam Nua" })).toHaveCount(1);
  await expect(page.getByTestId("bill-item").filter({ hasText: "Som Tam Nua" })).toContainText("288.37");
});

test("home: search, sort by name, pin to the top (remembered)", async ({ page }) => {
  const tag = uniq();
  for (const n of ["Delta", "Alpha", "Echo", "Charlie", "Bravo"]) await createGroup(page, `${n} ${tag}`, ["Ann"]);
  // The server's list arrives late (as on prod): a search typed before it must survive the list being rebuilt.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/me/groups", async (route) => {
    await held;
    await route.fallback();
  });
  await page.goto("/");
  const rows = page.getByTestId("recent-groups").locator("md-list-item").filter({ hasText: tag });
  await expect(rows).toHaveCount(5); // this browser's recent list, before the server answers
  await fill(page, "trip-search", `echo ${tag}`);
  await expect(rows).toHaveCount(1);
  const arrived = page.waitForResponse((r) => r.url().endsWith("/api/me/groups"));
  release();
  await arrived;
  await expect(page.getByTestId("trip-search").locator("input")).toHaveValue(`echo ${tag}`);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Echo");
  await page.unroute("**/api/me/groups");
  await fill(page, "trip-search", "zzz-nothing");
  await expect(page.getByTestId("trip-search-none")).toBeVisible();
  await fill(page, "trip-search", tag);
  await page.getByTestId("trip-sort").click();
  await page.getByTestId("trip-sort").locator("md-select-option", { hasText: "Name" }).click();
  await expect(rows.first()).toContainText("Alpha");
  await rows.filter({ hasText: "Echo" }).getByTestId("trip-pin").click();
  await expect(rows.first()).toContainText("Echo");
  await expect(rows.filter({ hasText: "Echo" }).getByTestId("trip-pin")).toHaveAttribute("data-pinned", "1");
  await page.reload();
  await fill(page, "trip-search", tag);
  await expect(rows.first()).toContainText("Echo");
  await expect(rows.nth(1)).toContainText("Alpha"); // sort remembered too
});
