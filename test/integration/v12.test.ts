import { exports } from "cloudflare:workers";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { message, pushDeps } from "../../src/routes-v11";
import { ACTIVITY_DAYS, scheduledMaintenance } from "../../src/routes";
import { PREDEPLOY_KEEP } from "../../src/backup";

// v0.12: favourite bills (#4), leave trip (#6), more push notices (#7), predeploy-backup + activity retention (#22),
// merge in one transaction (#23).

async function call(who: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "Cf-Access-Authenticated-User-Email": who };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await exports.default.fetch(new Request(`http://example.com${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  const timing = res.headers.get("Server-Timing") ?? "";
  return { status: res.status, json: text ? JSON.parse(text) : undefined, trips: Number(timing.match(/desc="(\d+) round trips"/)?.[1] ?? NaN) };
}

async function trip(owner: string, people = ["Ann", "Ben"], name = "T12") {
  const r = await call(owner, "POST", "/api/groups", { name, currency: "THB", members: people });
  expect(r.status).toBe(201);
  return { gid: r.json.group.id as string, ids: (r.json.members as { id: string }[]).map((m) => m.id) };
}

const bill = (ids: string[], extra: Record<string, unknown> = {}) =>
  ({ description: "Rent", amount: 9000, paidBy: ids[0], date: "2026-10-20", category: "lodging", split: { mode: "equal", members: ids }, ...extra });

describe("favourite bills (#4)", () => {
  it("save, list (also in /full), use as normalized bill; validated like a bill; unique names; delete", async () => {
    const t = await trip("f12@x.io", ["Ann", "Ben", "Cat"]);
    const path = `/api/groups/${t.gid}/templates`;
    const { date: _d, ...body } = bill(t.ids, { split: { mode: "shares", weights: [{ memberId: t.ids[0], weight: 2 }, { memberId: t.ids[1], weight: 1 }] } });
    const r = await call("f12@x.io", "POST", path, { name: "Rent", bill: { ...body, date: "2026-01-01" } });
    expect(r.status).toBe(201);
    expect(r.json.template).toMatchObject({ name: "Rent", bill: { description: "Rent", amount: 9000, paidBy: t.ids[0], splitMode: "shares", category: "lodging", kind: "expense" } });
    expect(r.json.template.bill.date).toBeUndefined();
    expect((await call("f12@x.io", "GET", path)).json.templates).toEqual([r.json.template]);
    expect((await call("f12@x.io", "GET", `/api/groups/${t.gid}/full`)).json.templates).toEqual([r.json.template]);

    expect((await call("f12@x.io", "POST", path, { name: "rent", bill: body })).status).toBe(409);
    for (const bad of [{ name: "", bill: body }, { name: "X", bill: { ...body, paidBy: "AAAAAAAAAAAAAAAA" } }, { name: "X" }, { name: "X", bill: { ...body, amount: -1 } }])
      expect((await call("f12@x.io", "POST", path, bad)).status, JSON.stringify(bad)).toBe(400);

    // A person in it removed later (nobody's bills use them): stays listed, unusable (bill null), removable.
    const cat = await call("f12@x.io", "POST", path, { name: "With Cat", bill: { ...body, split: { mode: "equal", members: t.ids } } });
    expect((await call("f12@x.io", "DELETE", `/api/groups/${t.gid}/members/${t.ids[2]}`)).status).toBe(204);
    const listed = (await call("f12@x.io", "GET", path)).json.templates;
    expect(listed.map((x: { name: string; bill: unknown }) => [x.name, x.bill === null])).toEqual([["Rent", false], ["With Cat", true]]);
    expect((await call("f12@x.io", "DELETE", `${path}/${cat.json.template.id}`)).status).toBe(204);
    expect((await call("f12@x.io", "DELETE", `${path}/${cat.json.template.id}`)).status).toBe(404);
  });

  it("another trip's favourite can't be deleted; at most 30 per trip; only people in the trip", async () => {
    const a = await trip("f12b@x.io");
    const b = await trip("f12b@x.io");
    const { date: _d, ...body } = bill(a.ids);
    const tid = (await call("f12b@x.io", "POST", `/api/groups/${a.gid}/templates`, { name: "Mine", bill: body })).json.template.id;
    expect((await call("f12b@x.io", "DELETE", `/api/groups/${b.gid}/templates/${tid}`)).status).toBe(404);
    expect((await call("stranger12@x.io", "GET", `/api/groups/${a.gid}/templates`)).status).toBe(403);
    for (let i = 1; i < 30; i++) expect((await call("f12b@x.io", "POST", `/api/groups/${a.gid}/templates`, { name: `F${i}`, bill: body })).status).toBe(201);
    const over = await call("f12b@x.io", "POST", `/api/groups/${a.gid}/templates`, { name: "F31", bill: body });
    expect([over.status, over.json.error.code]).toEqual([409, "limit"]);
  });
});

describe("leave trip (#6)", () => {
  it("refused for the last linked person and while unsettled; then unlinks me only, logged, works while archived", async () => {
    const t = await trip("l12a@x.io");
    const leave = (who: string) => call(who, "POST", `/api/groups/${t.gid}/leave`, {});
    expect((await leave("l12a@x.io")).json.error.code).toBe("last_link");
    await call("l12a@x.io", "PATCH", `/api/groups/${t.gid}/members/${t.ids[1]}`, { email: "l12b@x.io" });
    await call("l12a@x.io", "POST", `/api/groups/${t.gid}/bills`, bill(t.ids, { amount: 1000 }));
    const owe = await leave("l12b@x.io");
    expect([owe.status, owe.json.error.code, owe.json.error.net]).toEqual([409, "unsettled", -500]);
    // Ben pays Ann back → settled → may leave, even with the trip archived.
    await call("l12b@x.io", "POST", `/api/groups/${t.gid}/bills`, { kind: "payment", description: "Back", amount: 500, paidBy: t.ids[1], date: "2026-10-21", split: { mode: "equal", members: [t.ids[0]] } });
    await call("l12a@x.io", "PATCH", `/api/groups/${t.gid}`, { archived: true });
    expect((await leave("l12b@x.io")).status).toBe(204);
    expect((await call("l12b@x.io", "GET", `/api/groups/${t.gid}`)).status).toBe(403);
    const page = (await call("l12a@x.io", "GET", `/api/groups/${t.gid}/full`)).json;
    expect(page.members.map((m: { name: string; email: string | null }) => [m.name, m.email])).toEqual([["Ann", "l12a@x.io"], ["Ben", null]]);
    expect(page.bills).toHaveLength(2); // bills and the person stay
    expect(page.activity[0]).toMatchObject({ action: "member.leave", entityId: t.ids[1], detail: { name: "Ben" } });
    expect(JSON.stringify(page.activity[0].detail)).not.toContain("l12b@x.io"); // actor is the leaver, as always; no address in the detail
    expect((await call("l12b@x.io", "GET", "/api/me/groups")).json.groups.map((g: { id: string }) => g.id)).not.toContain(t.gid);
  });
});

describe("more push notices (#7)", () => {
  const sent: string[] = [];
  const realFetch = pushDeps.fetch;
  pushDeps.fetch = async (url) => {
    sent.push(url);
    return new Response(null, { status: 201 });
  };
  afterEach(() => {
    sent.length = 0;
  });
  async function subscribe(who: string, name: string) {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const keys = { p256dh: b64u(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
    expect((await call(who, "POST", "/api/me/push", { endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys })).status).toBe(201);
  }
  const settle = async () => {
    for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 60));
  };

  it("comment → everyone else; email put on a person → only that person (not the one who did it)", async () => {
    const t = await trip("n12a@x.io", ["Ann", "Ben", "Cat"]);
    await subscribe("n12a@x.io", "n12a");
    await subscribe("n12b@x.io", "n12b");
    await subscribe("n12c@x.io", "n12c");
    // Ann links Ben (PATCH) and adds Dan with an email (POST): each hears only about themselves.
    await call("n12a@x.io", "PATCH", `/api/groups/${t.gid}/members/${t.ids[1]}`, { email: "n12b@x.io" });
    await settle();
    expect(sent).toEqual(["https://fcm.googleapis.com/fcm/send/n12b"]);
    sent.length = 0;
    await call("n12a@x.io", "POST", `/api/groups/${t.gid}/members`, { name: "Dan", email: "n12c@x.io" });
    await settle();
    expect(sent).toEqual(["https://fcm.googleapis.com/fcm/send/n12c"]);
    sent.length = 0;
    // Unchanged email / linking yourself: nothing.
    await call("n12a@x.io", "PATCH", `/api/groups/${t.gid}/members/${t.ids[1]}`, { email: "n12b@x.io", name: "Benny" });
    await call("n12a@x.io", "PATCH", `/api/groups/${t.gid}/members/${t.ids[2]}`, { email: "n12a-alt@x.io" });
    await new Promise((r) => setTimeout(r, 150));
    expect(sent).toEqual([]);

    const b = (await call("n12a@x.io", "POST", `/api/groups/${t.gid}/bills`, bill(t.ids.slice(0, 2)))).json.bill;
    await settle();
    sent.length = 0;
    expect((await call("n12b@x.io", "POST", `/api/groups/${t.gid}/bills/${b.id}/comments`, { body: "Paid by card?" })).status).toBe(201);
    await settle();
    expect(sent.sort()).toEqual(["https://fcm.googleapis.com/fcm/send/n12a", "https://fcm.googleapis.com/fcm/send/n12c"]);
  });

  it("message texts: comment (clipped), added, payment to you vs to someone else", () => {
    const long = "x".repeat(100);
    expect(message("en", "Trip", { kind: "comment", who: "Ben", description: "Dinner", text: long }).body).toBe(`Ben on “Dinner”: ${"x".repeat(79)}…`);
    expect(message("th", "Trip", { kind: "added", who: "Ann" })).toEqual({ title: "Trip", body: "Ann เพิ่มคุณเข้าทริปนี้" });
    const pay = { kind: "payment" as const, who: "Ben", description: "", amount: 50000, currency: "THB", to: "Ann", toIdentity: "ann@x.io" };
    expect(message("en", "Trip", pay, "ann@x.io").body).toBe("Ben paid you ฿500.00");
    expect(message("en", "Trip", pay, "cat@x.io").body).toBe("Ben paid Ann ฿500.00");
  });

  it("restores the real fetch afterwards", () => {
    pushDeps.fetch = realFetch;
    expect(pushDeps.fetch).toBe(realFetch);
  });
});

describe("retention (#22)", () => {
  it("activity older than 2 years goes; newer stays", async () => {
    const t = await trip("r12@x.io");
    const old = new Date(Date.now() - (ACTIVITY_DAYS + 3) * 86_400_000).toISOString();
    await env.DB.prepare("INSERT INTO activity (id, group_id, at, actor, action) VALUES ('oldactivity00001', ?, ?, 'x', 'group.rename')").bind(t.gid, old).run();
    await scheduledMaintenance(env);
    const ids = (await env.DB.prepare("SELECT id FROM activity WHERE group_id = ?").bind(t.gid).all<{ id: string }>()).results.map((r) => r.id);
    expect(ids).not.toContain("oldactivity00001");
    expect(ids.length).toBeGreaterThan(0); // group.create from today
  });

  it("predeploy exports older than 30 days go, but the newest few always stay", async () => {
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const keys = [`predeploy/${day(1)}T1200-aaaaaaa.sql`, `predeploy/${day(40)}T1200-bbbbbbb.sql`, `predeploy/${day(50)}T1200-ccccccc.sql`,
      `predeploy/${day(60)}T1200-ddddddd.sql`, `predeploy/${day(70)}T1200-eeeeeee.sql`];
    for (const k of keys) await env.BACKUPS.put(k, "--");
    await scheduledMaintenance(env);
    const left = (await env.BACKUPS.list({ prefix: "predeploy/" })).objects.map((o) => o.key).sort();
    // Newest 3 kept (one recent + two old ones), the older two removed.
    expect(left).toEqual([keys[3], keys[2], keys[1], keys[0]].slice(4 - PREDEPLOY_KEEP).sort());
  });
});

describe("merge in one transaction (#23)", () => {
  it("40 bills, people added, comments, splits remapped — in a fixed number of round trips", async () => {
    const into = await trip("m12@x.io", ["Ann", "Ben"], "Into");
    const from = await trip("m12@x.io", ["ann", "Ben", "Cat"], "From"); // "ann" matches Ann (case-insensitive); Cat is new
    const [fa, fb, fc] = from.ids;
    for (let i = 0; i < 40; i++)
      await call("m12@x.io", "POST", `/api/groups/${from.gid}/bills`, bill(from.ids, {
        description: `B${i}`, amount: 3000 + i, paidBy: [fa, fb, fc][i % 3],
        split: i % 2 ? { mode: "equal", members: [fb, fc] } : { mode: "itemized", items: [{ description: "x", amount: 3000 + i, members: [fa, fc] }] },
      }));
    const first = (await call("m12@x.io", "GET", `/api/groups/${from.gid}`)).json.bills.at(-1);
    await call("m12@x.io", "POST", `/api/groups/${from.gid}/bills/${first.id}/comments`, { body: "keep me" });
    const before = (await call("m12@x.io", "GET", `/api/groups/${from.gid}/summary`)).json;

    const r = await call("m12@x.io", "POST", `/api/groups/${into.gid}/merge`, { sourceGroupId: from.gid, addMissingMembers: true });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ moved: 40, addedMembers: ["Cat"], sourceArchived: true });
    expect(r.trips).toBeLessThanOrEqual(8); // was ~2 per 25 bills + 5; now independent of the bill count

    const page = (await call("m12@x.io", "GET", `/api/groups/${into.gid}/full`)).json;
    const name = new Map(page.members.map((m: { id: string; name: string }) => [m.id, m.name]));
    expect(page.bills).toHaveLength(40);
    for (const b of page.bills) {
      for (const id of [b.paidBy, ...b.payers.map((p: { memberId: string }) => p.memberId), ...b.shares.map((s: { memberId: string }) => s.memberId)])
        expect(name.has(id), `${b.description} → ${id}`).toBe(true);
      expect(JSON.stringify(b.split)).not.toMatch(new RegExp(`${fa}|${fb}|${fc}`));
    }
    // Same balances by name as before the merge.
    const byName = (s: { balances: { memberId: string; net: number }[] }, names: Map<unknown, unknown>) =>
      Object.fromEntries(s.balances.map((x) => [String(names.get(x.memberId)).toLowerCase(), x.net]));
    const fromNames = new Map([[fa, "ann"], [fb, "Ben"], [fc, "Cat"]]);
    expect(byName(page.summary, name)).toEqual(byName(before, fromNames));
    const moved = page.bills.find((b: { id: string }) => b.id === first.id);
    expect(moved.commentCount).toBe(1);
    expect(page.activity.filter((a: { action: string }) => a.action === "bill.moveIn")).toHaveLength(40);
    const src = (await call("m12@x.io", "GET", `/api/groups/${from.gid}/full`)).json;
    expect([src.group.archived, src.bills.length]).toEqual([true, 0]);
    expect(JSON.stringify(page.activity)).not.toContain(from.gid);
  });
});
