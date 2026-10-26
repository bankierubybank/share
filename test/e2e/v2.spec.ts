import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { addEqualBill, createGroup, fill, field, openAddBill, pickOption, saveBill, showPanel, uniq } from "./helpers";

// v0.2 features (#1–15, 17, 20, 21, 23). Runs on every project in playwright.config.ts.

const settlementsText = async (page: Page) => {
  await showPanel(page, "summary");
  return page.getByTestId("settlements").innerText();
};

async function openMenuItem(page: Page, testid: string) {
  await page.getByTestId("group-more").click();
  await page.waitForFunction(() => (document.querySelector("[data-testid=group-menu]") as HTMLElement & { open: boolean })?.open);
  await page.getByTestId(testid).click();
}

test("quick add: amount first, remembers last payer (#17)", async ({ page }) => {
  await createGroup(page, `Quick ${uniq()}`, ["Ann", "Ben"]);
  await openAddBill(page);
  await page.keyboard.type("120"); // amount field has focus on open
  await expect(field(page, "bill-amount")).toHaveValue("120");
  await fill(page, "bill-description", "Coffee");
  await pickOption(page, "bill-paid-by", "Ben");
  await saveBill(page);
  await openAddBill(page);
  await expect(page.getByTestId("bill-paid-by")).toContainText("Ben");
});

test("shares split with stepper (#2)", async ({ page }) => {
  await createGroup(page, `Shares ${uniq()}`, ["Ann", "Ben"]);
  await openAddBill(page);
  await fill(page, "bill-amount", "300");
  await fill(page, "bill-description", "Room");
  await page.getByTestId("mode-shares").click();
  await page.getByTestId("weight-inc-Ann").click(); // Ann 2, Ben 1
  await expect(page.getByTestId("share-Ann")).toContainText("200.00");
  await expect(page.getByTestId("share-Ben")).toContainText("100.00");
  await saveBill(page);
  expect(await settlementsText(page)).toMatch(/Ben pays Ann[\s\S]*100\.00/);
});

test("percent split must total 100% (#2)", async ({ page }) => {
  await createGroup(page, `Pct ${uniq()}`, ["Ann", "Ben"]);
  await openAddBill(page);
  await fill(page, "bill-amount", "200");
  await fill(page, "bill-description", "Fuel");
  await page.getByTestId("mode-percent").click();
  await fill(page, "split-pct-Ann", "70");
  await expect(page.getByTestId("split-status")).toContainText("100%");
  await fill(page, "split-pct-Ben", "30");
  await expect(page.getByTestId("share-Ben")).toContainText("60.00");
  await saveBill(page);
});

test("itemized bill with service + VAT computes the total (#4)", async ({ page }) => {
  await createGroup(page, `Items ${uniq()}`, ["Ann", "Ben"]);
  await openAddBill(page);
  await fill(page, "bill-description", "Dinner");
  await page.getByTestId("mode-itemized").click();
  await fill(page, "item-desc-0", "Crab");
  await fill(page, "item-amount-0", "1000");
  await page.getByTestId("item-0-Ben").click(); // only Ann had crab
  await page.getByTestId("item-add").click();
  await fill(page, "item-desc-1", "Rice");
  await fill(page, "item-amount-1", "100");
  await fill(page, "item-service", "10");
  await fill(page, "item-tax", "7");
  // 1100 × 1.1 × 1.07 = 1294.70; Ann 1050/1100 → 1235.85, Ben 50/1100 → 58.85
  await expect(field(page, "bill-amount")).toHaveValue("1294.70");
  await expect(page.getByTestId("share-Ann")).toContainText("1,235.85");
  await expect(page.getByTestId("share-Ben")).toContainText("58.85");
  await saveBill(page);
  await expect(page.getByTestId("bill-item").first()).toContainText("1,294.70");
});

test("foreign currency converts to group currency (#5)", async ({ page }) => {
  await createGroup(page, `Fx ${uniq()}`, ["Ann", "Ben"], "THB");
  await openAddBill(page);
  await page.getByTestId("fx-toggle").click();
  await pickOption(page, "fx-currency", "USD");
  await fill(page, "fx-amount", "10.50");
  await fill(page, "fx-rate", "36.25");
  await expect(page.getByTestId("fx-result")).toContainText("380.63");
  await fill(page, "bill-description", "Taxi");
  await saveBill(page);
  await expect(page.getByTestId("bill-item").first()).toContainText("@ 36.25");
});

test("several payers (#3)", async ({ page }) => {
  await createGroup(page, `Payers ${uniq()}`, ["Ann", "Ben", "Cat"]);
  await openAddBill(page);
  await fill(page, "bill-amount", "900");
  await fill(page, "bill-description", "Villa");
  await page.getByTestId("multi-payer-toggle").click();
  await fill(page, "payer-Ann", "600");
  await fill(page, "payer-Ben", "200");
  await page.getByTestId("bill-save").click();
  await expect(page.getByTestId("bill-dialog")).toContainText("Payers add up to");
  await fill(page, "payer-Ben", "300");
  await saveBill(page);
  expect(await settlementsText(page)).toMatch(/Cat pays Ann[\s\S]*300\.00/);
});

test("categories, chart, search and filter (#7, #9)", async ({ page }) => {
  await createGroup(page, `Cats ${uniq()}`, ["Ann", "Ben"]);
  await openAddBill(page);
  await fill(page, "bill-amount", "50");
  await fill(page, "bill-description", "Pad thai");
  await page.getByTestId("cat-food").click();
  await saveBill(page);
  await openAddBill(page);
  await fill(page, "bill-amount", "30");
  await fill(page, "bill-description", "Bus");
  await page.getByTestId("cat-transport").click();
  await saveBill(page);
  await fill(page, "bill-search", "pad");
  await expect(page.getByTestId("bill-item")).toHaveCount(1);
  await fill(page, "bill-search", "");
  await page.getByTestId("filter-cat-transport").click();
  await expect(page.getByTestId("bill-item")).toHaveCount(1);
  await expect(page.getByTestId("bill-item").first()).toContainText("Bus");
  await showPanel(page, "summary");
  await expect(page.getByTestId("cat-bar-food")).toContainText("63%");
  await expect(page.getByTestId("cat-bar-transport")).toContainText("38%");
});

test("view as a person (#8)", async ({ page }) => {
  await createGroup(page, `View ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Lunch", "100", "Ann");
  await pickOption(page, "view-as", "Ben");
  await expect(page.getByTestId("bill-my-share").first()).toContainText("50.00");
  await showPanel(page, "summary");
  await expect(page.getByTestId("my-card")).toContainText("Owes");
  await expect(page.getByTestId("my-card")).toContainText("Pay Ann");
});

test("undo delete + activity log + restore (#11, #12)", async ({ page }) => {
  await createGroup(page, `Undo ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Snacks", "40", "Ann");
  await page.getByTestId("bill-item").first().click();
  await page.getByTestId("bill-delete").click();
  await page.getByTestId("confirm-ok").click();
  await page.locator("#snackbar md-text-button", { hasText: "Undo" }).click();
  await expect(page.getByTestId("bill-item")).toHaveCount(1);

  await page.getByTestId("bill-item").first().click();
  await page.getByTestId("bill-delete").click();
  await page.getByTestId("confirm-ok").click();
  await showPanel(page, "activity");
  await expect(page.getByTestId("activity-list")).toContainText("Deleted “Snacks”");
  await expect(page.getByTestId("activity-list")).toContainText("Restored “Snacks”");
  await page.getByTestId("activity-restore").first().click();
  await showPanel(page, "bills");
  await expect(page.getByTestId("bill-item")).toHaveCount(1);
});

test("archive makes the group read-only; unarchive (#1)", async ({ page }) => {
  await createGroup(page, `Arch ${uniq()}`, ["Ann", "Ben"]);
  await openMenuItem(page, "group-settings");
  await page.getByTestId("archive-group").click();
  await expect(page.getByTestId("archived-banner")).toBeVisible();
  await expect(page.getByTestId("add-bill").filter({ visible: true }).filter({ hasNot: page.locator("[disabled]") })).toHaveCount(0);
  await page.getByTestId("banner-unarchive").click();
  await expect(page.getByTestId("archived-banner")).toHaveCount(0);
});

test("delete group requires typing its name (#1)", async ({ page }) => {
  const name = `Del ${uniq()}`;
  await createGroup(page, name, ["Ann"]);
  await openMenuItem(page, "group-settings");
  await page.getByTestId("delete-group").click();
  await expect(page.getByTestId("delete-confirm")).toHaveAttribute("disabled", "");
  await fill(page, "delete-confirm-input", name);
  await page.getByTestId("delete-confirm").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("group-name")).toBeVisible(); // home
  await expect(page.locator("main")).not.toContainText(name);
});

test("PromptPay QR when settling in THB (#13)", async ({ page }) => {
  await createGroup(page, `PP ${uniq()}`, ["Ann", "Ben"], "THB");
  await showPanel(page, "members");
  await page.getByTestId("edit-member-Ann").click();
  await fill(page, "member-promptpay-input", "081-234-5678");
  await page.getByTestId("member-save").click();
  await expect(page.getByTestId("members-list")).toContainText("PromptPay");
  await showPanel(page, "bills");
  await addEqualBill(page, "Hotel", "1000", "Ann");
  await showPanel(page, "summary");
  await page.getByTestId("settle-btn").click();
  const qr = page.getByTestId("qr-box");
  await expect(qr).toBeVisible();
  await expect(qr).toHaveAttribute("data-payload", /0066812345678.*5406500\.00/);
  await expect(page.getByTestId("qr-canvas")).toBeVisible();
});

test("receipt photo upload and view (#6)", async ({ page }) => {
  await createGroup(page, `Rcpt ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Market", "80", "Ann");
  await page.getByTestId("bill-item").first().click();
  await page.locator("details.more > summary").click();
  // 8×8 red PNG
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC",
    "base64",
  );
  await page.getByTestId("receipt-input").setInputFiles({ name: "r.png", mimeType: "image/png", buffer: png });
  await expect(page.getByTestId("receipt-img")).toBeVisible();
  await saveBill(page);
  await expect(page.getByTestId("bill-item").first()).toContainText("receipt");
  await page.getByTestId("bill-item").first().click();
  await page.locator("details.more > summary").click();
  const img = page.getByTestId("receipt-img");
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
});

test("repeating monthly bill backfills past months (#14)", async ({ page }) => {
  await createGroup(page, `Rent ${uniq()}`, ["Ann", "Ben"]);
  await openAddBill(page);
  await fill(page, "bill-amount", "5000");
  await fill(page, "bill-description", "Rent");
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - 2);
  d.setUTCDate(1);
  await fill(page, "bill-date", d.toISOString().slice(0, 10));
  await page.locator("details.more > summary").click();
  await pickOption(page, "bill-repeat", "Every month");
  await saveBill(page);
  await expect(page.getByTestId("bill-item")).toHaveCount(3);
  await expect(page.getByTestId("recurring-chip")).toContainText("1 repeating");
  await page.getByTestId("recurring-chip").click();
  await page.getByTestId("recurring-stop").click();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("recurring-chip")).toHaveCount(0);
});

test("CSV export and print (#10)", async ({ page }) => {
  await createGroup(page, `Csv ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "=SUM(A1)", "10", "Ann");
  // Capture the generated file at the Blob boundary (download events are unreliable with request routing).
  await page.evaluate(() => {
    const w = window as unknown as { csv?: { blob: Blob; name: string } };
    const orig = HTMLAnchorElement.prototype.click;
    const create = URL.createObjectURL;
    let last: Blob | null = null;
    URL.createObjectURL = (b: Blob | MediaSource) => ((last = b as Blob), create.call(URL, b));
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.download && last) w.csv = { blob: last, name: this.download };
      return orig.call(this);
    };
  });
  await openMenuItem(page, "export-csv");
  await page.waitForFunction(() => !!(window as unknown as { csv?: unknown }).csv);
  const { name, text } = await page.evaluate(async () => {
    const c = (window as unknown as { csv: { blob: Blob; name: string } }).csv;
    return { name: c.name, text: await c.blob.text() };
  });
  expect(name).toMatch(/^Csv-.*\.csv$/);
  expect(text).toContain("'=SUM(A1)"); // formula-injection guard
  await page.evaluate(() => (window.print = () => ((window as unknown as { printed: boolean }).printed = true)));
  await openMenuItem(page, "export-print");
  expect(await page.evaluate(() => (window as unknown as { printed?: boolean }).printed)).toBe(true);
});

test("theme toggle persists (#20)", async ({ page }) => {
  await page.goto("/");
  const t = page.getByTestId("theme-toggle");
  await t.click(); // system → light
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await t.click(); // → dark
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(15, 21, 19)");
});

test("no third-party requests: fonts and icons are self-hosted (#23)", async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const foreign: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.protocol.startsWith("http") && u.origin !== origin) foreign.push(r.url());
  });
  await createGroup(page, `Fonts ${uniq()}`, ["Ann"]);
  await page.waitForLoadState("networkidle");
  expect(foreign).toEqual([]);
  expect(await page.evaluate(() => document.fonts.check("16px Roboto"))).toBe(true);
});

for (const [name, setup] of [
  ["home", async (_page: Page) => {}],
  ["group", async (page: Page) => { await createGroup(page, `A11y ${uniq()}`, ["Ann", "Ben"]); await addEqualBill(page, "Tea", "20", "Ann"); }],
  ["bill dialog", async (page: Page) => { await createGroup(page, `A11y ${uniq()}`, ["Ann", "Ben"]); await openAddBill(page); }],
] as const) {
  test(`accessibility: no serious/critical axe violations on ${name} (#21)`, async ({ page }) => {
    await page.goto("/");
    await setup(page);
    let axe = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]);
    // With a modal open, the page behind the scrim is inert; axe would score its dimmed text against the scrim.
    if (name === "bill dialog") axe = axe.exclude("main").exclude(".top-app-bar").exclude("md-tabs");
    const r = await axe.analyze();
    const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`)).toEqual([]);
  });
}
