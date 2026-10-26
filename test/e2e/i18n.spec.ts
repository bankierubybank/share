import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createGroup, fill, openAddBill, pickOption, saveBill, showPanel, uniq } from "./helpers";

// Thai / English UI. Each Playwright test gets a fresh browser context (empty localStorage), so the saved
// "share.lang" never leaks into other specs; the afterEach below is belt and braces.
test.afterEach(async ({ page }) => {
  await page.evaluate(() => localStorage.removeItem("share.lang")).catch(() => undefined);
});

async function openMenuItem(page: Page, testid: string) {
  await page.getByTestId("group-more").click();
  await page.waitForFunction(() => (document.querySelector("[data-testid=group-menu]") as HTMLElement & { open: boolean })?.open);
  await page.getByTestId(testid).click();
}

test("switch to Thai and back; amounts stay formatted", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("create-group")).toContainText("Create group");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByTestId("lang-toggle-home")).toContainText("ภาษาไทย");

  // Home: English -> Thai without a reload.
  await page.getByTestId("lang-toggle-home").click();
  await expect(page.getByTestId("create-group")).toContainText("สร้างกลุ่ม");
  await expect(page.locator("html")).toHaveAttribute("lang", "th");
  await expect(page.getByTestId("lang-toggle-home")).toContainText("English");
  await expect(page.getByTestId("group-name").filter({ visible: true }).first()).toHaveJSProperty("label", "ชื่อกลุ่ม");

  // The choice survives navigation (createGroup does a fresh page.goto).
  const name = `Lang ${uniq()}`;
  await createGroup(page, name, ["Ann", "Ben"]);
  await expect(page.getByTestId("group-title")).toHaveText(name); // user data is never translated
  await expect(page.getByTestId("tab-bills")).toContainText("บิล");
  await expect(page.getByTestId("tab-summary")).toContainText("สรุป");
  await expect(page.getByTestId("tab-members")).toContainText("สมาชิก");
  await expect(page.getByTestId("tab-activity")).toContainText("กิจกรรม");
  await expect(page.getByTestId("tips")).toContainText("เคล็ดลับ");

  // Add bill dialog in Thai.
  await openAddBill(page);
  await expect(page.getByTestId("bill-dialog")).toContainText("เพิ่มบิล");
  await fill(page, "bill-amount", "300");
  await fill(page, "bill-description", "Dinner");
  await pickOption(page, "bill-paid-by", "Ann");
  await expect(page.getByTestId("split-status")).toContainText("2 คน");
  await expect(page.getByTestId("split-status")).toContainText("300.00");
  await saveBill(page);
  await expect(page.getByTestId("bill-item").filter({ hasText: "Dinner" }).first()).toContainText("จ่าย");

  // Dates use the Thai (Buddhist) calendar; amounts keep decimals.
  await showPanel(page, "bills");
  await expect(page.getByTestId("bills-list")).toContainText(String(new Date().getFullYear() + 543));
  await expect(page.getByTestId("total-spent")).toContainText("300.00");

  // Summary
  await showPanel(page, "summary");
  await expect(page.locator("#pays-title")).toHaveText("ใครต้องจ่ายใคร");
  await expect(page.getByTestId("settlements")).toContainText("Ben จ่ายให้ Ann");
  await expect(page.getByTestId("settlements")).toContainText("150.00");
  await expect(page.getByTestId("settle-btn")).toContainText("ชำระ");
  await expect(page.getByTestId("balance-detail").first()).toContainText("จ่ายแล้ว");

  // Group menu shows the OTHER language; switching re-renders the route in place.
  await page.getByTestId("group-more").click();
  await page.waitForFunction(() => (document.querySelector("[data-testid=group-menu]") as HTMLElement & { open: boolean })?.open);
  await expect(page.getByTestId("lang-toggle")).toContainText("English");
  await page.getByTestId("lang-toggle").click();

  await expect(page.getByTestId("tab-summary")).toContainText("Summary");
  await expect(page.getByTestId("tab-bills")).toContainText("Bills");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await showPanel(page, "summary");
  await expect(page.locator("#pays-title")).toHaveText("Who pays whom");
  await expect(page.getByTestId("settlements")).toContainText("Ben pays Ann");
  await expect(page.getByTestId("settlements")).toContainText("150.00");

  // ...and the menu offers Thai again.
  await page.getByTestId("group-more").click();
  await page.waitForFunction(() => (document.querySelector("[data-testid=group-menu]") as HTMLElement & { open: boolean })?.open);
  await expect(page.getByTestId("lang-toggle")).toContainText("ภาษาไทย");
});

test("group menu toggle switches to Thai", async ({ page }) => {
  await createGroup(page, `Menu ${uniq()}`, ["Ann", "Ben"]);
  await expect(page.getByTestId("tab-summary")).toContainText("Summary");
  await openMenuItem(page, "lang-toggle");
  await expect(page.getByTestId("tab-summary")).toContainText("สรุป");
  await showPanel(page, "summary");
  await expect(page.locator("#pays-title")).toHaveText("ใครต้องจ่ายใคร");
  await expect(page.getByTestId("all-settled")).toContainText("ชำระครบแล้ว");
});

test("English is the default for an English browser", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("create-group")).toContainText("Create group");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test.describe("Thai browser", () => {
  test.use({ locale: "th-TH" });

  test("fresh visit defaults to Thai; an explicit choice wins", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("create-group")).toContainText("สร้างกลุ่ม");
    await expect(page.locator("html")).toHaveAttribute("lang", "th");
    await expect(page.getByTestId("lang-toggle-home")).toContainText("English");

    await page.getByTestId("lang-toggle-home").click();
    await expect(page.getByTestId("create-group")).toContainText("Create group");
    await page.reload();
    await expect(page.getByTestId("create-group")).toContainText("Create group");
  });
});
