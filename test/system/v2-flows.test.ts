import { afterAll, describe, expect, it } from "vitest";
import { api, apiBytes, cleanupGroups, makeGroup, today } from "../helpers/http";

afterAll(cleanupGroups);

type Share = { memberId: string; amount: number };
type Balance = { memberId: string; paid: number; owed: number; net: number };
type Settlement = { from: string; to: string; amount: number };
type Summary = { balances: Balance[]; settlements: Settlement[]; total: number; byCategory: Record<string, number> };

const equal = (members: string[]) => ({ mode: "equal", members });
const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

async function post(gid: string, body: Record<string, unknown>) {
  const r = await api("POST", `/api/groups/${gid}/bills`, { date: today(), ...body });
  expect(r.status, r.text).toBe(201);
  return r.json.bill as { id: string; amount: number; shares: Share[]; payers: Share[]; fx: unknown };
}

async function summary(gid: string) {
  const r = await api("GET", `/api/groups/${gid}/summary`);
  expect(r.status, r.text).toBe(200);
  return r.json as Summary;
}

const shareMap = (b: { shares: Share[] }) => Object.fromEntries(b.shares.map((s) => [s.memberId, s.amount]));
/** Equal-sized debts tie-break on random member ids, so compare settlements order-independently. */
const sorted = (l: Settlement[]) => [...l].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
const by = (s: Summary) => Object.fromEntries(s.balances.map((b) => [b.memberId, b]));

describe("v2 trip: itemized dinner + fx taxi + shares hotel + two payers", () => {
  it("balances equal hand-computed nets, and recording the suggested settlements zeroes everyone", async () => {
    // Group currency THB (2 minor digits: amounts are satang). Members Ann, Ben, Cat.
    const { gid, ids } = await makeGroup(["Ann", "Ben", "Cat"], "THB");
    const { Ann, Ben, Cat } = ids;

    // ---- 1. Itemized dinner, Ann pays. 10% service then 7% VAT (compounding).
    // Items: Steak 3000 [Ann]; Pasta 2000 [Ben]; Salad 1500 [Cat]; Wine 3500 [Ann, Ben, Cat].
    // Subtotal = 10000. Total = 10000 * 1.10 * 1.07 = 11770.
    // Wine 3500 / 3 = 1166 r2 -> remainder to the first in order: Ann 1167, Ben 1167, Cat 1166.
    // Per-member subtotals: Ann 3000+1167 = 4167, Ben 2000+1167 = 3167, Cat 1500+1166 = 2666 (sum 10000).
    // Spread 11770 proportionally (largest remainder):
    //   Ann 11770*4167/10000 = 4904.559, Ben 11770*3167/10000 = 3727.559, Cat 11770*2666/10000 = 3137.882
    //   floors 4904+3727+3137 = 11768 -> 2 left; remainders .882 (Cat) > .559 = .559 (Ann before Ben on the tie)
    //   -> Cat 3138, Ann 4905, Ben 3727. Sum = 11770.
    const dinner = await post(gid, {
      description: "Dinner",
      category: "food",
      paidBy: Ann,
      split: {
        mode: "itemized",
        serviceBp: 1000,
        taxBp: 700,
        items: [
          { description: "Steak", amount: 3000, members: [Ann] },
          { description: "Pasta", amount: 2000, members: [Ben] },
          { description: "Salad", amount: 1500, members: [Cat] },
          { description: "Wine", amount: 3500, members: [Ann, Ben, Cat] },
        ],
      },
    });
    expect(dinner.amount).toBe(11770);
    expect(shareMap(dinner)).toEqual({ [Ann]: 4905, [Ben]: 3727, [Cat]: 3138 });

    // ---- 2. Taxi paid in USD: USD 1.00 (100 cents) @ 36.25 THB = 36.25 THB = 3625 satang. Ben pays; equal split.
    // 3625 / 3 = 1208 r1 -> Ann 1209, Ben 1208, Cat 1208.
    const taxi = await post(gid, {
      description: "Taxi",
      category: "transport",
      paidBy: Ben,
      fx: { currency: "USD", amount: 100, rate: "36.25" },
      split: equal([Ann, Ben, Cat]),
    });
    expect(taxi.amount).toBe(3625);
    expect(taxi.fx).toEqual({ currency: "USD", amount: 100, rate: "36.25" });
    expect(shareMap(taxi)).toEqual({ [Ann]: 1209, [Ben]: 1208, [Cat]: 1208 });

    // ---- 3. Hotel 9001, Cat pays, weights Ann 2 : Ben 1 : Cat 1 (sum 4).
    // 9001*2/4 = 4500.5 -> 4500, 9001/4 = 2250.25 -> 2250 twice; floors = 9000, 1 left -> largest remainder is Ann (.5)
    // -> Ann 4501, Ben 2250, Cat 2250.
    const hotel = await post(gid, {
      description: "Hotel",
      category: "lodging",
      amount: 9001,
      paidBy: Cat,
      split: { mode: "shares", weights: [{ memberId: Ann, weight: 2 }, { memberId: Ben, weight: 1 }, { memberId: Cat, weight: 1 }] },
    });
    expect(shareMap(hotel)).toEqual({ [Ann]: 4501, [Ben]: 2250, [Cat]: 2250 });

    // ---- 4. Museum 6000 paid by two people (Ann 4000 + Ben 2000), equal split -> 2000 each.
    const museum = await post(gid, {
      description: "Museum",
      category: "activities",
      amount: 6000,
      payers: [{ memberId: Ann, amount: 4000 }, { memberId: Ben, amount: 2000 }],
      split: equal([Ann, Ben, Cat]),
    });
    expect(shareMap(museum)).toEqual({ [Ann]: 2000, [Ben]: 2000, [Cat]: 2000 });
    expect(museum.payers).toHaveLength(2);

    // ---- Hand-computed totals
    // total = 11770 + 3625 + 9001 + 6000 = 30396
    // paid : Ann 11770 + 4000 = 15770 ; Ben 3625 + 2000 = 5625 ; Cat 9001            (sum 30396)
    // owed : Ann 4905 + 1209 + 4501 + 2000 = 12615
    //        Ben 3727 + 1208 + 2250 + 2000 = 9185
    //        Cat 3138 + 1208 + 2250 + 2000 = 8596                                    (sum 30396)
    // net  : Ann 15770 - 12615 = +3155 ; Ben 5625 - 9185 = -3560 ; Cat 9001 - 8596 = +405  (sum 0)
    const s = await summary(gid);
    expect(s.total).toBe(30396);
    const b = by(s);
    expect(b[Ann]).toEqual({ memberId: Ann, paid: 15770, owed: 12615, net: 3155 });
    expect(b[Ben]).toEqual({ memberId: Ben, paid: 5625, owed: 9185, net: -3560 });
    expect(b[Cat]).toEqual({ memberId: Cat, paid: 9001, owed: 8596, net: 405 });
    expect(s.balances.reduce((a, x) => a + x.net, 0)).toBe(0);
    // categories (expenses only)
    expect(s.byCategory).toEqual({ food: 11770, transport: 3625, lodging: 9001, activities: 6000 });
    // greedy: the only debtor (Ben) pays the largest creditor first
    expect(s.settlements).toEqual([
      { from: Ben, to: Ann, amount: 3155 },
      { from: Ben, to: Cat, amount: 405 },
    ]);

    // ---- Settle up with payments -> everyone at zero, no more settlements
    for (const t of s.settlements)
      await post(gid, { kind: "payment", description: "Settle up", amount: t.amount, paidBy: t.from, split: equal([t.to]) });
    const after = await summary(gid);
    expect(after.settlements).toEqual([]);
    for (const x of after.balances) expect(x.net, x.memberId).toBe(0);
    expect(after.total).toBe(30396); // payments are not expenses
    expect(after.byCategory).toEqual(s.byCategory);
    // paid/owed stay expense-only
    expect(by(after)[Ann]).toMatchObject({ paid: 15770, owed: 12615, net: 0 });

    // the activity log has the whole story
    const act = (await api("GET", `/api/groups/${gid}/activity?limit=100`)).json.activity as { action: string }[];
    expect(act.filter((a) => a.action === "bill.create")).toHaveLength(6);
    expect(act.some((a) => a.action === "group.create")).toBe(true);
  });

  it("editing a split mode / fx and deleting bills moves the nets consistently", async () => {
    const { gid, ids } = await makeGroup(["Ann", "Ben", "Cat"], "THB");
    const { Ann, Ben, Cat } = ids;
    const b1 = await post(gid, { description: "Tuk-tuk", amount: 3000, paidBy: Ann, split: equal([Ann, Ben, Cat]) });
    // Ann +2000, Ben -1000, Cat -1000
    expect(by(await summary(gid))[Ann].net).toBe(2000);
    // Re-price in USD: USD 2.00 @ 35 = 70.00 THB = 7000 satang, weighted 50/50 Ben and Cat, paid by Ann -> Ann +7000, Ben -3500, Cat -3500
    const put = await api("PUT", `/api/groups/${gid}/bills/${b1.id}`, {
      description: "Tuk-tuk",
      date: today(),
      paidBy: Ann,
      fx: { currency: "USD", amount: 200, rate: "35" },
      split: { mode: "percent", percents: [{ memberId: Ben, bp: 5000 }, { memberId: Cat, bp: 5000 }] },
    });
    expect(put.status, put.text).toBe(200);
    expect(put.json.bill.amount).toBe(7000);
    const s = await summary(gid);
    expect(by(s)[Ann].net).toBe(7000);
    expect(by(s)[Ben].net).toBe(-3500);
    expect(by(s)[Cat].net).toBe(-3500);
    expect(sorted(s.settlements)).toEqual(sorted([
      { from: Ben, to: Ann, amount: 3500 },
      { from: Cat, to: Ann, amount: 3500 },
    ]));
    await api("DELETE", `/api/groups/${gid}/bills/${b1.id}`);
    expect((await summary(gid)).settlements).toEqual([]);
  });
});

describe("v2 archive flow", () => {
  it("archive freezes the group (reads fine, writes 409), unarchive resumes it", async () => {
    const { gid, ids } = await makeGroup(["Ann", "Ben"]);
    const bill = await post(gid, { description: "Lunch", amount: 2000, paidBy: ids.Ann, split: equal([ids.Ann, ids.Ben]) });
    const before = await summary(gid);
    expect(before.settlements).toEqual([{ from: ids.Ben, to: ids.Ann, amount: 1000 }]);

    const arch = await api("PATCH", `/api/groups/${gid}`, { archived: true });
    expect(arch.status).toBe(200);
    expect(arch.json.group.archived).toBe(true);

    // writes are blocked
    const attempts: [string, string, unknown?][] = [
      ["POST", `/api/groups/${gid}/bills`, { description: "x", date: today(), amount: 100, paidBy: ids.Ann, split: equal([ids.Ann]) }],
      ["DELETE", `/api/groups/${gid}/bills/${bill.id}`],
      ["POST", `/api/groups/${gid}/members`, { name: "Cat" }],
      ["PATCH", `/api/groups/${gid}`, { name: "Renamed" }],
    ];
    for (const [m, p, b] of attempts) {
      const r = await api(m, p, b);
      expect(r.status, `${m} ${p}`).toBe(409);
      expect(r.json.error.code).toBe("archived");
    }
    // reads are unchanged
    expect(await summary(gid)).toEqual(before);
    const g = await api("GET", `/api/groups/${gid}`);
    expect(g.status).toBe(200);
    expect(g.json.bills).toHaveLength(1);
    expect(g.json.group.archived).toBe(true);

    // unarchive and carry on
    const un = await api("PATCH", `/api/groups/${gid}`, { archived: false });
    expect(un.json.group.archived).toBe(false);
    await post(gid, { kind: "payment", description: "Pay back", amount: 1000, paidBy: ids.Ben, split: equal([ids.Ann]) });
    expect((await summary(gid)).settlements).toEqual([]);

    const actions = ((await api("GET", `/api/groups/${gid}/activity`)).json.activity as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["group.archive", "group.unarchive"]));
  });

  it("a finished group can be deleted for good, receipts included", async () => {
    const { gid } = await makeGroup(["Ann"]);
    await api("PATCH", `/api/groups/${gid}`, { archived: true });
    expect((await api("DELETE", `/api/groups/${gid}`)).status).toBe(204);
    expect((await api("GET", `/api/groups/${gid}`)).status).toBe(404);
  });
});

describe("v2 undo-delete flow", () => {
  it("delete -> summary changes and Undo is offered -> restore -> everything is back", async () => {
    const { gid, ids } = await makeGroup(["Ann", "Ben", "Cat"]);
    const { Ann, Ben, Cat } = ids;
    await post(gid, { description: "Groceries", category: "groceries", amount: 6000, paidBy: Ann, split: equal([Ann, Ben, Cat]) });
    const beer = await post(gid, { description: "Beer", category: "food", amount: 3000, paidBy: Ben, split: equal([Ann, Ben, Cat]) });
    const base = await summary(gid);
    // total 9000; owed 3000 each; Ann paid 6000 (+3000), Ben 3000 (0), Cat 0 (-3000)
    expect(by(base)[Ann].net).toBe(3000);
    expect(by(base)[Ben].net).toBe(0);
    expect(by(base)[Cat].net).toBe(-3000);

    expect((await api("DELETE", `/api/groups/${gid}/bills/${beer.id}`)).status).toBe(204);
    // without Beer: total 6000; owed 2000 each; Ann +4000, Ben -2000, Cat -2000
    const without = await summary(gid);
    expect(without.total).toBe(6000);
    expect(by(without)[Ann].net).toBe(4000);
    expect(by(without)[Ben].net).toBe(-2000);
    expect(without.byCategory).toEqual({ groceries: 6000 });
    expect((await api("GET", `/api/groups/${gid}`)).json.bills).toHaveLength(1);

    // activity offers Undo
    const act = (await api("GET", `/api/groups/${gid}/activity`)).json.activity as { action: string; entityId: string; restorable: boolean; detail: any }[];
    const del = act.find((a) => a.action === "bill.delete")!;
    expect(del).toMatchObject({ entityId: beer.id, restorable: true });
    expect(del.detail).toMatchObject({ description: "Beer", amount: 3000 });

    // Undo
    const res = await api("POST", `/api/groups/${gid}/bills/${beer.id}/restore`, {});
    expect(res.status, res.text).toBe(200);
    expect(res.json.bill).toMatchObject({ id: beer.id, description: "Beer", amount: 3000, category: "food" });
    expect(shareMap(res.json.bill)).toEqual({ [Ann]: 1000, [Ben]: 1000, [Cat]: 1000 });
    expect(await summary(gid)).toEqual(base);
    const act2 = (await api("GET", `/api/groups/${gid}/activity`)).json.activity as { action: string; entityId: string; restorable: boolean }[];
    expect(act2.find((a) => a.action === "bill.delete")!.restorable).toBe(false);
    expect(act2.some((a) => a.action === "bill.restore" && a.entityId === beer.id)).toBe(true);

    // a second Undo has nothing to restore
    expect((await api("POST", `/api/groups/${gid}/bills/${beer.id}/restore`, {})).status).toBe(404);
  });

  it("a receipt survives delete + undo", async () => {
    const { gid, ids } = await makeGroup(["Ann", "Ben"]);
    const bill = await post(gid, { description: "Dinner", amount: 2000, paidBy: ids.Ann, split: equal([ids.Ann, ids.Ben]) });
    // 1x1 PNG header is enough for the magic-byte check
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const url = `/api/groups/${gid}/bills/${bill.id}/receipt`;
    expect((await apiBytes("PUT", url, png, "image/png")).status).toBe(201);
    await api("DELETE", `/api/groups/${gid}/bills/${bill.id}`);
    expect((await apiBytes("GET", url)).status).toBe(404);
    await api("POST", `/api/groups/${gid}/bills/${bill.id}/restore`, {});
    const got = await apiBytes("GET", url);
    expect(got.status).toBe(200);
    expect(got.bytes).toEqual(png);
    expect((await api("GET", `/api/groups/${gid}`)).json.bills[0].hasReceipt).toBe(true);
  });
});

describe("v2 recurring monthly rent", () => {
  it("catches up on past months, never duplicates, and stops when asked", async () => {
    const { gid, ids } = await makeGroup(["Ann", "Ben", "Cat"], "THB");
    const { Ann, Ben, Cat } = ids;
    const now = new Date();
    // The 1st of the month two months ago -> occurrences: M-2, M-1, M (all on day 1, all <= today).
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
    const first = (offset: number) => isoDay(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1)));
    const nextMonth = isoDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));

    const r = await api("POST", `/api/groups/${gid}/recurring`, {
      frequency: "monthly",
      startDate: isoDay(start),
      bill: { description: "Rent", category: "lodging", amount: 30000, paidBy: Ann, split: equal([Ann, Ben, Cat]) },
    });
    expect(r.status, r.text).toBe(201);
    expect(r.json.created).toBe(3);
    expect(r.json.recurring).toMatchObject({ frequency: "monthly", active: true, nextDate: nextMonth, lastError: null });

    const g = await api("GET", `/api/groups/${gid}`);
    expect(g.json.bills.map((b: { date: string }) => b.date)).toEqual([first(2), first(1), first(0)]);
    for (const b of g.json.bills) expect(b.recurrenceId).toBe(r.json.recurring.id);

    // reading repeatedly (group, summary, list) never adds bills
    for (let i = 0; i < 3; i++) {
      expect((await api("GET", `/api/groups/${gid}`)).json.bills).toHaveLength(3);
      await summary(gid);
      await api("GET", `/api/groups/${gid}/recurring`);
    }

    // 3 x 30000 paid by Ann, 10000 each per month: Ann +60000, Ben -30000, Cat -30000
    const s = await summary(gid);
    expect(s.total).toBe(90000);
    expect(s.byCategory).toEqual({ lodging: 90000 });
    expect(by(s)[Ann]).toEqual({ memberId: Ann, paid: 90000, owed: 30000, net: 60000 });
    expect(by(s)[Ben]).toEqual({ memberId: Ben, paid: 0, owed: 30000, net: -30000 });
    expect(by(s)[Cat]).toEqual({ memberId: Cat, paid: 0, owed: 30000, net: -30000 });
    expect(sorted(s.settlements)).toEqual(sorted([
      { from: Ben, to: Ann, amount: 30000 },
      { from: Cat, to: Ann, amount: 30000 },
    ]));

    // while the series is active the people in it cannot be removed
    expect((await api("DELETE", `/api/groups/${gid}/members/${Cat}`)).status).toBe(409);

    // stop: the three created bills stay, nothing new appears
    expect((await api("DELETE", `/api/groups/${gid}/recurring/${r.json.recurring.id}`)).status).toBe(204);
    expect((await api("GET", `/api/groups/${gid}`)).json.bills).toHaveLength(3);
    const list = (await api("GET", `/api/groups/${gid}/recurring`)).json.recurring;
    expect(list).toHaveLength(1);
    expect(list[0].active).toBe(false);
    expect((await api("DELETE", `/api/groups/${gid}/recurring/${r.json.recurring.id}`)).status).toBe(404);

    const act = (await api("GET", `/api/groups/${gid}/activity?limit=100`)).json.activity as { action: string }[];
    expect(act.filter((a) => a.action === "bill.recurring")).toHaveLength(3);
    expect(act.some((a) => a.action === "recurring.create")).toBe(true);
    expect(act.some((a) => a.action === "recurring.stop")).toBe(true);
  });

  it("a series starting next week creates nothing yet", async () => {
    const { gid, ids } = await makeGroup(["Ann", "Ben"]);
    const r = await api("POST", `/api/groups/${gid}/recurring`, {
      frequency: "weekly",
      startDate: isoDay(new Date(Date.now() + 7 * DAY)),
      bill: { description: "Cleaner", amount: 500, paidBy: ids.Ann, split: equal([ids.Ann, ids.Ben]) },
    });
    expect(r.status, r.text).toBe(201);
    expect(r.json.created).toBe(0);
    expect((await api("GET", `/api/groups/${gid}`)).json.bills).toEqual([]);
  });
});
