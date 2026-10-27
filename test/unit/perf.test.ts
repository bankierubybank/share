import { describe, expect, it } from "vitest";
import { summarize } from "../../src/lib/summary";
import { timedD1 } from "../../src/lib/dbtiming";

describe("summarize (shared by Worker and optimistic UI)", () => {
  it("totals expenses only, by category, with balances and settlements", () => {
    const s = summarize(["a", "b"], [
      { kind: "expense", category: "food", amount: 1000, payers: [{ memberId: "a", amount: 1000 }], shares: [{ memberId: "a", amount: 500 }, { memberId: "b", amount: 500 }] },
      { kind: "expense", category: "transport", amount: 300, payers: [{ memberId: "b", amount: 300 }], shares: [{ memberId: "a", amount: 300 }] },
      { kind: "payment", category: "other", amount: 100, payers: [{ memberId: "b", amount: 100 }], shares: [{ memberId: "a", amount: 100 }] },
    ]);
    expect(s.total).toBe(1300);
    expect(s.byCategory).toEqual({ food: 1000, transport: 300 });
    expect(s.balances.find((b) => b.memberId === "a")!.net).toBe(1000 - 800 - 100);
    expect(s.settlements).toEqual([{ from: "b", to: "a", amount: 100 }]);
  });

  it("empty trip", () => {
    expect(summarize(["a"], [])).toEqual({ balances: [{ memberId: "a", paid: 0, owed: 0, net: 0 }], settlements: [], total: 0, byCategory: {} });
  });
});

describe("timedD1", () => {
  // Minimal fake: statements are plain objects; batch must receive the originals, not the wrappers.
  const fake = () => {
    const made: object[] = [];
    const stmt = (q: string): D1PreparedStatement => {
      const s = {
        q,
        bind: () => stmt(q),
        first: async () => ({ q }),
        all: async () => ({ results: [{ q }] }),
        run: async () => ({ meta: { changes: 1 } }),
        raw: async () => [[q]],
      };
      made.push(s);
      return s as unknown as D1PreparedStatement;
    };
    const db = {
      prepare: stmt,
      batch: async (xs: unknown[]) => {
        for (const x of xs) if (!made.includes(x as object)) throw new Error("wrapper leaked into batch");
        return xs.map(() => ({ results: [] }));
      },
      exec: async () => ({ count: 0, duration: 0 }),
    };
    return db as unknown as D1Database;
  };

  it("counts each round trip once and unwraps statements for batch", async () => {
    const t = timedD1(fake());
    await t.db.prepare("a").bind(1).first();
    await t.db.prepare("b").all();
    await t.db.batch([t.db.prepare("c").bind(1), t.db.prepare("d")]);
    expect(t.count()).toBe(3);
    expect(t.ms()).toBeGreaterThanOrEqual(0);
  });

  it("counts failed calls too", async () => {
    const real = fake();
    (real as unknown as { batch: () => Promise<never> }).batch = async () => { throw new Error("boom"); };
    const t = timedD1(real);
    await expect(t.db.batch([])).rejects.toThrow("boom");
    expect(t.count()).toBe(1);
  });
});
