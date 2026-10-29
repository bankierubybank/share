import { exports } from "cloudflare:workers";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// v0.8: GET /api/me/overview (my position per trip + spending by month) and GET …/version (live refresh).
// The overview is SQL; it must match the per-trip summary (src/lib/money.ts computeBalances) exactly.

async function call(who: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "Cf-Access-Authenticated-User-Email": who };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await exports.default.fetch(new Request(`http://example.com${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

async function trip(owner: string, currency: string, people: string[]) {
  const r = await call(owner, "POST", "/api/groups", { name: `T ${currency}`, currency, members: people });
  expect(r.status).toBe(201);
  return { gid: r.json.group.id as string, ids: (r.json.members as { id: string }[]).map((m) => m.id) };
}

const bill = (gid: string, who: string, body: Record<string, unknown>) => call(who, "POST", `/api/groups/${gid}/bills`, { category: "food", ...body });

describe("GET /api/me/overview", () => {
  it("matches the trip summary for me — equal, exact, multi-payer, payments, deleted bills", async () => {
    const me = "ov@x.io";
    const a = await trip(me, "THB", ["Me", "Bo", "Cy"]);
    const [m, b, c] = a.ids;
    await bill(a.gid, me, { description: "Hotel", amount: 90000, paidBy: m, date: "2026-09-10", split: { mode: "equal", members: [m, b, c] } });
    await bill(a.gid, me, { description: "Taxi", amount: 30001, paidBy: b, date: "2026-10-02", split: { mode: "exact", shares: [{ memberId: m, amount: 10001 }, { memberId: c, amount: 20000 }] } });
    await bill(a.gid, me, { description: "Dinner", amount: 12000, payers: [{ memberId: m, amount: 2000 }, { memberId: c, amount: 10000 }], date: "2026-10-05", split: { mode: "equal", members: [m, b, c] } });
    await bill(a.gid, me, { kind: "payment", description: "Payment", amount: 5000, paidBy: b, date: "2026-10-06", category: "other", split: { mode: "equal", members: [m] } });
    const gone = await bill(a.gid, me, { description: "Mistake", amount: 77777, paidBy: m, date: "2026-10-07", split: { mode: "equal", members: [m] } });
    await call(me, "DELETE", `/api/groups/${a.gid}/bills/${gone.json.bill.id}`);
    // A legacy single-payer bill (pre-multi-payer rows): no bill_payers row, payer only in paid_by.
    const legacy = await bill(a.gid, me, { description: "Old", amount: 600, paidBy: m, date: "2026-08-01", split: { mode: "equal", members: [m, b] } });
    await env.DB.prepare("DELETE FROM bill_payers WHERE bill_id = ?").bind(legacy.json.bill.id).run();

    const usd = await trip("other@x.io", "USD", ["Zed", "Me2"]);
    await call("other@x.io", "PATCH", `/api/groups/${usd.gid}/members/${usd.ids[1]}`, { email: me });
    await bill(usd.gid, "other@x.io", { description: "Snacks", amount: 1000, paidBy: usd.ids[0], date: "2026-10-03", split: { mode: "equal", members: usd.ids } });
    const notMine = await trip("stranger@x.io", "THB", ["S"]);

    const ov = (await call(me, "GET", "/api/me/overview")).json as { trips: { groupId: string; paid: number; owed: number; net: number; total: number; bills: number }[]; months: { month: string; currency: string; owed: number }[] };
    expect(ov.trips.map((t) => t.groupId).sort()).toEqual([a.gid, usd.gid].sort());
    expect(ov.trips.some((t) => t.groupId === notMine.gid)).toBe(false);

    for (const [t, myId] of [[a, m], [usd, usd.ids[1]]] as const) {
      const s = (await call(me, "GET", `/api/groups/${t.gid}/summary`)).json;
      const bal = s.balances.find((x: { memberId: string }) => x.memberId === myId);
      const o = ov.trips.find((x) => x.groupId === t.gid)!;
      expect({ paid: o.paid, owed: o.owed, net: o.net, total: o.total }).toEqual({ paid: bal.paid, owed: bal.owed, net: bal.net, total: s.total });
    }
    expect(ov.trips.find((x) => x.groupId === a.gid)!.bills).toBe(5); // deleted one excluded

    // My share of expenses by month and currency (payments are not spending).
    expect(ov.months).toEqual([
      { month: "2026-10", currency: "THB", owed: 10001 + 4000 },
      { month: "2026-10", currency: "USD", owed: 500 },
      { month: "2026-09", currency: "THB", owed: 30000 },
      { month: "2026-08", currency: "THB", owed: 300 },
    ]);
  });

  it("needs an identity; someone in no trip gets empty lists", async () => {
    const res = await exports.default.fetch(new Request("http://example.com/api/me/overview", { headers: { "Cf-Access-Authenticated-User-Email": "bad" } }));
    expect(res.status).toBe(401);
    expect((await call("lonely@x.io", "GET", "/api/me/overview")).json).toEqual({ trips: [], months: [] });
  });
});

describe("GET /api/groups/:gid/version", () => {
  it("changes when the trip changes, not otherwise; members only", async () => {
    const t = await trip("ver@x.io", "THB", ["A", "B"]);
    const v = async () => (await call("ver@x.io", "GET", `/api/groups/${t.gid}/version`)).json.v as string;
    const v1 = await v();
    expect(await v()).toBe(v1);
    const r = await bill(t.gid, "ver@x.io", { description: "X", amount: 100, paidBy: t.ids[0], date: "2026-10-01", split: { mode: "equal", members: t.ids } });
    const v2 = await v();
    expect(v2).not.toBe(v1);
    await call("ver@x.io", "PUT", `/api/groups/${t.gid}/bills/${r.json.bill.id}`, { description: "Y", amount: 100, paidBy: t.ids[0], date: "2026-10-01", category: "food", split: { mode: "equal", members: t.ids } });
    expect(await v()).not.toBe(v2);
    expect((await call("nobody@x.io", "GET", `/api/groups/${t.gid}/version`)).status).toBe(403);
  });
});
