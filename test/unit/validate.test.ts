import { describe, expect, it } from "vitest";
import {
  ValidationError,
  cleanAmount,
  cleanCurrency,
  cleanDate,
  cleanName,
  parseBill,
  parseGroupPatch,
  parseNewGroup,
} from "../../src/lib/validate";
import { ENTITY_ID_RE, GROUP_ID_RE, entityId, groupId } from "../../src/lib/ids";

describe("cleanName", () => {
  it("trims and collapses whitespace, strips control chars", () => {
    expect(cleanName("  Bob \n  Smith\u0000 ")).toBe("Bob Smith");
  });
  it("rejects empty, non-string, too long", () => {
    expect(() => cleanName("   ")).toThrow(ValidationError);
    expect(() => cleanName(5)).toThrow(ValidationError);
    expect(() => cleanName("x".repeat(61))).toThrow(ValidationError);
  });
  it("keeps unicode and html-ish text verbatim (escaping is the renderer's job)", () => {
    expect(cleanName("สมชาย <b>")).toBe("สมชาย <b>");
  });
});

describe("primitives", () => {
  it("currency", () => {
    expect(cleanCurrency("THB")).toBe("THB");
    for (const bad of ["thb", "US", "USDD", 1, null]) expect(() => cleanCurrency(bad)).toThrow();
  });
  it("amount", () => {
    expect(cleanAmount(1)).toBe(1);
    for (const bad of [0, -1, 1.5, "100", NaN, Infinity, 100_000_000_001]) expect(() => cleanAmount(bad)).toThrow();
    expect(cleanAmount(0, "x", true)).toBe(0);
  });
  it("date", () => {
    expect(cleanDate("2026-02-28")).toBe("2026-02-28");
    for (const bad of ["2026-02-30", "2026-13-01", "26-01-01", "2026/01/01", ""]) expect(() => cleanDate(bad)).toThrow();
  });
});

describe("parseNewGroup", () => {
  it("accepts valid input", () => {
    expect(parseNewGroup({ name: "Trip", currency: "EUR", members: ["A", " B "] })).toEqual({
      name: "Trip",
      currency: "EUR",
      members: ["A", "B"],
    });
  });
  it("rejects duplicate names case-insensitively", () => {
    expect(() => parseNewGroup({ name: "T", currency: "EUR", members: ["Ann", "ann"] })).toThrow(/duplicate/);
  });
  it("rejects no members / too many", () => {
    expect(() => parseNewGroup({ name: "T", currency: "EUR", members: [] })).toThrow();
    const many = Array.from({ length: 51 }, (_, i) => `m${i}`);
    expect(() => parseNewGroup({ name: "T", currency: "EUR", members: many })).toThrow();
  });
  it("rejects non-object bodies", () => {
    for (const b of [null, [], "x", 1]) expect(() => parseNewGroup(b)).toThrow(ValidationError);
  });
});

describe("parseGroupPatch", () => {
  it("requires at least one field", () => {
    expect(() => parseGroupPatch({})).toThrow();
    expect(parseGroupPatch({ name: "N" })).toEqual({ name: "N" });
  });
});

describe("parseBill", () => {
  const members = new Set(["a", "b", "c"]);
  const base = { description: "Dinner", amount: 1000, paidBy: "a", date: "2026-10-01" };

  it("equal split resolves shares in given order", () => {
    const r = parseBill({ ...base, split: { mode: "equal", members: ["b", "c", "a"] } }, members);
    expect(r.kind).toBe("expense");
    expect(r.splitMode).toBe("equal");
    expect(r.shares).toEqual([
      { memberId: "b", amount: 334 },
      { memberId: "c", amount: 333 },
      { memberId: "a", amount: 333 },
    ]);
  });
  it("exact split must sum to amount; zero shares dropped", () => {
    const r = parseBill(
      { ...base, split: { mode: "exact", shares: [{ memberId: "a", amount: 1000 }, { memberId: "b", amount: 0 }] } },
      members,
    );
    expect(r.shares).toEqual([{ memberId: "a", amount: 1000 }]);
    expect(() =>
      parseBill({ ...base, split: { mode: "exact", shares: [{ memberId: "a", amount: 999 }] } }, members),
    ).toThrow(/sum/);
  });
  it("rejects unknown/duplicate members and unknown payer", () => {
    expect(() => parseBill({ ...base, split: { mode: "equal", members: ["z"] } }, members)).toThrow();
    expect(() => parseBill({ ...base, split: { mode: "equal", members: ["a", "a"] } }, members)).toThrow();
    expect(() => parseBill({ ...base, paidBy: "z", split: { mode: "equal", members: ["a"] } }, members)).toThrow();
  });
  it("rejects bad mode / kind / missing split", () => {
    expect(() => parseBill({ ...base, split: { mode: "percent" } }, members)).toThrow();
    expect(() => parseBill({ ...base, kind: "refund", split: { mode: "equal", members: ["a"] } }, members)).toThrow();
    expect(() => parseBill(base, members)).toThrow();
  });
  it("payment needs exactly one receiver distinct from payer", () => {
    const ok = parseBill({ ...base, kind: "payment", split: { mode: "equal", members: ["b"] } }, members);
    expect(ok.shares).toEqual([{ memberId: "b", amount: 1000 }]);
    expect(() => parseBill({ ...base, kind: "payment", split: { mode: "equal", members: ["a"] } }, members)).toThrow();
    expect(() =>
      parseBill({ ...base, kind: "payment", split: { mode: "equal", members: ["b", "c"] } }, members),
    ).toThrow();
  });
});

describe("ids", () => {
  it("formats and uniqueness", () => {
    const g = new Set(Array.from({ length: 1000 }, groupId));
    expect(g.size).toBe(1000);
    for (const id of g) expect(id).toMatch(GROUP_ID_RE);
    expect(entityId()).toMatch(ENTITY_ID_RE);
  });
});
