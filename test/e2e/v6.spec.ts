import { test, expect, contextAs } from "./fixtures";
import { createGroup, showPanel, uniq } from "./helpers";

// v0.6 invite links (docs/API.md → Invite links).
const remote = !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.TARGET_URL ?? "http://localhost:8787");

async function createInvite(page: import("@playwright/test").Page) {
  await showPanel(page, "members");
  const section = page.getByTestId("invite-section");
  await expect(section).toHaveAttribute("data-ready", "1");
  await section.getByTestId("invite-create").click();
  const url = (await section.getByTestId("invite-url").textContent())!.trim();
  expect(url).toMatch(/\/join\/[A-Za-z0-9_-]{22}$/);
  return new URL(url).pathname;
}

test("create, copy-ready link; opening it while already in the trip goes straight to the trip", async ({ page }) => {
  const name = `Invite ${uniq()}`;
  const gid = await createGroup(page, name, ["Ann", "Ben"]);
  const path = await createInvite(page);
  await expect(page.getByTestId("invite-copy")).toBeVisible();
  await expect(page.getByTestId("invite-revoke")).toBeVisible();

  await page.goto(path);
  await expect(page).toHaveURL(new RegExp(`/g/${gid}$`));
  await expect(page.getByTestId("group-title")).toHaveText(name);

  // After a reload the token isn't known any more (only its hash is stored): status text, no URL.
  await showPanel(page, "members");
  const section = page.getByTestId("invite-section");
  await expect(section).toHaveAttribute("data-ready", "1");
  await expect(section.getByTestId("invite-url")).toHaveCount(0);
  await expect(section.getByTestId("invite-status")).toContainText(/active until/);
  await section.getByTestId("invite-revoke").click();
  await expect(section.getByTestId("invite-create")).toBeVisible();

  await page.goto(path);
  await expect(page.getByTestId("join-error")).toContainText(/doesn't work any more/);
});

test.describe("joining as someone else (local: header-based identities)", () => {
  test.skip(remote, "needs DEV_IDENTITY (several identities) — local only");

  test("newcomer picks who they are, or joins as a new person", async ({ page, browser, baseURL }) => {
    const name = `Join ${uniq()}`;
    const gid = await createGroup(page, name, ["Ann", "Ben"]);
    const path = await createInvite(page);

    const benCtx = await contextAs(browser, baseURL!, `ben-${uniq()}@example.com`);
    const ben = await benCtx.newPage();
    await ben.goto(path);
    await expect(ben.getByTestId("join-title")).toContainText(name);
    await expect(ben.getByTestId("join-member-Ann")).toContainText(/Already joined/);
    await ben.getByTestId("join-member-Ben").click();
    await expect(ben).toHaveURL(new RegExp(`/g/${gid}$`));
    await expect(ben.getByTestId("group-title")).toHaveText(name);
    await showPanel(ben, "members");
    await expect(ben.getByTestId("member-item").filter({ hasText: "Ben" }).getByTestId("member-you")).toBeVisible();
    await benCtx.close();

    const ciaCtx = await contextAs(browser, baseURL!, `cia-${uniq()}@example.com`);
    const cia = await ciaCtx.newPage();
    await cia.goto(path);
    await expect(cia.getByTestId("join-member-Ben")).toContainText(/Already joined/);
    const field = cia.getByTestId("join-name").locator("input");
    await field.fill("Ann");
    await cia.getByTestId("join-new").click();
    await expect(cia.getByTestId("join-name")).toHaveAttribute("error", "");
    await field.fill("Cia");
    await cia.getByTestId("join-new").click();
    await expect(cia.getByTestId("group-title")).toHaveText(name);
    await ciaCtx.close();

    await page.reload();
    await showPanel(page, "members");
    await expect(page.getByTestId("member-item")).toHaveCount(3);
    await showPanel(page, "activity");
    await expect(page.getByTestId("activity-list")).toContainText("Cia joined by invite link (new person)");
    await expect(page.getByTestId("activity-list")).toContainText("Ben joined by invite link");
  });
});
