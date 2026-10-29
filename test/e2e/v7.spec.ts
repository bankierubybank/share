import { test, expect } from "./fixtures";
import { addEqualBill, createGroup, fill, openAddBill, pickOption, saveBill, showPanel, uniq } from "./helpers";

// v0.7 UI revamp: the trip header says where you stand on every tab; home lists your trips first.

test("trip header: what I get back / owe, with Settle, on every tab", async ({ page }) => {
  await createGroup(page, `Hero ${uniq()}`, ["Ann", "Ben"]); // I'm Ann
  const hero = page.getByTestId("my-card");
  await expect(hero).toContainText("No bills yet");

  await addEqualBill(page, "Dinner", "100", "Ann");
  await expect(page.getByTestId("my-net")).toHaveText(/You get back .*50\.00/);
  await expect(page.getByTestId("hero-action")).toContainText(/Ben pays you .*50\.00/);
  await expect(hero).toContainText(/1 bill · 2 people/);
  for (const tab of ["summary", "members", "activity"] as const) {
    await showPanel(page, tab);
    await expect(page.getByTestId("my-net")).toBeVisible();
  }

  // Settle from the header records the payment and clears the position.
  await page.getByTestId("hero-settle").click();
  await expect(page.getByTestId("bill-dialog")).toHaveAttribute("data-ready", "1");
  await saveBill(page);
  await expect(page.getByTestId("my-net")).toHaveText("You're all settled up");
  await expect(page.getByTestId("hero-action")).toHaveCount(0);
});

test("trip header follows View as", async ({ page }) => {
  await createGroup(page, `HeroAs ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Taxi", "80", "Ann");
  await expect(page.getByTestId("my-net")).toHaveText(/You get back/);
  await pickOption(page, "view-as", "Ben");
  await expect(page.getByTestId("my-net")).toHaveText(/Owes .*40\.00/);
  await expect(page.getByTestId("hero-action")).toContainText(/Pay Ann .*40\.00/);
});

test("a fresh Add bill doesn't open with a red error", async ({ page }) => {
  await createGroup(page, `Fresh ${uniq()}`, ["Ann", "Ben"]);
  await openAddBill(page);
  await expect(page.getByTestId("split-status")).not.toHaveClass(/error/);
  await fill(page, "bill-amount", "abc");
  await expect(page.getByTestId("split-status")).toHaveClass(/error/);
});

test("home: returning users see their trips before the new-trip form", async ({ page }) => {
  const name = `Back ${uniq()}`;
  await createGroup(page, name, ["Ann"]);
  await page.getByTestId("nav-home").click();
  await expect(page.getByTestId("trip-mine").filter({ hasText: name })).toBeVisible();
  // DOM order = reading order (phones stack it; laptops put it in the left column).
  const first = await page.locator(".home-grid > *").first().getAttribute("class");
  expect(first).not.toContain("new-trip");
});
