import type { Page } from "@playwright/test";
import { expect } from "./fixtures";

export const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const field = (page: Page, testid: string) => page.getByTestId(testid).filter({ visible: true }).first().locator("input, textarea");

export async function fill(page: Page, testid: string, value: string) {
  await field(page, testid).fill(value);
}

/** FAB on phones, header button on laptops — both carry testid "add-bill"; click the visible one. */
export const addBillBtn = (page: Page) => page.getByTestId("add-bill").filter({ visible: true }).first();

export async function createGroup(page: Page, name: string, people: string[], currency?: string) {
  await page.goto("/");
  await fill(page, "group-name", name);
  if (currency) await pickOption(page, "group-currency", currency);
  for (const p of people) {
    await fill(page, "member-input", p);
    await field(page, "member-input").press("Enter");
  }
  await page.getByTestId("create-group").click();
  await expect(page).toHaveURL(/\/g\/[A-Za-z0-9_-]{22}$/);
  await expect(page.getByTestId("group-title")).toHaveText(name);
  return page.url().split("/g/")[1];
}

/** On phones panels are tabs; on laptops all panels are visible. */
export async function showPanel(page: Page, tab: "bills" | "summary" | "members" | "activity") {
  const t = page.getByTestId(`tab-${tab}`);
  if (await t.isVisible()) await t.click();
}

export async function pickOption(page: Page, selectTestId: string, label: string) {
  const select = page.getByTestId(selectTestId).filter({ visible: true }).first();
  await select.click();
  await select.locator("md-select-option", { hasText: label }).first().click();
}

export async function openAddBill(page: Page) {
  await addBillBtn(page).click();
  await expect(page.getByTestId("bill-dialog")).toHaveAttribute("data-ready", "1");
}

/** Saves are optimistic (v0.5): the dialog closes at once; wait until the server has it and the page re-rendered. */
export async function saveBill(page: Page) {
  await page.getByTestId("bill-save").click();
  await expect(page.getByTestId("bill-dialog")).toHaveCount(0);
  await settled(page);
}

/** No bill row is still "Saving…" (and the re-render with the server's data happened). */
export async function settled(page: Page) {
  await expect(page.locator("[data-saving]")).toHaveCount(0);
}

export async function addEqualBill(page: Page, desc: string, amount: string, paidBy: string) {
  await openAddBill(page);
  await fill(page, "bill-amount", amount);
  await fill(page, "bill-description", desc);
  await pickOption(page, "bill-paid-by", paidBy);
  await saveBill(page);
  // The page re-renders after save (replacing controls); wait for it before the next interaction.
  await expect(page.getByTestId("bill-item").filter({ hasText: desc }).first()).toBeAttached();
}
