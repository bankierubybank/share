import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// v0.9: clientRef keys are per trip (another trip's key never returns its bill), and the trip version token moves
// when the budget changes (live refresh picks it up).

async function call(who: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "Cf-Access-Authenticated-User-Email": who };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await exports.default.fetch(new Request(`http://example.com${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

async function trip(owner: string, people: string[]) {
  const r = await call(owner, "POST", "/api/groups", { name: "T", currency: "THB", members: people });
  expect(r.status).toBe(201);
  return { gid: r.json.group.id as string, ids: (r.json.members as { id: string }[]).map((m) => m.id) };
}

const body = (ids: string[], clientRef: string) => ({
  description: "Dinner", amount: 3000, paidBy: ids[0], date: "2026-10-01", category: "food", split: { mode: "equal", members: ids }, clientRef,
});

describe("v0.9 clientRef", () => {
  it("is scoped to the trip: the same key in another trip makes a new bill there", async () => {
    const a = await trip("a9@x.io", ["A", "B"]);
    const b = await trip("b9@x.io", ["C", "D"]);
    const ref = "shared-key-1234";
    const ra = await call("a9@x.io", "POST", `/api/groups/${a.gid}/bills`, body(a.ids, ref));
    const rb = await call("b9@x.io", "POST", `/api/groups/${b.gid}/bills`, body(b.ids, ref));
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    expect(rb.json.bill.id).not.toBe(ra.json.bill.id);
    expect(JSON.stringify(rb.json)).not.toContain(a.gid);
  });

  it("parallel retries with one key leave exactly one bill", async () => {
    const a = await trip("p9@x.io", ["A", "B"]);
    const rs = await Promise.all([1, 2, 3, 4].map(() => call("p9@x.io", "POST", `/api/groups/${a.gid}/bills`, body(a.ids, "parallel-key-1"))));
    expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.json.bill.id)).size).toBe(1);
    expect((await call("p9@x.io", "GET", `/api/groups/${a.gid}`)).json.bills).toHaveLength(1);
  });
});

describe("v0.9 budget + live refresh", () => {
  it("changing the budget moves the version token", async () => {
    const a = await trip("v9@x.io", ["A"]);
    const v1 = (await call("v9@x.io", "GET", `/api/groups/${a.gid}/version`)).json.v;
    expect((await call("v9@x.io", "PATCH", `/api/groups/${a.gid}`, { budget: 100000 })).status).toBe(200);
    const v2 = (await call("v9@x.io", "GET", `/api/groups/${a.gid}/version`)).json.v;
    expect(v2).not.toBe(v1);
    // Setting the same budget again is not a change (no activity, same token).
    await call("v9@x.io", "PATCH", `/api/groups/${a.gid}`, { budget: 100000 });
    expect((await call("v9@x.io", "GET", `/api/groups/${a.gid}/version`)).json.v).toBe(v2);
  });
});
