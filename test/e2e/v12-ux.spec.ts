import { test, expect } from "./fixtures";
import { addEqualBill, createGroup, showPanel, uniq } from "./helpers";
import type { Page } from "@playwright/test";

// v0.12.1 UI review: per-day chart upright, no sideways scrolling on narrow phones, each payment shown once,
// a short header off the Bills tab on phones, Add bill only on Bills, home balance under the trip name, wording.
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 960;
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test("spending per day: bars stand on the axis", async ({ page }) => {
  await createGroup(page, `Days ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Taxi", "100", "Ann");
  await addEqualBill(page, "Hotel", "900", "Ann");
  // Second day: change the date via the API from the page (same Access route as the app).
  await page.evaluate(async () => {
    const gid = location.pathname.split("/g/")[1];
    const full = await (await fetch(`/api/groups/${gid}/full`)).json();
    const b = full.bills.find((x: { description: string }) => x.description === "Taxi");
    const d = new Date(Date.parse(`${b.date}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
    await fetch(`/api/groups/${gid}/bills/${b.id}`, { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: b.description, amount: b.amount, paidBy: b.paidBy, date: d, category: b.category, split: b.split }) });
  });
  await page.reload();
  await expect(page.getByTestId("group-title")).toBeVisible();
  // Right after a reload the page can re-render under the first tap: retry until Summary is the tab.
  await expect(async () => {
    await showPanel(page, "summary");
    if (!wide(page)) await expect(page.getByTestId("tab-summary")).toHaveAttribute("active", "", { timeout: 1000 });
  }).toPass();
  const bars = page.getByTestId("day-bar");
  await expect(bars.first()).toBeVisible();
  const gaps = await bars.evaluateAll((cols) => cols.map((c) => {
    const fill = c.firstElementChild as HTMLElement;
    return fill.getBoundingClientRect().height ? Math.abs(c.getBoundingClientRect().bottom - fill.getBoundingClientRect().bottom) : 0;
  }));
  expect(Math.max(...gaps)).toBeLessThanOrEqual(1);
});

test("narrow phones: no sideways scrolling on an empty trip or a big balance", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await createGroup(page, `Narrow ${uniq()}`, ["Ann", "Ben", "Cat", "Dan"]);
  await expect(page.getByTestId("my-card")).toContainText("No bills yet");
  expect(await sideways(page)).toBeLessThanOrEqual(1);
  await addEqualBill(page, "Villa", "123456789", "Ann");
  await expect(page.getByTestId("my-net")).toBeVisible();
  expect(await sideways(page)).toBeLessThanOrEqual(1);
  await page.goto("/");
  await expect(page.getByTestId("recent-groups")).toBeVisible();
  expect(await sideways(page)).toBeLessThanOrEqual(1);
});

test("each payment shows once: header on phones' Bills tab (2 + more), Summary list otherwise", async ({ page }) => {
  await createGroup(page, `Once ${uniq()}`, ["Ann", "Ben", "Cat", "Dan"]); // I'm Ann
  await addEqualBill(page, "Villa", "400", "Ann"); // Ben, Cat and Dan each pay me 100
  const heroActions = page.getByTestId("hero-action").filter({ visible: true });
  if (wide(page)) {
    await expect(heroActions).toHaveCount(3);
    await expect(page.getByTestId("hero-more")).toBeHidden();
    // My three are in the header: the side list hides them and says so.
    await expect(page.getByTestId("settlement").filter({ visible: true })).toHaveCount(0);
    await expect(page.getByTestId("yours-above")).toBeVisible();
    return;
  }
  await expect(heroActions).toHaveCount(2);
  await page.getByTestId("hero-more").click();
  await expect(page.getByTestId("tab-summary")).toHaveAttribute("active", "");
  await expect(heroActions).toHaveCount(0); // Summary lists them itself
  await expect(page.getByTestId("settlement").filter({ visible: true })).toHaveCount(3);
  await expect(page.getByTestId("yours-above")).toBeHidden();
  // Add bill is a Bills-tab button on phones (it covered Settle here).
  await expect(page.getByTestId("add-bill").filter({ visible: true })).toHaveCount(0);
  // People / Activity: the short header — where I stand, nothing else.
  await showPanel(page, "members");
  await expect(page.getByTestId("my-net")).toBeVisible();
  await expect(page.getByTestId("budget").or(heroActions)).toHaveCount(0);
  await showPanel(page, "bills");
  await expect(page.getByTestId("add-bill").filter({ visible: true })).toHaveCount(1);
});

test("wording: 'You paid … your share', home balance under the trip name", async ({ page }) => {
  const name = `Words ${uniq()}`;
  await createGroup(page, name, ["Ann", "Ben"]);
  await addEqualBill(page, "Taxi", "100", "Ann");
  await expect(page.getByTestId("my-card")).toContainText(/You paid .*100\.00 · your share .*50\.00/);
  await page.getByTestId("nav-home").click();
  const row = page.getByTestId("recent-groups").locator("md-list-item").filter({ hasText: name });
  await expect(row.locator("[slot=supporting-text] [data-testid=trip-net]")).toHaveText(/You get .*50\.00/);
});
