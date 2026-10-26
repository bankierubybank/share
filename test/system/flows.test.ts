import { afterAll, describe, expect, it } from "vitest";
import { api, cleanupGroups, makeGroup, today } from "../helpers/http";

afterAll(cleanupGroups);

type Settlement = { from: string; to: string; amount: number };
type Balance = { memberId: string; paid: number; owed: number; net: number };

const equal = (members: string[]) => ({ mode: "equal", members });
const exact = (shares: [string, number][]) => ({ mode: "exact", shares: shares.map(([memberId, amount]) => ({ memberId, amount })) });

async function bill(gid: string, body: Record<string, unknown>) {
  const r = await api("POST", `/api/groups/${gid}/bills`, { date: today(), ...body });
  expect(r.status, r.text).toBe(201);
  return r.json.bill as { id: string; shares: { memberId: string; amount: number }[] };
}

async function summary(gid: string) {
  const r = await api("GET", `/api/groups/${gid}/summary`);
  expect(r.status).toBe(200);
  return r.json as { balances: Balance[]; settlements: Settlement[]; total: number };
}

const shareMap = (b: { shares: { memberId: string; amount: number }[] }) =>
  Object.fromEntries(b.shares.map((s) => [s.memberId, s.amount]));

const netsByMember = (s: { balances: Balance[] }) => Object.fromEntries(s.balances.map((b) => [b.memberId, b.net]));

/** Records every suggested settlement as a payment bill. */
async function applySettlements(gid: string, settlements: Settlement[]) {
  for (const s of settlements)
    await bill(gid, { kind: "payment", description: "Settle up", amount: s.amount, paidBy: s.from, split: equal([s.to]) });
}

/** Builds the 4-person trip used by several tests. */
async function makeTrip() {
  const { gid, ids } = await makeGroup(["Ann", "Ben", "Cat", "Dan"]);
  const all = [ids.Ann, ids.Ben, ids.Cat, ids.Dan];
  const bills = {
    hotel: await bill(gid, { description: "Hotel", amount: 40000, paidBy: ids.Ann, split: equal(all) }),
    dinner: await bill(gid, { description: "Dinner", amount: 10001, paidBy: ids.Ben, split: equal(all) }),
    taxi: await bill(gid, {
      description: "Taxi",
      amount: 3000,
      paidBy: ids.Cat,
      split: exact([[ids.Ann, 1000], [ids.Cat, 500], [ids.Dan, 1500]]),
    }),
    groceries: await bill(gid, { description: "Groceries", amount: 7003, paidBy: ids.Dan, split: equal([ids.Dan, ids.Cat, ids.Ben]) }),
    museum: await bill(gid, { description: "Museum", amount: 5000, paidBy: ids.Ann, split: equal([ids.Ann, ids.Cat]) }),
    fuel: await bill(gid, {
      description: "Fuel",
      amount: 6000,
      paidBy: ids.Ben,
      split: exact([[ids.Ann, 2000], [ids.Ben, 2000], [ids.Dan, 2000]]),
    }),
  };
  return { gid, ids, all, bills };
}

describe("trip with four people", () => {
  it("computes exact balances, total and settlements", async () => {
    const { gid, ids } = await makeTrip();
    const s = await summary(gid);
    expect(s.total).toBe(71004);
    const byId = Object.fromEntries(s.balances.map((b) => [b.memberId, b]));
    expect(byId[ids.Ann]).toEqual({ memberId: ids.Ann, paid: 45000, owed: 18001, net: 26999 });
    expect(byId[ids.Ben]).toEqual({ memberId: ids.Ben, paid: 16001, owed: 16834, net: -833 });
    expect(byId[ids.Cat]).toEqual({ memberId: ids.Cat, paid: 3000, owed: 17834, net: -14834 });
    expect(byId[ids.Dan]).toEqual({ memberId: ids.Dan, paid: 7003, owed: 18335, net: -11332 });
    expect(s.balances.reduce((a, b) => a + b.net, 0)).toBe(0);
    // Greedy: largest debtor first, all pay the single creditor.
    expect(s.settlements).toEqual([
      { from: ids.Cat, to: ids.Ann, amount: 14834 },
      { from: ids.Dan, to: ids.Ann, amount: 11332 },
      { from: ids.Ben, to: ids.Ann, amount: 833 },
    ]);
  });

  it("applying all settlements zeroes everyone", async () => {
    const { gid } = await makeTrip();
    const before = await summary(gid);
    await applySettlements(gid, before.settlements);
    const after = await summary(gid);
    expect(after.settlements).toEqual([]);
    expect(after.balances.every((b) => b.net === 0)).toBe(true);
    expect(after.total).toBe(71004); // payments are not expenses
  });

  it("bills list is newest date first and carries stored shares", async () => {
    const { gid, ids } = await makeGroup(["Ann", "Ben"]);
    await bill(gid, { description: "old", amount: 100, paidBy: ids.Ann, date: "2025-01-01", split: equal([ids.Ann, ids.Ben]) });
    await bill(gid, { description: "new", amount: 100, paidBy: ids.Ann, date: "2025-06-01", split: equal([ids.Ann, ids.Ben]) });
    const g = await api("GET", `/api/groups/${gid}`);
    expect(g.json.bills.map((b: any) => b.description)).toEqual(["new", "old"]);
    expect(g.json.bills[0].shares).toHaveLength(2);
  });
});

describe("editing", () => {
  it("editing a bill updates the summary", async () => {
    const { gid, ids, all, bills } = await makeTrip();
    const put = await api("PUT", `/api/groups/${gid}/bills/${bills.dinner.id}`, {
      description: "Dinner (corrected)",
      amount: 8000,
      paidBy: ids.Ben,
      date: today(),
      split: equal(all),
    });
    expect(put.status).toBe(200);
    const s = await summary(gid);
    expect(s.total).toBe(69003);
    expect(netsByMember(s)).toEqual({
      [ids.Ann]: 27500,
      [ids.Ben]: -2334,
      [ids.Cat]: -14334,
      [ids.Dan]: -10832,
    });
  });

  it("deleting a bill updates the summary", async () => {
    const { gid, ids, bills } = await makeTrip();
    expect((await api("DELETE", `/api/groups/${gid}/bills/${bills.hotel.id}`)).status).toBe(204);
    const s = await summary(gid);
    expect(s.total).toBe(31004);
    expect(s.balances.reduce((a, b) => a + b.net, 0)).toBe(0);
    expect(netsByMember(s)[ids.Ann]).toBe(26999 - 30000); // Ann no longer paid the hotel, nor owes 10000 of it
  });

  it("member removal is blocked until their bills are gone", async () => {
    const { gid, ids } = await makeGroup(["Ann", "Ben", "Cat"]);
    const b = await bill(gid, { description: "x", amount: 300, paidBy: ids.Ann, split: equal([ids.Ann, ids.Ben]) });
    expect((await api("DELETE", `/api/groups/${gid}/members/${ids.Ben}`)).status).toBe(409);
    expect((await api("DELETE", `/api/groups/${gid}/bills/${b.id}`)).status).toBe(204);
    expect((await api("DELETE", `/api/groups/${gid}/members/${ids.Ben}`)).status).toBe(204);
    const s = await summary(gid);
    expect(s.balances).toHaveLength(2);
  });

  it("added member shows up in summary and can join later bills", async () => {
    const { gid, ids } = await makeGroup(["Ann", "Ben"]);
    const add = await api("POST", `/api/groups/${gid}/members`, { name: "Cat" });
    expect(add.status).toBe(201);
    const cat = add.json.member.id;
    await bill(gid, { description: "x", amount: 900, paidBy: ids.Ann, split: equal([ids.Ann, ids.Ben, cat]) });
    const s = await summary(gid);
    expect(netsByMember(s)).toEqual({ [ids.Ann]: 600, [ids.Ben]: -300, [cat]: -300 });
  });

  it("group rename and currency change persist", async () => {
    const { gid } = await makeGroup();
    expect((await api("PATCH", `/api/groups/${gid}`, { name: "Paris", currency: "EUR" })).status).toBe(200);
    const g = await api("GET", `/api/groups/${gid}`);
    expect(g.json.group).toMatchObject({ name: "Paris", currency: "EUR" });
  });
});

describe("payments", () => {
  it("a partial payment reduces the debt, the rest remains", async () => {
    const { gid, ids } = await makeGroup(["Ann", "Ben", "Cat"]);
    await bill(gid, { description: "Lunch", amount: 9000, paidBy: ids.Ann, split: equal([ids.Ann, ids.Ben, ids.Cat]) });
    let s = await summary(gid);
    expect(s.settlements).toHaveLength(2);
    expect(s.settlements.map((x) => x.amount)).toEqual([3000, 3000]);

    await bill(gid, { kind: "payment", description: "Ben pays", amount: 1000, paidBy: ids.Ben, split: equal([ids.Ann]) });
    s = await summary(gid);
    expect(netsByMember(s)).toEqual({ [ids.Ann]: 5000, [ids.Ben]: -2000, [ids.Cat]: -3000 });
    expect(s.settlements).toEqual([
      { from: ids.Cat, to: ids.Ann, amount: 3000 },
      { from: ids.Ben, to: ids.Ann, amount: 2000 },
    ]);
    expect(s.total).toBe(9000);
  });

  it("overpayment flips the direction of the debt", async () => {
    const { gid, ids } = await makeGroup(["Ann", "Ben"]);
    await bill(gid, { description: "x", amount: 1000, paidBy: ids.Ann, split: equal([ids.Ann, ids.Ben]) });
    await bill(gid, { kind: "payment", description: "too much", amount: 800, paidBy: ids.Ben, split: equal([ids.Ann]) });
    const s = await summary(gid);
    expect(s.settlements).toEqual([{ from: ids.Ann, to: ids.Ben, amount: 300 }]);
  });

  it("deleting a payment restores the debt", async () => {
    const { gid, ids } = await makeGroup(["Ann", "Ben"]);
    await bill(gid, { description: "x", amount: 1000, paidBy: ids.Ann, split: equal([ids.Ann, ids.Ben]) });
    const p = await bill(gid, { kind: "payment", description: "p", amount: 500, paidBy: ids.Ben, split: equal([ids.Ann]) });
    expect((await summary(gid)).settlements).toEqual([]);
    await api("DELETE", `/api/groups/${gid}/bills/${p.id}`);
    expect((await summary(gid)).settlements).toEqual([{ from: ids.Ben, to: ids.Ann, amount: 500 }]);
  });
});

describe("remainder cents", () => {
  it("go to the first members in the order given", async () => {
    const { gid, ids } = await makeGroup(["Ann", "Ben", "Cat"]);
    const a = await bill(gid, { description: "a", amount: 100, paidBy: ids.Ann, split: equal([ids.Ann, ids.Ben, ids.Cat]) });
    expect(shareMap(a)).toEqual({ [ids.Ann]: 34, [ids.Ben]: 33, [ids.Cat]: 33 });
    const b = await bill(gid, { description: "b", amount: 100, paidBy: ids.Ann, split: equal([ids.Cat, ids.Ben, ids.Ann]) });
    expect(shareMap(b)).toEqual({ [ids.Cat]: 34, [ids.Ben]: 33, [ids.Ann]: 33 });
    const c = await bill(gid, { description: "c", amount: 101, paidBy: ids.Ann, split: equal([ids.Ben, ids.Cat, ids.Ann]) });
    expect(shareMap(c)).toEqual({ [ids.Ben]: 34, [ids.Cat]: 34, [ids.Ann]: 33 });
  });

  it("are visible in balances and always conserve the total", async () => {
    const { gid, ids } = await makeGroup(["Ann", "Ben", "Cat"]);
    await bill(gid, { description: "x", amount: 1000, paidBy: ids.Ann, split: equal([ids.Ann, ids.Ben, ids.Cat]) });
    const s = await summary(gid);
    expect(netsByMember(s)).toEqual({ [ids.Ann]: 1000 - 334, [ids.Ben]: -333, [ids.Cat]: -333 });
    expect(s.balances.reduce((a, b) => a + b.owed, 0)).toBe(1000);
    await applySettlements(gid, s.settlements);
    expect((await summary(gid)).balances.every((b) => b.net === 0)).toBe(true);
  });

  it("a single cent between three people lands on the first member only", async () => {
    const { gid, ids } = await makeGroup(["Ann", "Ben", "Cat"]);
    const b = await bill(gid, { description: "x", amount: 1, paidBy: ids.Cat, split: equal([ids.Ann, ids.Ben, ids.Cat]) });
    const stored = b.shares.filter((s) => s.amount > 0);
    expect(stored).toEqual([{ memberId: ids.Ann, amount: 1 }]);
    const s = await summary(gid);
    expect(netsByMember(s)).toEqual({ [ids.Ann]: -1, [ids.Ben]: 0, [ids.Cat]: 1 });
    expect(s.settlements).toEqual([{ from: ids.Ann, to: ids.Cat, amount: 1 }]);
  });
});

describe("app shell and health", () => {
  it("GET /api/health", async () => {
    const r = await api("GET", "/api/health");
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(typeof r.json.version).toBe("string");
  });

  it.each(["/", "/g/anything", "/g/AAAAAAAAAAAAAAAAAAAAAA", "/some/deep/spa/route"])("SPA route %s returns HTML", async (path) => {
    const r = await api("GET", path);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    expect(r.text).toMatch(/<html|<!doctype html/i);
  });

  it("a full lifecycle works from creation to zero balances", async () => {
    const created = await api("POST", "/api/groups", { name: "Weekend", currency: "THB", members: ["Ann", "Ben"] });
    expect(created.status).toBe(201);
    const gid = created.json.group.id;
    const [ann, ben] = created.json.members.map((m: any) => m.id);
    await bill(gid, { description: "Beer", amount: 25050, paidBy: ann, split: equal([ann, ben]) });
    const s = await summary(gid);
    expect(s.settlements).toEqual([{ from: ben, to: ann, amount: 12525 }]);
    await applySettlements(gid, s.settlements);
    expect((await summary(gid)).settlements).toEqual([]);
    const g = await api("GET", `/api/groups/${gid}`);
    expect(g.json.bills).toHaveLength(2);
    expect(g.json.bills.map((b: any) => b.kind).sort()).toEqual(["expense", "payment"]);
  });
});
