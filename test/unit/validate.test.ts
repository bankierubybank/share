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
import { nextOccurrence, parseMember, parseRecurrence } from "../../src/lib/validate";
import { actorOf } from "../../src/lib/actor";
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
    const r = parseBill({ ...base, split: { mode: "equal", members: ["b", "c", "a"] } }, members, "USD");
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
      "USD",
    );
    expect(r.shares).toEqual([{ memberId: "a", amount: 1000 }]);
    expect(() =>
      parseBill({ ...base, split: { mode: "exact", shares: [{ memberId: "a", amount: 999 }] } }, members, "USD"),
    ).toThrow(/sum/);
  });
  it("rejects unknown/duplicate members and unknown payer", () => {
    expect(() => parseBill({ ...base, split: { mode: "equal", members: ["z"] } }, members, "USD")).toThrow();
    expect(() => parseBill({ ...base, split: { mode: "equal", members: ["a", "a"] } }, members, "USD")).toThrow();
    expect(() => parseBill({ ...base, paidBy: "z", split: { mode: "equal", members: ["a"] } }, members, "USD")).toThrow();
  });
  it("rejects bad mode / kind / missing split", () => {
    expect(() => parseBill({ ...base, split: { mode: "percent" } }, members, "USD")).toThrow();
    expect(() => parseBill({ ...base, kind: "refund", split: { mode: "equal", members: ["a"] } }, members, "USD")).toThrow();
    expect(() => parseBill(base, members, "USD")).toThrow();
  });
  it("payment needs exactly one receiver distinct from payer", () => {
    const ok = parseBill({ ...base, kind: "payment", split: { mode: "equal", members: ["b"] } }, members, "USD");
    expect(ok.shares).toEqual([{ memberId: "b", amount: 1000 }]);
    expect(() => parseBill({ ...base, kind: "payment", split: { mode: "equal", members: ["a"] } }, members, "USD")).toThrow();
    expect(() =>
      parseBill({ ...base, kind: "payment", split: { mode: "equal", members: ["b", "c"] } }, members, "USD"),
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

describe("parseBill v2", () => {
  const members = new Set(["a", "b", "c"]);
  const base = { description: "Dinner", amount: 1000, paidBy: "a", date: "2026-10-01" };
  const pb = (b: object, cur = "THB") => parseBill(b, members, cur);

  it("shares (weights)", () => {
    const r = pb({ ...base, split: { mode: "shares", weights: [{ memberId: "a", weight: 2 }, { memberId: "b", weight: 1 }, { memberId: "c", weight: 1 }] } });
    expect(r.shares).toEqual([{ memberId: "a", amount: 500 }, { memberId: "b", amount: 250 }, { memberId: "c", amount: 250 }]);
    expect(r.split).toEqual({ mode: "shares", weights: [{ memberId: "a", weight: 2 }, { memberId: "b", weight: 1 }, { memberId: "c", weight: 1 }] });
  });
  it("shares: zero weight excluded, all-zero rejected, non-integer rejected", () => {
    const r = pb({ ...base, split: { mode: "shares", weights: [{ memberId: "a", weight: 0 }, { memberId: "b", weight: 1 }] } });
    expect(r.shares).toEqual([{ memberId: "b", amount: 1000 }]);
    expect(() => pb({ ...base, split: { mode: "shares", weights: [{ memberId: "a", weight: 0 }] } })).toThrow();
    expect(() => pb({ ...base, split: { mode: "shares", weights: [{ memberId: "a", weight: 1.5 }] } })).toThrow();
  });
  it("percent must total 100%", () => {
    const r = pb({ ...base, split: { mode: "percent", percents: [{ memberId: "a", bp: 5000 }, { memberId: "b", bp: 3000 }, { memberId: "c", bp: 2000 }] } });
    expect(r.shares.map((s) => s.amount)).toEqual([500, 300, 200]);
    expect(() => pb({ ...base, split: { mode: "percent", percents: [{ memberId: "a", bp: 9000 }] } })).toThrow(/100%/);
  });
  it("itemized computes amount; mismatched amount rejected", () => {
    const split = {
      mode: "itemized",
      items: [
        { description: "Pad thai", amount: 12000, members: ["a"] },
        { description: "Tom yum", amount: 24000, members: ["a", "b"] },
      ],
      serviceBp: 1000,
      taxBp: 700,
    };
    const r = pb({ description: "Lunch", paidBy: "a", date: "2026-10-01", split });
    expect(r.amount).toBe(42372); // 36000 × 1.1 × 1.07
    expect(r.shares.reduce((x, s) => x + s.amount, 0)).toBe(42372);
    expect(() => pb({ description: "Lunch", amount: 1, paidBy: "a", date: "2026-10-01", split })).toThrow(/computed/);
    expect(() => pb({ description: "L", paidBy: "a", date: "2026-10-01", split: { ...split, items: [{ description: "x", amount: 1, members: ["z"] }] } })).toThrow();
  });
  it("multiple payers must sum to amount", () => {
    const split = { mode: "equal", members: ["a", "b"] };
    const r = pb({ description: "D", amount: 1000, date: "2026-10-01", payers: [{ memberId: "a", amount: 600 }, { memberId: "b", amount: 400 }], split });
    expect(r.payers).toEqual([{ memberId: "a", amount: 600 }, { memberId: "b", amount: 400 }]);
    expect(() => pb({ description: "D", amount: 1000, date: "2026-10-01", payers: [{ memberId: "a", amount: 600 }], split })).toThrow(/payers sum/);
    expect(() => pb({ description: "D", amount: 1000, date: "2026-10-01", payers: [{ memberId: "a", amount: 500 }, { memberId: "a", amount: 500 }], split })).toThrow(/duplicates/);
  });
  it("fx converts into group currency", () => {
    const r = pb({ description: "Taxi", paidBy: "a", date: "2026-10-01", fx: { currency: "USD", amount: 1050, rate: "36.25" }, split: { mode: "equal", members: ["a", "b"] } });
    expect(r.amount).toBe(38063);
    expect(r.fx).toEqual({ currency: "USD", amount: 1050, rate: "36.25" });
    expect(() => pb({ description: "T", paidBy: "a", date: "2026-10-01", fx: { currency: "THB", amount: 1, rate: "1" }, split: { mode: "equal", members: ["a"] } })).toThrow(/differ/);
    expect(() => pb({ description: "T", paidBy: "a", date: "2026-10-01", fx: { currency: "USD", amount: 1, rate: "0" }, split: { mode: "equal", members: ["a"] } })).toThrow(/rate/);
  });
  it("category", () => {
    expect(pb({ ...base, split: { mode: "equal", members: ["a"] } }).category).toBe("other");
    expect(pb({ ...base, category: "food", split: { mode: "equal", members: ["a"] } }).category).toBe("food");
    expect(() => pb({ ...base, category: "drugs", split: { mode: "equal", members: ["a"] } })).toThrow(/category/);
  });
  it("payments must be single payer → single receiver, equal mode", () => {
    expect(() => pb({ ...base, kind: "payment", split: { mode: "shares", weights: [{ memberId: "b", weight: 1 }] } })).toThrow();
  });
});

describe("members", () => {
  it("promptpay normalized / validated", () => {
    expect(parseMember({ name: "Ann", promptpay: "081-234-5678" }, true)).toEqual({ name: "Ann", promptpay: "0812345678" });
    expect(parseMember({ promptpay: "+66812345678" }, false)).toEqual({ promptpay: "0812345678" });
    expect(parseMember({ promptpay: null }, false)).toEqual({ promptpay: null });
    expect(() => parseMember({ promptpay: "12345" }, false)).toThrow();
    expect(() => parseMember({}, false)).toThrow();
  });
});

describe("recurrence", () => {
  it("monthly keeps anchor day, clamped", () => {
    expect(nextOccurrence("2026-01-31", "monthly", 31)).toBe("2026-02-28");
    expect(nextOccurrence("2026-02-28", "monthly", 31)).toBe("2026-03-31");
    expect(nextOccurrence("2026-12-15", "monthly", 15)).toBe("2027-01-15");
    expect(nextOccurrence("2028-01-30", "monthly", 30)).toBe("2028-02-29");
  });
  it("weekly", () => {
    expect(nextOccurrence("2026-12-29", "weekly", 29)).toBe("2027-01-05");
  });
  it("validates template against members; expenses only", () => {
    const members = new Set(["a", "b"]);
    const bill = { description: "Rent", amount: 100000, paidBy: "a", split: { mode: "equal", members: ["a", "b"] } };
    expect(parseRecurrence({ frequency: "monthly", startDate: "2026-11-01", bill }, members, "THB").template).toEqual(bill);
    expect(() => parseRecurrence({ frequency: "daily", startDate: "2026-11-01", bill }, members, "THB")).toThrow();
    expect(() => parseRecurrence({ frequency: "weekly", startDate: "2026-11-01", bill: { ...bill, paidBy: "z" } }, members, "THB")).toThrow();
    expect(() => parseRecurrence({ frequency: "weekly", startDate: "2026-11-01", bill: { ...bill, kind: "payment", split: { mode: "equal", members: ["b"] } } }, members, "THB")).toThrow();
  });
});

describe("actorOf", () => {
  const req = (h: Record<string, string>) => new Request("https://x/", { headers: h });
  const jwt = (p: object) => `x.${btoa(JSON.stringify(p)).replace(/=+$/, "")}.y`;
  it("uses Access email header, lower-cased", () => {
    expect(actorOf(req({ "Cf-Access-Authenticated-User-Email": "Ann@Example.com" }))).toBe("ann@example.com");
  });
  it("falls back to JWT email, then service token", () => {
    expect(actorOf(req({ "Cf-Access-Jwt-Assertion": jwt({ email: "b@x.io" }) }))).toBe("b@x.io");
    expect(actorOf(req({ "Cf-Access-Jwt-Assertion": jwt({ common_name: "abc.access" }) }))).toBe("service token");
  });
  it("null when nothing / garbage", () => {
    expect(actorOf(req({}))).toBeNull();
    expect(actorOf(req({ "Cf-Access-Jwt-Assertion": "not-a-jwt" }))).toBeNull();
    expect(actorOf(req({ "Cf-Access-Authenticated-User-Email": "<script>" }))).toBeNull();
  });
});
