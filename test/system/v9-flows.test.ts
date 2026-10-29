import { afterAll, describe, expect, it } from "vitest";
import { api, cleanupGroups, makeGroup, today } from "../helpers/http";

// v0.9 contracts that hold on prod too: trip budget (#4) and retry-safe bill creates for the offline queue (#8).

afterAll(cleanupGroups);

const bill = (gid: string, ids: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  description: "Taxi", amount: 1200, paidBy: ids.Alice, date: today(), category: "transport",
  split: { mode: "equal", members: Object.values(ids) }, ...extra,
});

describe("v0.9 trip budget", () => {
  it("set, shown on the trip, logged, cleared", async () => {
    const g = await makeGroup(["Alice", "Bob"], "THB");
    let r = await api("PATCH", `/api/groups/${g.gid}`, { budget: 2_000_000 });
    expect(r.status).toBe(200);
    expect(r.json.group.budget).toBe(2_000_000);
    const full = (await api("GET", `/api/groups/${g.gid}/full`)).json;
    expect(full.group.budget).toBe(2_000_000);
    expect(full.activity.some((a: { action: string; detail: { to: number } }) => a.action === "group.budget" && a.detail.to === 2_000_000)).toBe(true);
    // Renaming leaves the budget alone; null clears it.
    r = await api("PATCH", `/api/groups/${g.gid}`, { name: "Renamed" });
    expect(r.json.group.budget).toBe(2_000_000);
    r = await api("PATCH", `/api/groups/${g.gid}`, { budget: null });
    expect(r.json.group.budget).toBeNull();
    expect((await api("GET", `/api/groups/${g.gid}`)).json.group.budget).toBeNull();
  });

  it("rejects bad budgets and changes to an archived trip", async () => {
    const g = await makeGroup(["Alice"]);
    for (const budget of [0, -5, 1.5, "100", true, 100_000_000_001])
      expect((await api("PATCH", `/api/groups/${g.gid}`, { budget })).status, String(budget)).toBe(400);
    expect((await api("PATCH", `/api/groups/${g.gid}`, { archived: true })).status).toBe(200);
    expect((await api("PATCH", `/api/groups/${g.gid}`, { budget: 500 })).status).toBe(409);
  });
});

describe("v0.9 retry-safe bill create (clientRef)", () => {
  it("the same clientRef returns the first bill instead of adding a second", async () => {
    const g = await makeGroup(["Alice", "Bob"]);
    const ref = `t${Date.now().toString(36)}-retry-key`;
    const first = await api("POST", `/api/groups/${g.gid}/bills`, bill(g.gid, g.ids, { clientRef: ref }));
    expect(first.status).toBe(201);
    const again = await api("POST", `/api/groups/${g.gid}/bills`, bill(g.gid, g.ids, { clientRef: ref, amount: 9999 }));
    expect(again.status).toBe(200);
    expect(again.json.replayed).toBe(true);
    expect(again.json.bill.id).toBe(first.json.bill.id);
    expect(again.json.bill.amount).toBe(1200); // the first one wins
    const bills = (await api("GET", `/api/groups/${g.gid}`)).json.bills;
    expect(bills).toHaveLength(1);
    // Without a clientRef nothing changes: two posts, two bills.
    await api("POST", `/api/groups/${g.gid}/bills`, bill(g.gid, g.ids));
    await api("POST", `/api/groups/${g.gid}/bills`, bill(g.gid, g.ids));
    expect((await api("GET", `/api/groups/${g.gid}`)).json.bills).toHaveLength(3);
  });

  it("a replay after the bill was deleted doesn't bring it back; bad refs are refused", async () => {
    const g = await makeGroup(["Alice", "Bob"]);
    const ref = `d${Date.now().toString(36)}-deleted`;
    const first = await api("POST", `/api/groups/${g.gid}/bills`, bill(g.gid, g.ids, { clientRef: ref }));
    expect((await api("DELETE", `/api/groups/${g.gid}/bills/${first.json.bill.id}`)).status).toBe(204);
    const again = await api("POST", `/api/groups/${g.gid}/bills`, bill(g.gid, g.ids, { clientRef: ref }));
    expect(again.status).toBe(200);
    expect((await api("GET", `/api/groups/${g.gid}`)).json.bills).toHaveLength(0);
    for (const clientRef of ["short", "has space here", "x".repeat(65), 12345678, "semi;colon-xx"])
      expect((await api("POST", `/api/groups/${g.gid}/bills`, bill(g.gid, g.ids, { clientRef }))).status, String(clientRef)).toBe(400);
  });
});
