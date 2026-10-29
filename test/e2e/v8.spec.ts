import { test, expect, contextAs } from "./fixtures";
import { addEqualBill, createGroup, showPanel, uniq } from "./helpers";

// v0.8: balance per trip + my spending on home (#3, #4), live refresh (#12), Mark as paid (#22),
// remembered currency (#24), installable app (#11).
const remote = !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.TARGET_URL ?? "http://localhost:8787");

test("home shows my position per trip and my spending this month", async ({ page: shared, browser, baseURL }) => {
  // Spending adds up all my trips: locally use a fresh identity (the default dev one has every test's trips).
  const email = `home-${uniq()}@example.com`;
  const ctx = remote ? null : await contextAs(browser, baseURL!, email);
  const page = ctx ? await ctx.newPage() : shared;
  const name = `Home ${uniq()}`;
  await createGroup(page, name, ["Ann", "Ben"], "THB");
  await addEqualBill(page, "Lunch", "300", "Ann");
  await page.getByTestId("nav-home").click();
  const row = page.getByTestId("trip-mine").filter({ hasText: name });
  await expect(row.getByTestId("trip-net")).toHaveText(/You get .*150\.00/);
  const spend = page.getByTestId("spending-card");
  await expect(spend.getByTestId("spending-month").first()).toContainText("This month");
  if (ctx) {
    await expect(spend.getByTestId("spending-month").first()).toHaveText(/This month.*฿150\.00$/);
    // This identity owns only what this test made (the fixture's cleanup covers the default context only).
    // ctx.request skips ctx.route(): send the identity header explicitly, or this would act as the shared dev user.
    const as = { headers: { "cf-access-authenticated-user-email": email } };
    const mine = (await (await ctx.request.get("/api/me/groups", as)).json()).groups as { id: string }[];
    expect(mine).toHaveLength(1);
    for (const g of mine) await ctx.request.delete(`/api/groups/${g.id}`, as);
    await ctx.close();
  } else {
    await expect(spend).toBeVisible(); // prod: one service identity, parallel tests' trips add up
  }
});

test("Settle opens a payment whose button says Mark as paid", async ({ page }) => {
  await createGroup(page, `Pay ${uniq()}`, ["Ann", "Ben"], "THB");
  await addEqualBill(page, "Taxi", "100", "Ben");
  await page.getByTestId("hero-settle").click();
  await expect(page.getByTestId("bill-dialog")).toHaveAttribute("data-ready", "1");
  await expect(page.getByTestId("bill-save")).toHaveText("Mark as paid");
});

test("a new trip defaults to the currency of the last one I created", async ({ page }) => {
  await createGroup(page, `Cur ${uniq()}`, ["Ann"], "EUR");
  await page.getByTestId("nav-home").click();
  await expect(page.getByTestId("group-currency")).toHaveJSProperty("value", "EUR");
});

test.describe("live refresh (local: two identities)", () => {
  test.skip(remote, "needs DEV_IDENTITY (several identities) — local only");

  test("a bill someone else adds shows up without reloading", async ({ page, browser, baseURL }) => {
    await page.addInitScript(() => localStorage.setItem("share.pollMs", "800"));
    const name = `Live ${uniq()}`;
    const gid = await createGroup(page, name, ["Ann", "Ben"]);
    const ben = `ben-${uniq()}@example.com`;
    const members = (await (await page.request.get(`/api/groups/${gid}`)).json()).members as { id: string; name: string }[];
    const benId = members.find((m) => m.name === "Ben")!.id;
    expect((await page.request.patch(`/api/groups/${gid}/members/${benId}`, { data: { email: ben } })).status()).toBe(200);

    const benCtx = await contextAs(browser, baseURL!, ben);
    const r = await benCtx.request.post(`/api/groups/${gid}/bills`, {
      headers: { "cf-access-authenticated-user-email": ben }, // ctx.request skips the context's routes
      data: { description: "Ben's coffee", amount: 8000, paidBy: benId, date: new Date().toISOString().slice(0, 10), category: "food", split: { mode: "equal", members: members.map((m) => m.id) } },
    });
    expect(r.status()).toBe(201);
    await benCtx.close();

    await showPanel(page, "bills");
    await expect(page.getByTestId("bill-item").filter({ hasText: "Ben's coffee" })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#snackbar")).toContainText("Updated with changes from others");
    await expect(page.getByTestId("my-net")).toHaveText(/You owe .*40\.00/);
  });
});

test.describe("installable app (local: service worker allowed)", () => {
  test.skip(remote, "on prod the worker's own fetches would bypass the per-origin Access route (playwright.config.ts)");
  test.use({ serviceWorkers: "allow" });

  test("manifest has installable icons; the worker registers and caches the shell + bundles only", async ({ page }, info) => {
    await page.goto("/");
    const href = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(await page.locator('link[rel="manifest"]').getAttribute("crossorigin")).toBe("use-credentials");
    const manifest = await (await page.request.get(href!)).json();
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(manifest.icons.some((i: { purpose: string }) => i.purpose === "maskable")).toBe(true);
    for (const i of manifest.icons) expect((await page.request.get(i.src)).status()).toBe(200);

    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(new URL(scope).pathname).toBe("/");
    await page.reload();
    await expect(page.getByTestId("group-name")).toBeVisible();
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    info.annotations.push({ type: "sw-controlled", description: String(controlled) });
    // v0.9: the worker precaches this build itself at install (it no longer depends on the page's fetches passing
    // through it — that never happened in Playwright's Firefox, ISSUES #43). One cache per build: share-<id>.
    const cachedPaths = () => page.evaluate(async () => {
      const names = (await caches.keys()).filter((k) => k.startsWith("share-"));
      if (names.length !== 1) return [`caches: ${names.join(",")}`];
      return (await (await caches.open(names[0])).keys()).map((r) => new URL(r.url).pathname);
    });
    await expect.poll(async () => (await cachedPaths()).filter((p) => p.startsWith("/assets/")).length, { timeout: 10_000 }).toBeGreaterThan(5);
    const paths = await cachedPaths();
    expect(paths).toContain("/");
    expect(paths.every((p) => p === "/" || p.startsWith("/assets/"))).toBe(true); // never /api, never other pages
  });
});
