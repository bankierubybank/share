import type { Locator, Page } from "@playwright/test";
import { contextAs, expect, test } from "./fixtures";
import { addEqualBill, createGroup, fill, field, openAddBill, saveBill, showPanel, uniq } from "./helpers";

// v0.3 features (#4, 6, 8, 10, 11, 12, 16, 17, 18).

async function openMenuItem(page: Page, testid: string) {
  await page.getByTestId("group-more").click();
  await page.waitForFunction(() => (document.querySelector("[data-testid=group-menu]") as HTMLElement & { open: boolean })?.open);
  await page.getByTestId(testid).click();
}

async function openBill(page: Page, desc: string) {
  await showPanel(page, "bills");
  await page.getByTestId("bill-item").filter({ hasText: desc }).first().click();
  await expect(page.getByTestId("bill-dialog")).toHaveAttribute("data-ready", "1");
}

/** Synthetic touch pointer events (work on every engine; the gesture code only checks pointerType). */
async function touchSwipeLeft(row: Locator) {
  const box = (await row.boundingBox())!;
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width - 20;
  await row.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 7, button: 0, clientX: x0, clientY: y, isPrimary: true });
  for (let i = 1; i <= 8; i++) await row.dispatchEvent("pointermove", { pointerType: "touch", pointerId: 7, clientX: x0 - i * 20, clientY: y });
  await row.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 7, clientX: x0 - 160, clientY: y });
}

async function longPress(row: Locator) {
  const box = (await row.boundingBox())!;
  const at = { pointerType: "touch", pointerId: 9, button: 0, clientX: box.x + 40, clientY: box.y + box.height / 2, isPrimary: true };
  await row.dispatchEvent("pointerdown", at);
  await row.page().waitForTimeout(800);
  await row.dispatchEvent("pointerup", at);
}

test("comments on a bill (#4)", async ({ page }) => {
  await createGroup(page, `Cmt ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Beers", "300", "Ann");
  await openBill(page, "Beers");
  await fill(page, "comment-input", "Who had the 2nd round?\n<b>me</b>");
  await page.getByTestId("comment-post").click();
  await expect(page.getByTestId("comment")).toHaveCount(1);
  await expect(page.getByTestId("comment").first()).toContainText("<b>me</b>"); // shown as text
  await page.getByTestId("bill-cancel").click();
  await expect(page.getByTestId("bill-item").filter({ hasText: "Beers" })).toContainText("1 comment");
  await showPanel(page, "activity");
  await expect(page.getByTestId("activity-list")).toContainText("Commented on “Beers”");
});

test("subgroups for one-tap split picks (#6)", async ({ page }) => {
  await createGroup(page, `Sub ${uniq()}`, ["Ann", "Ben", "Cat"]);
  await showPanel(page, "members");
  await page.getByTestId("subgroup-add").click();
  await fill(page, "subgroup-name", "Couple");
  await page.getByTestId("subgroup-check-Ann").click();
  await page.getByTestId("subgroup-check-Ben").click();
  await page.getByTestId("subgroup-save").click();
  await expect(page.getByTestId("subgroup-item")).toContainText("Ann, Ben");
  await openAddBill(page);
  await fill(page, "bill-amount", "100");
  await fill(page, "bill-description", "Room");
  await page.getByTestId("pick-sub-Couple").click();
  await expect(page.getByTestId("share-Ann")).toContainText("50.00");
  await expect(page.getByTestId("share-Cat")).toHaveText("—");
  await page.getByTestId("pick-everyone").click();
  await expect(page.getByTestId("share-Cat")).toContainText("33.33");
  await page.getByTestId("pick-none").click();
  await expect(page.getByTestId("split-status")).toContainText("Select at least one person");
});

test("partial settle-up + history (#8)", async ({ page }) => {
  await createGroup(page, `Part ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Hotel", "1000", "Ann");
  await showPanel(page, "summary");
  await page.getByTestId("settle-btn").click();
  await expect(page.getByTestId("bill-dialog")).toHaveAttribute("data-ready", "1");
  await page.getByTestId("pay-half").click();
  await expect(field(page, "bill-amount")).toHaveValue("250.00");
  await saveBill(page);
  await expect(page.getByTestId("settlements")).toContainText("Ben pays Ann");
  await expect(page.getByTestId("settlements")).toContainText("250.00");
  await expect(page.getByTestId("settle-history-item")).toHaveCount(1);
  await expect(page.getByTestId("settle-history")).toContainText("Ben → Ann");
});

test("move a bill to another group, adding a missing person (#10)", async ({ page }) => {
  const target = `Tgt ${uniq()}`;
  await createGroup(page, target, ["Ann"]);
  await createGroup(page, `Src ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Misfiled taxi", "80", "Ben");
  await openBill(page, "Misfiled taxi");
  await page.locator("details.more > summary").click();
  await page.getByTestId("bill-move").click();
  await page.getByTestId("pick-group-item").filter({ hasText: target }).click();
  await expect(page.getByTestId("confirm-dialog")).toContainText("Ben");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("bills-empty")).toBeVisible();
  await page.getByTestId("nav-home").click();
  await page.getByTestId("recent-groups").getByText(target).click();
  await expect(page.getByTestId("bill-item").filter({ hasText: "Misfiled taxi" })).toHaveCount(1);
  await showPanel(page, "members");
  await expect(page.getByTestId("members-list")).toContainText("Ben");
});

test("merge another group into this one (#10)", async ({ page }) => {
  const source = `MSrc ${uniq()}`;
  await createGroup(page, source, ["Ann", "Ben"]);
  await addEqualBill(page, "Lunch", "60", "Ann");
  await createGroup(page, `MTgt ${uniq()}`, ["ann", "Ben"]);
  await openMenuItem(page, "group-settings");
  await page.getByTestId("merge-group").click();
  await page.getByTestId("pick-group-item").filter({ hasText: source }).click();
  await page.getByTestId("confirm-ok").click(); // "Merge groups?"
  await expect(page.getByTestId("bill-item").filter({ hasText: "Lunch" })).toHaveCount(1);
  await showPanel(page, "activity");
  await expect(page.getByTestId("activity-list")).toContainText(`Merged “${source}”`);
});

test("trip stats (#11)", async ({ page }) => {
  await createGroup(page, `Stats ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Dinner", "300", "Ann");
  await showPanel(page, "summary");
  await expect(page.getByTestId("stat-days")).toContainText("1");
  await expect(page.getByTestId("stat-per-day")).toContainText("300.00");
  await expect(page.getByTestId("stat-ppd")).toContainText("150.00");
  await expect(page.getByTestId("stat-top")).toContainText("Ann");
});

test("read-only view link: create, open, revoke (#12)", async ({ page }) => {
  const name = `RO ${uniq()}`;
  await createGroup(page, name, ["Ann", "Ben"]);
  await addEqualBill(page, "Museum", "40", "Ann");
  await openMenuItem(page, "group-settings");
  await page.getByTestId("view-link-create").click();
  const url = (await page.getByTestId("view-link-url").innerText()).trim();
  expect(url).toMatch(/\/v\/[A-Za-z0-9_-]{22}$/);
  const groupUrl = page.url();
  expect(url).not.toContain(groupUrl.split("/g/")[1]); // view id ≠ edit id
  await page.getByTestId("view-link-revoke").isVisible();
  await page.keyboard.press("Escape");

  await page.goto(url);
  await expect(page.getByTestId("view-banner")).toBeVisible();
  await expect(page.getByTestId("group-title")).toHaveText(name);
  await expect(page.getByTestId("bill-item").filter({ hasText: "Museum" })).toHaveCount(1);
  await expect(page.getByTestId("add-bill").filter({ visible: true })).toHaveCount(0);
  await expect(page.getByTestId("group-more")).toHaveCount(0);
  await expect(page.getByTestId("tab-activity")).toHaveCount(0);
  await page.getByTestId("bill-item").first().click();
  await expect(page.getByTestId("bill-dialog")).toHaveCount(0); // no edit dialog

  await page.goto(groupUrl);
  await openMenuItem(page, "group-settings");
  await page.getByTestId("view-link-revoke").click();
  await expect(page.getByTestId("view-link-url")).toHaveCount(0); // revoke saved (slow on prod) before reopening
  await page.goto(url);
  await expect(page.getByTestId("group-not-found")).toBeVisible();
});

test("swipe left deletes with undo; long-press duplicates (#16)", async ({ page }) => {
  await createGroup(page, `Swipe ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Smoothie", "90", "Ben");
  const row = page.getByTestId("bill-item").filter({ hasText: "Smoothie" }).first();
  await longPress(row);
  await expect(page.getByTestId("bill-dialog")).toHaveAttribute("data-ready", "1");
  await expect(field(page, "bill-description")).toHaveValue("Smoothie");
  await expect(page.getByTestId("bill-dialog")).toContainText("Add bill"); // a new bill, not an edit
  await saveBill(page);
  await expect(page.getByTestId("bill-item").filter({ hasText: "Smoothie" })).toHaveCount(2);

  await touchSwipeLeft(page.getByTestId("bill-item").filter({ hasText: "Smoothie" }).first());
  await expect(page.getByTestId("bill-item").filter({ hasText: "Smoothie" })).toHaveCount(1);
  await page.locator("#snackbar md-text-button", { hasText: "Undo" }).click();
  await expect(page.getByTestId("bill-item").filter({ hasText: "Smoothie" })).toHaveCount(2);
});

test("duplicate button (accessible alternative to long-press) (#16)", async ({ page }) => {
  await createGroup(page, `Dup ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Groceries", "55", "Ann");
  await openBill(page, "Groceries");
  await page.locator("details.more > summary").click();
  await page.getByTestId("bill-duplicate").click();
  await expect(page.getByTestId("bill-dialog")).toHaveAttribute("data-ready", "1");
  await expect(field(page, "bill-amount")).toHaveValue("55.00");
  await saveBill(page);
  await expect(page.getByTestId("bill-item").filter({ hasText: "Groceries" })).toHaveCount(2);
});

test("onboarding: sample data + dismissible tips (#17)", async ({ browser, baseURL }) => {
  // "Try sample" shows only with no trips at all (v0.4: home lists the server's trips for this identity), so this
  // needs a brand-new person: possible locally only (DEV_IDENTITY header); the prod service token always has trips.
  test.skip(!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseURL!), "needs a fresh identity (local only)");
  const ctx = await contextAs(browser, baseURL!, `new-${uniq()}@example.com`);
  const page = await ctx.newPage();
  await page.goto("/");
  await page.getByTestId("try-sample").click();
  await expect(page.getByTestId("group-title")).toHaveText("Sample trip");
  await expect(page.getByTestId("bill-item")).toHaveCount(4);
  await expect(page.getByTestId("tips")).toBeVisible();
  await page.getByTestId("tips-dismiss").click();
  await page.reload();
  await expect(page.getByTestId("group-title")).toHaveText("Sample trip");
  await expect(page.getByTestId("tips")).toHaveCount(0);
  await ctx.request.delete(`/api/groups/${page.url().split("/g/")[1]}`);
  await ctx.close();
});

test("home page doesn't download the group view chunk (#18)", async ({ page }) => {
  const scripts: string[] = [];
  page.on("request", (r) => r.resourceType() === "script" && scripts.push(new URL(r.url()).pathname));
  await page.goto("/");
  await expect(page.getByTestId("group-name")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(scripts.some((s) => /\/assets\/(group|bill-dialog|stats)-/.test(s))).toBe(false);
});

