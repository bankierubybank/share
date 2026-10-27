import { test, expect, contextAs } from "./fixtures";
import { createGroup, fill, showPanel, uniq } from "./helpers";

// v0.4: a trip is visible only to people linked to it (docs/API.md → Membership).
const remote = !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.TARGET_URL ?? "http://localhost:8787");

test("creator is marked 'You' and the trip is listed as mine on home", async ({ page }) => {
  const name = `Mine ${uniq()}`;
  await createGroup(page, name, ["Ann", "Ben"]);
  await showPanel(page, "members");
  const ann = page.getByTestId("member-item").filter({ hasText: "Ann" });
  await expect(ann.getByTestId("member-you")).toBeVisible();
  await expect(page.getByTestId("member-item").filter({ hasText: "Ben" }).getByTestId("member-email")).toContainText(/No email/);
  await page.getByTestId("nav-home").click();
  await expect(page.getByTestId("trip-mine").filter({ hasText: name })).toBeVisible();
});

test.describe("other people (local: header-based identities)", () => {
  test.skip(remote, "needs DEV_IDENTITY (several identities) — local only");

  test("an outsider sees 'not your trip'; after their email is added they're in", async ({ page, browser, baseURL }) => {
    const name = `Private ${uniq()}`;
    const gid = await createGroup(page, name, ["Ann", "Ben"]);
    const ben = `ben-${uniq()}@example.com`;
    const benCtx = await contextAs(browser, baseURL!, ben);
    const benPage = await benCtx.newPage();

    await benPage.goto(`/g/${gid}`);
    await expect(benPage.getByTestId("not-member")).toBeVisible();
    await expect(benPage.getByTestId("not-member")).toContainText(ben);
    await expect(benPage.getByText(name)).toHaveCount(0);

    await showPanel(page, "members");
    await page.getByTestId("edit-member-Ben").click();
    await expect(page.getByTestId("member-dialog")).toHaveAttribute("data-ready", "1");
    await fill(page, "member-email-input", ben);
    await page.getByTestId("member-save").click();
    await expect(page.getByTestId("member-item").filter({ hasText: "Ben" }).getByTestId("member-email")).toHaveText(ben);

    await benPage.goto(`/g/${gid}`);
    await expect(benPage.getByTestId("group-title")).toHaveText(name);
    await benPage.goto("/");
    await expect(benPage.getByTestId("trip-mine").filter({ hasText: name })).toBeVisible();
    await benCtx.close();
  });
});
