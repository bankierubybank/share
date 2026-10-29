import { test, expect } from "./fixtures";
import { addEqualBill, createGroup, fill, openAddBill, pickOption, saveBill, settled, showPanel, uniq } from "./helpers";
import type { Page } from "@playwright/test";

// v0.11: receipt scan (#2, canned locally via SCAN_FAKE), trip dates + per-day chart (#7), offline edits/deletes (#8),
// email suggestions (#9), keyboard shortcuts (#11), a trip's own categories (#12), notifications section (#6).
const remote = !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.TARGET_URL ?? "http://localhost:8787");

async function openSettings(page: Page) {
  await page.getByTestId("group-more").click();
  await page.getByTestId("group-settings").click();
  await expect(page.getByTestId("settings-dialog")).toHaveAttribute("data-ready", "1");
}

/** A real, decodable image (the dialog downsizes it before upload). */
async function receiptImage(page: Page) {
  return { name: "receipt.png", mimeType: "image/png", buffer: await page.screenshot({ clip: { x: 0, y: 0, width: 200, height: 300 } }) };
}

test("keyboard: N adds a bill, ? lists shortcuts, keys typed in fields are just text", async ({ page }) => {
  await createGroup(page, `Keys ${uniq()}`, ["Ann", "Ben"]);
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcuts-dialog")).toHaveAttribute("data-ready", "1");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shortcuts-dialog")).toHaveCount(0);
  await page.keyboard.press("n");
  await expect(page.getByTestId("bill-dialog")).toHaveAttribute("data-ready", "1");
  await page.getByTestId("bill-description").locator("input").pressSequentially("nasi");
  await expect(page.getByTestId("bill-description").locator("input")).toHaveValue("nasi");
  await expect(page.getByTestId("bill-dialog")).toHaveCount(1); // "n" inside the field didn't open another
});

test("scan a receipt: fills description, date, items and attaches the photo", async ({ page }) => {
  test.skip(remote, "prod reads with the real model (cost, non-deterministic); locally the answer is canned (SCAN_FAKE)");
  await createGroup(page, `Scan ${uniq()}`, ["Ann", "Ben"], "THB");
  await openAddBill(page);
  await page.getByTestId("scan-input").setInputFiles(await receiptImage(page));
  await expect(page.locator("#snackbar")).toContainText("Filled in from the receipt");
  await expect(page.getByTestId("bill-description").locator("input")).toHaveValue("Som Tam Nua");
  await expect(page.getByTestId("bill-date").locator("input")).toHaveValue("2026-10-28");
  await expect(page.getByTestId("mode-itemized")).toHaveAttribute("selected", "");
  await expect(page.getByTestId("receipt-img")).toBeAttached(); // in the collapsed "More" section
  await saveBill(page);
  const row = page.getByTestId("bill-item").filter({ hasText: "Som Tam Nua" });
  await expect(row).toContainText("245.00");
  await expect(row).toContainText(/receipt/i);
});

test("trip categories: make one from the bill dialog, use it, filter by it", async ({ page }) => {
  await createGroup(page, `Cats ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Bus", "100", "Ann");
  await openAddBill(page);
  await fill(page, "bill-amount", "300");
  await fill(page, "bill-description", "Snorkel trip");
  await page.getByTestId("cat-new").click();
  await expect(page.getByTestId("category-dialog")).toHaveAttribute("data-ready", "1");
  await fill(page, "cat-name", "Diving");
  await page.getByTestId("cat-icon-beach_access").click();
  await page.getByTestId("cat-save").click();
  await expect(page.getByTestId("category-dialog")).toHaveCount(0);
  await expect(page.getByTestId("cat-custom")).toHaveAttribute("selected", "");
  await saveBill(page);
  await expect(page.getByTestId("bill-item").filter({ hasText: "Snorkel trip" }).locator(".avatar")).toHaveAttribute("title", "Diving");
  await page.locator("md-filter-chip[data-testid^='filter-cat-c:']").click();
  await expect(page.getByTestId("bill-item")).toHaveCount(1);
  // Settings lists it.
  await openSettings(page);
  await expect(page.getByTestId("settings-cat")).toHaveJSProperty("label", "Diving");
});

test("trip dates: shown in the header, spending per day, budget pace", async ({ page }) => {
  await createGroup(page, `Dates ${uniq()}`, ["Ann", "Ben"], "THB");
  const d = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  await openSettings(page);
  await fill(page, "edit-group-budget", "1000");
  await fill(page, "edit-group-start", d(-2));
  await fill(page, "edit-group-end", d(3));
  await page.getByTestId("edit-group-save").click();
  await expect(page.getByTestId("trip-dates")).toBeVisible();
  await addEqualBill(page, "Hotel", "400", "Ann");
  await expect(page.getByTestId("budget-pace")).toContainText("a day for the");
  await showPanel(page, "summary");
  await expect(page.getByTestId("day-chart")).toBeVisible();
  expect(await page.getByTestId("day-bar").count()).toBeGreaterThanOrEqual(6); // first → last trip day
  // Last day before the first is refused.
  await openSettings(page);
  await fill(page, "edit-group-end", d(-5));
  await page.getByTestId("edit-group-save").click();
  await expect(page.getByTestId("settings-dialog")).toHaveCount(1);
});

test("offline: an edit and a delete wait on the device, then sync", async ({ page, context }) => {
  await page.addInitScript(() => localStorage.setItem("share.pollMs", "1000"));
  await createGroup(page, `OffEdit ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Taxi", "100", "Ann");
  await addEqualBill(page, "Snacks", "40", "Ben");
  await context.setOffline(true);
  // Edit Taxi → 160
  await page.getByTestId("bill-item").filter({ hasText: "Taxi" }).click();
  await expect(page.getByTestId("bill-dialog")).toHaveAttribute("data-ready", "1");
  await fill(page, "bill-amount", "160");
  await page.getByTestId("bill-save").click();
  await expect(page.getByTestId("bill-item").filter({ hasText: "Taxi" }).getByTestId("bill-queued")).toBeVisible();
  // Delete Snacks
  await page.getByTestId("bill-item").filter({ hasText: "Snacks" }).click();
  await expect(page.getByTestId("bill-dialog")).toHaveAttribute("data-ready", "1");
  await page.getByTestId("bill-delete").click();
  await expect(page.getByTestId("bill-item").filter({ hasText: "Snacks" })).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.locator("[data-queued]")).toHaveCount(0, { timeout: remote ? 60_000 : 15_000 });
  await settled(page);
  await page.reload();
  await expect(page.getByTestId("bill-item")).toHaveCount(1);
  await expect(page.getByTestId("bill-item").first()).toContainText("160.00");
});

test("adding a person suggests people from my other trips", async ({ page }) => {
  const email = `pal-${uniq()}@example.com`;
  const gid = await createGroup(page, `Pals ${uniq()}`, ["Ann", "Pal"]);
  await showPanel(page, "members");
  await page.getByTestId("edit-member-Pal").click();
  await fill(page, "member-email-input", email);
  await page.getByTestId("member-save").click();
  await expect(page.getByTestId("members-list")).toContainText(email);
  await createGroup(page, `Pals2 ${uniq()}`, ["Ann"]);
  await showPanel(page, "members");
  await page.getByTestId("add-member-btn").click();
  await fill(page, "member-name-input", "Pal");
  await fill(page, "member-email-input", email.slice(0, 12));
  await page.getByTestId("contact-suggestion").filter({ hasText: email }).click();
  await expect(page.getByTestId("member-email-input").locator("input")).toHaveValue(email);
  expect(gid).toBeTruthy();
});

test("Settings shows the notifications switch", async ({ page }) => {
  await createGroup(page, `Push ${uniq()}`, ["Ann"]);
  await openSettings(page);
  await expect(page.getByTestId("push-toggle")).toBeVisible();
});
