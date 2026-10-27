import { describe, expect, it } from "vitest";
import type { Bill, Group, Member, Summary } from "../../../web/src/api";
import { billsToCsv, safeFilename } from "../../../web/src/export";

const group: Group = { id: "g", name: "Trip", currency: "THB", archived: false, createdAt: "2026-01-01" };
const members: Member[] = [
  { id: "a", name: "Ann", promptpay: null, email: null },
  { id: "b", name: "Ben", promptpay: null, email: null },
];
const bill = (over: Record<string, unknown> = {}): Bill => ({
  id: "1", kind: "expense", description: "Dinner", amount: 15000, paidBy: "a", payers: [{ memberId: "a", amount: 15000 }],
  date: "2026-01-02", category: "other", splitMode: "equal", split: { mode: "equal", members: ["a", "b"] },
  shares: [{ memberId: "a", amount: 7500 }, { memberId: "b", amount: 7500 }], fx: null, hasReceipt: false,
  recurrenceId: null, createdBy: null, createdAt: "2026-01-02", updatedAt: "2026-01-02", ...over,
}) as Bill;
const summary: Summary = {
  balances: [
    { memberId: "a", paid: 15000, owed: 7500, net: 7500 },
    { memberId: "b", paid: 0, owed: 7500, net: -7500 },
  ],
  settlements: [{ from: "b", to: "a", amount: 7500 }],
  byCategory: {},
  total: 15000,
};
const csv = (bills: Bill[], s = summary, m = members) => billsToCsv({ group, members: m, bills, summary: s });

describe("billsToCsv", () => {
  it("starts with BOM and uses CRLF", () => {
    const out = csv([bill()]);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out).toContain("\r\n");
    expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("writes header, share columns and amounts", () => {
    const lines = csv([bill()]).slice(1).split("\r\n");
    expect(lines[0]).toBe("Date,Type,Category,Description,Amount,Currency,Paid by,Ann,Ben");
    expect(lines[1]).toBe("2026-01-02,Expense,Other,Dinner,150.00,THB,Ann,75.00,75.00");
  });

  it("writes payment type, balances and settlements sections", () => {
    const out = csv([bill({ kind: "payment" })]);
    expect(out).toContain(",Payment,");
    expect(out).toContain("\r\n\r\nBalances\r\nMember,Paid,Share,Net\r\nAnn,150.00,75.00,75.00\r\nBen,0.00,75.00,-75.00");
    expect(out).toContain("\r\n\r\nSettlements\r\nFrom,To,Amount\r\nBen,Ann,75.00");
  });

  it("quotes commas, quotes and newlines", () => {
    const out = csv([bill({ description: 'a, "b"\nc' })]);
    expect(out).toContain('"a, ""b""\nc"');
  });

  it("prefixes formula-like user text", () => {
    const out = csv([bill({ description: '=HYPERLINK("http://x","y")' })], summary, [
      { id: "a", name: "+cmd", promptpay: null, email: null },
      { id: "b", name: "Ben", promptpay: null, email: null },
    ]);
    expect(out).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(out).toContain(",'+cmd,Ben");
    expect(out).toContain("\r\n'+cmd,150.00");
  });

  it("prefixes other dangerous leading chars in category", () => {
    for (const c of ["-1", "@x", "\tx"]) expect(csv([bill({ category: c })])).toContain(`'${c}`);
  });

  it("keeps negative numbers unprefixed", () => {
    const out = csv([bill({ amount: -1250 })]);
    expect(out).toContain(",-12.50,THB");
    expect(out).toContain(",-75.00\r\n");
    expect(out).not.toContain("'-");
  });

  it("includes category when present", () => {
    expect(csv([bill({ category: "food" })])).toContain(",Expense,Food & drink,Dinner,");
  });

  it("formats multiple payers", () => {
    const out = csv([bill({ payers: [{ memberId: "a", amount: 10000 }, { memberId: "b", amount: 5000 }] })]);
    expect(out).toContain(",THB,Ann 100.00; Ben 50.00,75.00,75.00");
  });

  it("fills zero for members without a share", () => {
    const out = csv([bill({ shares: [{ memberId: "a", amount: 15000 }] })]);
    expect(out).toContain(",THB,Ann,150.00,0.00");
  });
});

describe("safeFilename", () => {
  it("replaces spaces and strips symbols", () => {
    expect(safeFilename("Trip to / Rome!")).toBe("Trip-to--Rome");
  });
  it("keeps unicode letters", () => {
    expect(safeFilename("ทริป เชียงใหม่")).toBe("ทริป-เชียงใหม่");
  });
  it("limits length and falls back", () => {
    expect(safeFilename("x".repeat(100))).toHaveLength(60);
    expect(safeFilename("!!!")).toBe("group");
    expect(safeFilename("")).toBe("group");
  });
});
