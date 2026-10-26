import { describe, expect, it } from "vitest";
import { computeBalances, computeSettlements, splitEqual } from "../../src/lib/money";

describe("splitEqual", () => {
  it("splits evenly", () => {
    expect(splitEqual(900, ["a", "b", "c"])).toEqual([
      { memberId: "a", amount: 300 },
      { memberId: "b", amount: 300 },
      { memberId: "c", amount: 300 },
    ]);
  });
  it("gives remainder cents to first members in order", () => {
    expect(splitEqual(1000, ["a", "b", "c"]).map((s) => s.amount)).toEqual([334, 333, 333]);
    expect(splitEqual(1001, ["c", "b", "a"]).map((s) => s.amount)).toEqual([334, 334, 333]);
  });
  it("always sums to the amount", () => {
    for (let amt = 1; amt < 500; amt += 7)
      for (let n = 1; n <= 9; n++) {
        const ids = Array.from({ length: n }, (_, i) => `m${i}`);
        expect(splitEqual(amt, ids).reduce((a, s) => a + s.amount, 0)).toBe(amt);
      }
  });
  it("handles amount smaller than member count", () => {
    expect(splitEqual(2, ["a", "b", "c"]).map((s) => s.amount)).toEqual([1, 1, 0]);
  });
  it("throws on no members", () => {
    expect(() => splitEqual(100, [])).toThrow();
  });
});

describe("computeBalances", () => {
  it("nets paid minus owed", () => {
    const b = computeBalances(
      ["a", "b", "c"],
      [{ paidBy: "a", amount: 900, shares: splitEqual(900, ["a", "b", "c"]) }],
    );
    expect(b).toEqual([
      { memberId: "a", paid: 900, owed: 300, net: 600 },
      { memberId: "b", paid: 0, owed: 300, net: -300 },
      { memberId: "c", paid: 0, owed: 300, net: -300 },
    ]);
  });
  it("sums to zero across members", () => {
    const b = computeBalances(
      ["a", "b", "c", "d"],
      [
        { paidBy: "a", amount: 1001, shares: splitEqual(1001, ["a", "b", "c"]) },
        { paidBy: "d", amount: 250, shares: [{ memberId: "b", amount: 250 }] },
      ],
    );
    expect(b.reduce((a, x) => a + x.net, 0)).toBe(0);
  });
  it("payments change net only, not paid/owed", () => {
    const b = computeBalances(
      ["a", "b"],
      [
        { paidBy: "a", amount: 1000, shares: splitEqual(1000, ["a", "b"]) },
        { kind: "payment", paidBy: "b", amount: 500, shares: [{ memberId: "a", amount: 500 }] },
      ],
    );
    expect(b).toEqual([
      { memberId: "a", paid: 1000, owed: 500, net: 0 },
      { memberId: "b", paid: 0, owed: 500, net: 0 },
    ]);
  });
  it("partial payment leaves the remainder outstanding", () => {
    const b = computeBalances(
      ["a", "b"],
      [
        { paidBy: "a", amount: 1000, shares: [{ memberId: "b", amount: 1000 }] },
        { kind: "payment", paidBy: "b", amount: 300, shares: [{ memberId: "a", amount: 300 }] },
      ],
    );
    expect(b.map((x) => x.net)).toEqual([700, -700]);
    expect(b.map((x) => x.paid)).toEqual([1000, 0]);
  });
  it("includes members with no activity", () => {
    expect(computeBalances(["a"], [])).toEqual([{ memberId: "a", paid: 0, owed: 0, net: 0 }]);
  });
});

describe("computeSettlements", () => {
  const bal = (net: Record<string, number>) =>
    Object.entries(net).map(([memberId, n]) => ({ memberId, paid: 0, owed: 0, net: n }));

  it("returns nothing when settled", () => {
    expect(computeSettlements(bal({ a: 0, b: 0 }))).toEqual([]);
  });
  it("one debtor one creditor", () => {
    expect(computeSettlements(bal({ a: 500, b: -500 }))).toEqual([{ from: "b", to: "a", amount: 500 }]);
  });
  it("uses at most n-1 transfers and fully settles", () => {
    const balances = bal({ a: 600, b: -300, c: -200, d: -100, e: 0 });
    const s = computeSettlements(balances);
    expect(s.length).toBeLessThanOrEqual(4);
    const net = Object.fromEntries(balances.map((b) => [b.memberId, b.net]));
    for (const t of s) {
      net[t.from] += t.amount;
      net[t.to] -= t.amount;
      expect(t.amount).toBeGreaterThan(0);
    }
    expect(Object.values(net).every((v) => v === 0)).toBe(true);
  });
  it("is deterministic for ties", () => {
    const a = computeSettlements(bal({ x: 100, y: 100, p: -100, q: -100 }));
    const b = computeSettlements(bal({ q: -100, p: -100, y: 100, x: 100 }));
    expect(a).toEqual(b);
  });
  it("random fuzz: always settles to zero", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let iter = 0; iter < 200; iter++) {
      const ids = Array.from({ length: 2 + Math.floor(rnd() * 8) }, (_, i) => `m${i}`);
      const bills = Array.from({ length: 1 + Math.floor(rnd() * 10) }, () => {
        const amount = 1 + Math.floor(rnd() * 100000);
        const sharers = ids.filter(() => rnd() > 0.4);
        const who = sharers.length ? sharers : [ids[0]];
        return { paidBy: ids[Math.floor(rnd() * ids.length)], amount, shares: splitEqual(amount, who) };
      });
      const balances = computeBalances(ids, bills);
      const net = Object.fromEntries(balances.map((b) => [b.memberId, b.net]));
      const s = computeSettlements(balances);
      expect(s.length).toBeLessThanOrEqual(ids.length - 1);
      for (const t of s) {
        net[t.from] += t.amount;
        net[t.to] -= t.amount;
      }
      expect(Object.values(net).every((v) => v === 0)).toBe(true);
    }
  });
});
