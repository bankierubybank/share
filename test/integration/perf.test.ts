import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// v0.5 (#15): fewer D1 round trips per request. Every API response reports them in Server-Timing
// (`db;dur=…;desc="N round trips"`), so these tests pin the budget per route.

const ME = "perf@x.io";

async function call(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "Cf-Access-Authenticated-User-Email": ME };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await exports.default.fetch(
    new Request(`http://example.com${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
  const text = await res.text();
  const timing = res.headers.get("Server-Timing") ?? "";
  const trips = Number(timing.match(/desc="(\d+) round trips"/)?.[1] ?? NaN);
  return { status: res.status, json: text ? JSON.parse(text) : undefined, timing, trips };
}

async function trip() {
  const r = await call("POST", "/api/groups", { name: "Perf", currency: "THB", members: ["A", "B", "C"] });
  expect(r.status).toBe(201);
  const ids = (r.json.members as { id: string }[]).map((m) => m.id);
  return { gid: r.json.group.id as string, ids };
}

const bill = (ids: string[], description = "Dinner", amount = 30000) => ({
  kind: "expense", description, amount, date: "2026-10-20", category: "food", paidBy: ids[0], split: { mode: "equal", members: ids },
});

describe("Server-Timing", () => {
  it("API responses report D1 round trips and app time", async () => {
    const r = await call("GET", "/api/health");
    expect(r.timing).toMatch(/^db;dur=\d+;desc="0 round trips", app;dur=\d+$/);
  });

  it("creating a trip is one round trip (insert + read back in one batch)", async () => {
    const r = await call("POST", "/api/groups", { name: "One", currency: "USD", members: ["A"] });
    expect(r.status).toBe(201);
    expect(r.trips).toBe(1);
    expect(r.json.group).toMatchObject({ name: "One", currency: "USD", archived: false });
  });
});

describe("round-trip budget per route", () => {
  it("add / edit / delete / restore a bill", async () => {
    const { gid, ids } = await trip();
    const add = await call("POST", `/api/groups/${gid}/bills`, bill(ids));
    expect(add.status).toBe(201);
    expect(add.trips).toBeLessThanOrEqual(3); // access + context + write(+read back)
    expect(add.json.bill).toMatchObject({ description: "Dinner", amount: 30000, paidBy: ids[0] });
    expect(add.json.bill.shares.map((s: { memberId: string }) => s.memberId)).toEqual(ids);
    const bid = add.json.bill.id as string;

    const edit = await call("PUT", `/api/groups/${gid}/bills/${bid}`, bill(ids, "Lunch", 9000));
    expect(edit.status).toBe(200);
    expect(edit.trips).toBeLessThanOrEqual(3);
    expect(edit.json.bill).toMatchObject({ id: bid, description: "Lunch", amount: 9000 });
    expect(edit.json.bill.shares.reduce((a: number, s: { amount: number }) => a + s.amount, 0)).toBe(9000);

    const del = await call("DELETE", `/api/groups/${gid}/bills/${bid}`);
    expect(del.status).toBe(204);
    expect(del.trips).toBeLessThanOrEqual(2);
    expect((await call("DELETE", `/api/groups/${gid}/bills/${bid}`)).status).toBe(404); // already deleted

    const res = await call("POST", `/api/groups/${gid}/bills/${bid}/restore`, {});
    expect(res.status).toBe(200);
    expect(res.trips).toBeLessThanOrEqual(2);
    expect(res.json.bill).toMatchObject({ id: bid, description: "Lunch" });
    expect((await call("POST", `/api/groups/${gid}/bills/${bid}/restore`, {})).status).toBe(404); // not deleted

    // Activity built in SQL matches what the app used to write.
    const act = (await call("GET", `/api/groups/${gid}/activity`)).json.activity as { action: string; detail: unknown }[];
    const of = (a: string) => act.filter((x) => x.action === a);
    expect(of("bill.delete")).toHaveLength(1);
    expect(of("bill.delete")[0].detail).toEqual({ description: "Lunch", amount: 9000, kind: "expense" });
    expect(of("bill.restore")).toHaveLength(1); // the second (404) restore logged nothing
    expect(of("bill.restore")[0].detail).toEqual({ description: "Lunch", amount: 9000, kind: "expense" });
  });

  it("delete of an unknown bill logs nothing", async () => {
    const { gid } = await trip();
    expect((await call("DELETE", `/api/groups/${gid}/bills/AAAAAAAAAAAAAAAAAAAAAA`)).status).toBe(404);
    const act = (await call("GET", `/api/groups/${gid}/activity`)).json.activity as { action: string }[];
    expect(act.map((a) => a.action)).toEqual(["group.create"]);
  });

  it("edit keeps validating against this trip's people and the 404 order", async () => {
    const { gid, ids } = await trip();
    const other = await trip();
    expect((await call("PUT", `/api/groups/${gid}/bills/AAAAAAAAAAAAAAAAAAAAAA`, bill(ids))).status).toBe(404);
    const add = await call("POST", `/api/groups/${gid}/bills`, bill(ids));
    const bad = await call("PUT", `/api/groups/${gid}/bills/${add.json.bill.id}`, bill(other.ids));
    expect(bad.status).toBe(400);
    // A bill from another trip is not found here.
    const theirs = await call("POST", `/api/groups/${other.gid}/bills`, bill(other.ids));
    expect((await call("PUT", `/api/groups/${gid}/bills/${theirs.json.bill.id}`, bill(ids))).status).toBe(404);
  });
});

describe("GET /groups/:gid/full", () => {
  it("returns the same data as the five separate endpoints, in ≤3 round trips", async () => {
    const { gid, ids } = await trip();
    const b1 = (await call("POST", `/api/groups/${gid}/bills`, bill(ids))).json.bill;
    await call("POST", `/api/groups/${gid}/bills`, { ...bill(ids, "Taxi", 12345), category: "transport" });
    await call("DELETE", `/api/groups/${gid}/bills/${b1.id}`);
    await call("POST", `/api/groups/${gid}/subgroups`, { name: "AB", memberIds: ids.slice(0, 2) });
    await call("POST", `/api/groups/${gid}/recurring`, { frequency: "monthly", startDate: "2027-01-05", bill: { ...bill(ids, "Rent"), date: undefined } });

    const full = await call("GET", `/api/groups/${gid}/full`);
    expect(full.status).toBe(200);
    expect(full.trips).toBeLessThanOrEqual(3);

    const [one, summary, recurring, activity, subgroups, invite, version] = await Promise.all([
      call("GET", `/api/groups/${gid}`), call("GET", `/api/groups/${gid}/summary`), call("GET", `/api/groups/${gid}/recurring`),
      call("GET", `/api/groups/${gid}/activity`), call("GET", `/api/groups/${gid}/subgroups`), call("GET", `/api/groups/${gid}/invite`),
      call("GET", `/api/groups/${gid}/version`),
    ]);
    expect(full.json).toEqual({
      ...one.json, summary: summary.json, recurring: recurring.json.recurring, activity: activity.json.activity, subgroups: subgroups.json.subgroups,
      invite: invite.json, version: version.json.v,
    });
    expect(full.json.activity.find((a: { action: string }) => a.action === "bill.delete").restorable).toBe(true);
    expect(full.json.summary.total).toBe(12345);
  });

  it("is gated like every trip route", async () => {
    const { gid } = await trip();
    const res = await exports.default.fetch(new Request(`http://example.com/api/groups/${gid}/full`, { headers: { "Cf-Access-Authenticated-User-Email": "stranger@x.io" } }));
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("not_member");
  });
});
