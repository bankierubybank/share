import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// UI flows. Runs on every project in playwright.config.ts (desktop + phone = compatibility matrix).

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function fill(page: Page, testid: string, value: string) {
  const input = page.getByTestId(testid).locator("input");
  await input.fill(value);
}

/** FAB on phones, header button on laptops — both carry testid "add-bill"; click the visible one. */
const addBillBtn = (page: Page) => page.getByTestId("add-bill").filter({ visible: true }).first();

async function createGroup(page: Page, name: string, people: string[]) {
  await page.goto("/");
  await fill(page, "group-name", name);
  for (const p of people) {
    await fill(page, "member-input", p);
    await page.getByTestId("member-input").locator("input").press("Enter");
  }
  await expect(page.getByTestId("member-chips").locator("md-input-chip")).toHaveCount(people.length);
  await page.getByTestId("create-group").click();
  await expect(page).toHaveURL(/\/g\/[A-Za-z0-9_-]{22}$/);
  await expect(page.getByTestId("group-title")).toHaveText(name);
}

/** On phones panels are tabs; on laptops all panels are visible. */
async function showPanel(page: Page, tab: "bills" | "summary" | "members") {
  const t = page.getByTestId(`tab-${tab}`);
  if (await t.isVisible()) await t.click();
}

async function pickOption(page: Page, selectTestId: string, label: string) {
  const select = page.getByTestId(selectTestId);
  await select.click();
  await select.locator("md-select-option", { hasText: label }).click();
}

async function addEqualBill(page: Page, desc: string, amount: string, paidBy: string, exclude: string[] = []) {
  await addBillBtn(page).click();
  const dialog = page.getByTestId("bill-dialog");
  await expect(dialog).toHaveAttribute("data-ready", "1");
  await fill(page, "bill-description", desc);
  await fill(page, "bill-amount", amount);
  await pickOption(page, "bill-paid-by", paidBy);
  for (const p of exclude) await page.getByTestId(`split-check-${p}`).click();
  await page.getByTestId("bill-save").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("bill-item").filter({ hasText: desc }).first()).toBeAttached();
  await expect(page.locator("[data-saving]")).toHaveCount(0); // optimistic save confirmed + re-render done
}

async function saveBill(page: Page) {
  await page.getByTestId("bill-save").click();
  await expect(page.getByTestId("bill-dialog")).toHaveCount(0);
  await expect(page.locator("[data-saving]")).toHaveCount(0);
}

test("create group, add bill, see who owes whom", async ({ page }) => {
  await createGroup(page, `Trip ${uniq()}`, ["Ann", "Ben", "Chai"]);
  await showPanel(page, "bills");
  await expect(page.getByTestId("bills-empty")).toBeVisible();

  await addEqualBill(page, "Dinner", "300", "Ann");
  await expect(page.getByTestId("bill-item")).toHaveCount(1);
  await expect(page.getByTestId("bill-item").first()).toContainText("Dinner");

  await showPanel(page, "summary");
  const settlements = page.getByTestId("settlement");
  await expect(settlements).toHaveCount(2);
  await expect(page.getByTestId("settlements")).toContainText("Ben pays Ann");
  await expect(page.getByTestId("settlements")).toContainText("Chai pays Ann");
  await expect(page.getByTestId("settlements")).toContainText("100");
});

test("equal split excluding someone; settle up to zero", async ({ page }) => {
  await createGroup(page, `Flat ${uniq()}`, ["Ann", "Ben", "Chai"]);
  await addEqualBill(page, "Taxi", "90", "Ben", ["Chai"]);
  await showPanel(page, "summary");
  await expect(page.getByTestId("settlement")).toHaveCount(1);
  await expect(page.getByTestId("settlements")).toContainText("Ann pays Ben");

  await page.getByTestId("settle-btn").click();
  await expect(page.getByTestId("bill-dialog")).toBeVisible();
  await page.getByTestId("bill-save").click();
  await expect(page.getByTestId("all-settled")).toBeVisible();
});

test("exact split validates the total", async ({ page }) => {
  await createGroup(page, `Exact ${uniq()}`, ["Ann", "Ben"]);
  await addBillBtn(page).click();
  await fill(page, "bill-description", "Groceries");
  await fill(page, "bill-amount", "100");
  await page.getByTestId("mode-exact").click();
  await fill(page, "split-exact-Ann", "30");
  await fill(page, "split-exact-Ben", "60");
  await expect(page.getByTestId("split-status")).toContainText("Amounts add up to");
  await page.getByTestId("bill-save").click();
  await expect(page.getByTestId("bill-dialog")).toContainText("the bill is");
  await fill(page, "split-exact-Ben", "70");
  await expect(page.getByTestId("split-status")).toContainText("2 people");
  await page.getByTestId("bill-save").click();
  await expect(page.getByTestId("bill-dialog")).toHaveCount(0);
  await showPanel(page, "summary");
  await expect(page.getByTestId("settlements")).toContainText("Ben pays Ann");
  await expect(page.getByTestId("settlements")).toContainText("70");
});

test("edit and delete a bill", async ({ page }) => {
  await createGroup(page, `Edit ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Coffee", "10", "Ann");
  await page.getByTestId("bill-item").first().click();
  await fill(page, "bill-description", "Coffee & cake");
  await fill(page, "bill-amount", "20");
  await saveBill(page);
  await expect(page.getByTestId("bill-item").first()).toContainText("Coffee & cake");
  await expect(page.getByTestId("total-spent")).toContainText("20");

  await page.getByTestId("bill-item").first().click();
  await page.getByTestId("bill-delete").click();
  await expect(page.getByTestId("bills-empty")).toBeVisible();
});

test("manage people", async ({ page }) => {
  await createGroup(page, `People ${uniq()}`, ["Ann", "Ben"]);
  await showPanel(page, "members");
  await page.getByTestId("add-member-btn").click();
  await fill(page, "member-name-input", "Dao");
  await page.getByTestId("member-save").click();
  await expect(page.getByTestId("member-item")).toHaveCount(3);

  await page.getByTestId("remove-member-Dao").click();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("member-item")).toHaveCount(2);

  // A person on a bill can't be removed.
  await addEqualBill(page, "Snacks", "5", "Ann");
  await showPanel(page, "members");
  await page.getByTestId("remove-member-Ben").click();
  await page.getByTestId("confirm-ok").click();
  await expect(page.locator("#snackbar")).toContainText("used by bills");
  await expect(page.getByTestId("member-item")).toHaveCount(2);
});

test("user text is rendered as text, never HTML", async ({ page }) => {
  let dialogFired = false;
  page.on("dialog", (d) => {
    dialogFired = true;
    void d.dismiss();
  });
  const evil = `<img src=x onerror=alert(1)>`;
  await createGroup(page, evil, ["<b>Ann</b>", "Ben"]);
  await expect(page.getByTestId("group-title")).toHaveText(evil);
  await showPanel(page, "members");
  await expect(page.getByTestId("members-list")).toContainText("<b>Ann</b>");
  expect(await page.locator("img[src=x]").count()).toBe(0);
  expect(dialogFired).toBe(false);
});

test("unknown group shows not found", async ({ page }) => {
  await page.goto("/g/AAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.getByTestId("group-not-found")).toBeVisible();
});

test("home lists recently opened groups", async ({ page }) => {
  const name = `Recent ${uniq()}`;
  await createGroup(page, name, ["Ann"]);
  await page.getByTestId("nav-home").click();
  await expect(page.getByTestId("recent-groups")).toContainText(name);
});

test("layout fits the viewport (no horizontal scroll)", async ({ page }) => {
  await createGroup(page, `Fit ${uniq()}`, ["Ann", "Ben", "Chai"]);
  await addEqualBill(page, "A rather long description for a bill to test wrapping", "1234.56", "Chai");
  for (const tab of ["bills", "summary", "members"] as const) {
    await showPanel(page, tab);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${tab}`).toBeLessThanOrEqual(1);
  }
  await addBillBtn(page).click();
  const inner = page.getByTestId("bill-dialog").locator("dialog");
  await expect(inner).toBeVisible();
  const box = await inner.boundingBox();
  const vw = page.viewportSize()!.width;
  expect(box && box.width <= vw + 1).toBe(true);
});

test("payments don't inflate Paid/Share; balance rows fit", async ({ page }) => {
  await createGroup(page, `Pay ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Hotel", "100", "Ann");
  await showPanel(page, "summary");
  await page.getByTestId("settle-btn").click();
  await page.getByTestId("bill-save").click();
  await expect(page.getByTestId("all-settled")).toBeVisible();
  const rows = page.getByTestId("balance-row");
  await expect(rows.filter({ hasText: "Ann" }).getByTestId("balance-detail")).toContainText(/Paid .*100\.00/);
  await expect(rows.filter({ hasText: "Ann" }).getByTestId("balance-detail")).toContainText(/Share .*50\.00/);
  await expect(rows.filter({ hasText: "Ben" }).getByTestId("balance-detail")).toContainText(/Paid .*0\.00/);
  // Nothing in a balance row is clipped.
  const clipped = await rows.evaluateAll((els) =>
    els.flatMap((el) => [...el.querySelectorAll(".balance-detail span, .net")]).filter((s) => s.scrollWidth > s.clientWidth + 1).length,
  );
  expect(clipped).toBe(0);
});

test("access token is never sent to third-party hosts", async ({ page, baseURL }) => {
  const appOrigin = new URL(baseURL!).origin;
  const leaks: string[] = [];
  page.on("request", async (req) => {
    const h = await req.allHeaders();
    if (new URL(req.url()).origin !== appOrigin && ("cf-access-client-secret" in h || "cf-access-client-id" in h))
      leaks.push(req.url());
  });
  await page.goto("/");
  await expect(page.getByTestId("group-name")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(leaks).toEqual([]);
});
