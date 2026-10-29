import { test, expect } from "./fixtures";
import { addEqualBill, createGroup, fill, openAddBill, pickOption, uniq } from "./helpers";

// v0.10 (review fixes): budget survives a currency switch (#1), an expired sign-in isn't "offline" (#2), deleted
// trips go to a bin and come back (#3).

async function openSettings(page: import("@playwright/test").Page) {
  await page.getByTestId("group-more").click();
  await page.getByTestId("group-settings").click();
  await expect(page.getByTestId("settings-dialog")).toHaveAttribute("data-ready", "1");
}

test("switching currency on a trip with a budget saves, keeping the stored amount like bills do", async ({ page }) => {
  await createGroup(page, `Cur ${uniq()}`, ["Ann", "Ben"], "THB");
  await openSettings(page);
  await fill(page, "edit-group-budget", "500");
  await page.getByTestId("edit-group-save").click();
  await expect(page.getByTestId("budget-text")).toHaveText("฿500.00 left of ฿500.00 budget");
  await openSettings(page);
  await pickOption(page, "edit-group-currency", "JPY");
  await expect(page.getByTestId("edit-group-budget").locator("input")).toHaveValue("50000");
  await page.getByTestId("edit-group-save").click();
  await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
  await expect(page.getByTestId("budget-text")).toHaveText(/50,000 left of .*50,000 budget/);
});

test("an expired sign-in says so instead of saving bills as offline", async ({ page, browserName }) => {
  await createGroup(page, `Auth ${uniq()}`, ["Ann", "Ben"]);
  // What Cloudflare Access does once the session is gone: redirect API calls to its sign-in page. Playwright's WebKit
  // can't fake a redirect ("Cannot fulfill with redirect status"): there, the Worker's own 401 (same handling).
  await page.route(/\/api\/groups\/[^/]+\/bills$/, (route) =>
    route.request().method() !== "POST" ? route.fallback()
      : browserName === "webkit" ? route.fulfill({ status: 401, contentType: "application/json", body: '{"error":{"code":"unauthorized","message":"x"}}' })
        : route.fulfill({ status: 302, headers: { location: "https://example.invalid/cdn-cgi/access/login" } }));
  await openAddBill(page);
  await fill(page, "bill-amount", "50");
  await fill(page, "bill-description", "Water");
  await page.getByTestId("bill-save").click();
  await expect(page.getByTestId("signed-out")).toBeVisible();
  await expect(page.getByTestId("bill-queued")).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("share.outbox:")).length)).toBe(0);
});

test("a deleted trip waits in Recently deleted and its page offers Restore", async ({ page }) => {
  const name = `Bin ${uniq()}`;
  const gid = await createGroup(page, name, ["Ann", "Ben"]);
  await addEqualBill(page, "Ferry", "200", "Ann");
  await openSettings(page);
  await page.getByTestId("delete-group").click();
  await fill(page, "delete-confirm-input", name);
  await page.getByTestId("delete-confirm").click();
  await expect(page).toHaveURL(/\/$/);
  const row = page.getByTestId("bin-trip").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("purge-trip")).toBeVisible(); // only I am linked

  await page.goto(`/g/${gid}`);
  await expect(page.getByTestId("trip-deleted")).toBeVisible();
  await page.getByTestId("restore-trip-page").click();
  await expect(page.getByTestId("group-title")).toHaveText(name);
  await expect(page.getByTestId("bill-item").filter({ hasText: "Ferry" })).toBeVisible();
});

test("Delete forever from the bin needs a second tap", async ({ page }) => {
  const name = `Purge ${uniq()}`;
  await createGroup(page, name, ["Ann"]);
  await openSettings(page);
  await page.getByTestId("delete-group").click();
  await fill(page, "delete-confirm-input", name);
  await page.getByTestId("delete-confirm").click();
  const row = page.getByTestId("bin-trip").filter({ hasText: name });
  await row.getByTestId("purge-trip").click();
  await expect(row.getByTestId("purge-trip")).toHaveText("Tap again to delete forever");
  await row.getByTestId("purge-trip").click();
  await expect(page.locator("#snackbar")).toContainText("deleted for good");
  await expect(page.getByTestId("bin-trip").filter({ hasText: name })).toHaveCount(0);
});
