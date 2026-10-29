import type { Page, Route } from "@playwright/test";
import { test, expect } from "./fixtures";
import { addEqualBill, createGroup, fill, openAddBill, pickOption, settled, uniq } from "./helpers";

// v0.5 (#13): saves are optimistic — the bill shows at once, the server answer follows.

/** Holds matching API calls until `release()` (then they go on to the network / Access fixture). */
async function hold(page: Page, method: string, path: RegExp) {
  const waiting: Route[] = [];
  let open = false;
  await page.route((u) => path.test(u.pathname), async (route) => {
    if (route.request().method() !== method || open) return route.fallback();
    waiting.push(route);
  });
  return {
    count: () => waiting.length,
    release: async () => {
      open = true;
      for (const r of waiting.splice(0)) await r.fallback();
    },
  };
}

const total = (page: Page) => page.getByTestId("total-spent").filter({ visible: true }).first();

test("a new bill shows at once as Saving…, with totals, then settles", async ({ page }) => {
  await createGroup(page, `Fast ${uniq()}`, ["Ann", "Ben"]);
  const gate = await hold(page, "POST", /\/api\/groups\/[^/]+\/bills$/);
  await openAddBill(page);
  await fill(page, "bill-amount", "120");
  await fill(page, "bill-description", "Noodles");
  await pickOption(page, "bill-paid-by", "Ann");
  await page.getByTestId("bill-save").click();
  await expect(page.getByTestId("bill-dialog")).toHaveCount(0);

  const row = page.getByTestId("bill-item").filter({ hasText: "Noodles" });
  await expect(row).toHaveAttribute("data-saving", "1");
  await expect(row.getByTestId("bill-saving")).toBeVisible();
  await expect(total(page)).toContainText("120");
  expect(gate.count()).toBe(1); // still not answered

  await gate.release();
  await settled(page);
  await expect(row).toHaveCount(1);
  await expect(row).not.toHaveAttribute("data-saving");
  await expect(total(page)).toContainText("120");
});

test("a failed save rolls back and Edit reopens what was typed", async ({ page }) => {
  await createGroup(page, `Fail ${uniq()}`, ["Ann", "Ben"]);
  await page.route((u) => /\/api\/groups\/[^/]+\/bills$/.test(u.pathname), (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "internal error" } }) })
      : route.fallback());
  await openAddBill(page);
  await fill(page, "bill-amount", "77");
  await fill(page, "bill-description", "Boat");
  await page.getByTestId("bill-save").click();

  await expect(page.locator("#snackbar")).toContainText("Not saved");
  await expect(page.getByTestId("bill-item").filter({ hasText: "Boat" })).toHaveCount(0);
  await expect(page.getByTestId("bills-empty")).toBeVisible();

  await page.unrouteAll({ behavior: "wait" });
  await page.locator("#snackbar").getByText("Edit").click();
  await expect(page.getByTestId("bill-dialog")).toHaveAttribute("data-ready", "1");
  await expect(page.getByTestId("bill-description").locator("input")).toHaveValue("Boat");
  await expect(page.getByTestId("bill-amount").locator("input")).toHaveValue(/^77(\.00)?$/);
  await page.getByTestId("bill-save").click();
  await settled(page);
  await expect(page.getByTestId("bill-item").filter({ hasText: "Boat" })).toHaveCount(1);
});

test("an edit shows at once; opening a bill that's still saving waits for it", async ({ page }) => {
  await createGroup(page, `Edit ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Coffee", "60", "Ann");
  const gate = await hold(page, "PUT", /\/api\/groups\/[^/]+\/bills\/[^/]+$/);
  await page.getByTestId("bill-item").filter({ hasText: "Coffee" }).click();
  await expect(page.getByTestId("bill-dialog")).toHaveAttribute("data-ready", "1");
  await fill(page, "bill-description", "Cake");
  await page.getByTestId("bill-save").click();
  const row = page.getByTestId("bill-item").filter({ hasText: "Cake" });
  await expect(row).toHaveAttribute("data-saving", "1");
  await expect(page.getByTestId("bill-item").filter({ hasText: "Coffee" })).toHaveCount(0);

  await row.click(); // waits for the save, then opens
  await expect(page.locator("#snackbar")).toContainText("Still saving");
  await gate.release();
  await expect(page.getByTestId("bill-dialog")).toHaveAttribute("data-ready", "1");
  await expect(page.getByTestId("bill-description").locator("input")).toHaveValue("Cake");
  await page.getByTestId("bill-cancel").click();
  await settled(page);
});

test("delete is instant and Undo still works once it lands", async ({ page }) => {
  await createGroup(page, `Del ${uniq()}`, ["Ann", "Ben"]);
  await addEqualBill(page, "Ferry", "200", "Ben");
  const gate = await hold(page, "DELETE", /\/api\/groups\/[^/]+\/bills\/[^/]+$/);
  await page.getByTestId("bill-item").filter({ hasText: "Ferry" }).click();
  await expect(page.getByTestId("bill-dialog")).toHaveAttribute("data-ready", "1");
  await page.getByTestId("bill-delete").click();
  await expect(page.getByTestId("bill-item").filter({ hasText: "Ferry" })).toHaveCount(0);
  await expect(page.getByTestId("bills-empty")).toBeVisible(); // locally recomputed: nothing left
  expect(gate.count()).toBe(1);

  await page.locator("#snackbar").getByText("Undo").click(); // waits for the delete first
  await gate.release();
  await expect(page.getByTestId("bill-item").filter({ hasText: "Ferry" })).toHaveCount(1);
  await settled(page);
});

test("the trip page loads with one API request", async ({ page }) => {
  const gid = await createGroup(page, `One ${uniq()}`, ["Ann"]);
  const calls: string[] = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith(`/api/groups/${gid}`)) calls.push(u.pathname); });
  await page.reload();
  await expect(page.getByTestId("group-title")).toHaveText(/One /);
  await expect(page.getByTestId("bills-empty")).toBeVisible();
  expect(calls).toEqual([`/api/groups/${gid}/full`]);
});
