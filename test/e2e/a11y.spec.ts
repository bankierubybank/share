import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { addEqualBill, createGroup, showPanel, uniq } from "./helpers";

// v0.11 accessibility pass (#13): every page and dialog, not just home / trip / bill dialog (test/e2e/v2.spec.ts).
// Serious and critical WCAG 2.1 AA findings fail the test. With a modal open the page behind it is inert (axe would
// score dimmed text against the scrim), so only the dialog is checked then.

async function trip(page: Page) {
  const gid = await createGroup(page, `A11y ${uniq()}`, ["Ann", "Ben"], "THB");
  await addEqualBill(page, "Tea", "120", "Ann");
  return gid;
}
const menu = async (page: Page, item: string) => {
  await page.getByTestId("group-more").click();
  await page.getByTestId(item).click();
};
/** Through the page (so prod's per-origin Access route applies — page.request would skip it). */
const binTrip = (page: Page, gid: string) => page.evaluate((g) => fetch(`/api/groups/${g}`, { method: "DELETE" }).then((r) => r.status), gid);
const dialog = async (page: Page, testid: string) => expect(page.getByTestId(testid)).toHaveAttribute("data-ready", "1");

const cases: [string, (page: Page) => Promise<void>, string?][] = [
  ["trip summary", async (page) => { await trip(page); await showPanel(page, "summary"); }],
  ["trip people + activity", async (page) => { await trip(page); await showPanel(page, "members"); }],
  ["settings dialog", async (page) => { await trip(page); await menu(page, "group-settings"); await dialog(page, "settings-dialog"); }, "settings-dialog"],
  ["shortcuts dialog", async (page) => { await trip(page); await menu(page, "shortcuts-help"); await dialog(page, "shortcuts-dialog"); }, "shortcuts-dialog"],
  ["summary image dialog", async (page) => { await trip(page); await menu(page, "export-image"); await dialog(page, "image-dialog"); }, "image-dialog"],
  ["person dialog", async (page) => { await trip(page); await showPanel(page, "members"); await page.getByTestId("add-member-btn").click(); await dialog(page, "member-dialog"); }, "member-dialog"],
  ["category dialog", async (page) => {
    await trip(page);
    await page.getByTestId("add-bill").filter({ visible: true }).first().click();
    await dialog(page, "bill-dialog");
    await page.getByTestId("cat-new").click();
    await dialog(page, "category-dialog");
  }, "category-dialog"],
  ["view link page", async (page) => {
    await trip(page);
    await menu(page, "group-settings");
    await dialog(page, "settings-dialog");
    await page.getByTestId("view-link-create").click();
    const url = await page.getByTestId("view-link-url").textContent();
    await page.goto(new URL(url!.trim()).pathname);
    await expect(page.getByTestId("view-banner")).toBeVisible();
  }],
  ["deleted trip page + bin", async (page) => {
    const gid = await trip(page);
    await binTrip(page, gid);
    await page.goto(`/g/${gid}`);
    await expect(page.getByTestId("trip-deleted")).toBeVisible();
  }],
  ["home with the bin", async (page) => {
    const gid = await trip(page);
    await binTrip(page, gid);
    await page.goto("/");
    await expect(page.getByTestId("bin-card")).toBeVisible();
  }],
];

for (const [name, setup, only] of cases) {
  test(`accessibility: no serious/critical axe violations — ${name} (#13)`, async ({ page }) => {
    await setup(page);
    let axe = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]);
    if (only) axe = axe.include(`[data-testid="${only}"]`);
    const r = await axe.analyze();
    const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`)).toEqual([]);
  });
}
