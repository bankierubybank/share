import { describe, expect, it } from "vitest";
import { normalizeScan, parseReceiptDate, toMinor } from "../../src/lib/scan";

// v0.11 receipt scan: the model's answer is untrusted text — only clean suggestions may come out.

describe("toMinor", () => {
  it("plain amounts in the currency's minor units", () => {
    expect(toMinor("245.00", "THB")).toBe(24500);
    expect(toMinor("1,234.5", "THB")).toBe(123450);
    expect(toMinor(" 12 ", "USD")).toBe(1200);
    expect(toMinor("1800", "JPY")).toBe(1800);
    expect(toMinor("1800.40", "JPY")).toBe(1800); // JPY has no decimals
    expect(toMinor(99.9, "EUR")).toBe(9990);
  });
  it("rejects anything else", () => {
    for (const v of ["", "abc", "-5", "0", "0.00", "฿245", "1e5", "12.3.4", null, undefined, {}, "9".repeat(13)]) expect(toMinor(v, "THB"), String(v)).toBeNull();
  });
});

describe("normalizeScan", () => {
  const today = "2026-10-29";
  it("trip currency: amount, items, date, category; strings and code fences are parsed", () => {
    const raw = '```json\n{"merchant":"  Café\\u0007 Amazon ","total":"89.00","currency":"thb","date":"2026-10-28","category":"food","items":[{"name":"Latte","price":"65"},{"name":"Cookie","price":"24"}]}\n```';
    expect(normalizeScan(raw, "THB", today)).toEqual({
      description: "Café Amazon", amount: 8900, date: "2026-10-28", category: "food",
      items: [{ description: "Latte", amount: 6500 }, { description: "Cookie", amount: 2400 }],
    });
  });
  it("another currency → fx suggestion, no items, no trip-currency amount", () => {
    expect(normalizeScan({ total: "1,800", currency: "JPY", items: [{ name: "Ramen", price: "1800" }] }, "THB", today)).toEqual({ fx: { currency: "JPY", amount: 1800 } });
  });
  it("drops bad dates, unknown categories, junk items and non-objects", () => {
    const r = normalizeScan({ total: "10", date: "2026-11-05", category: "weapons", items: [{ name: "", price: "1" }, { name: "X", price: "free" }, "str", null] }, "USD", today);
    expect(r).toEqual({ amount: 1000 });
    expect(normalizeScan({ total: "10", date: "1999-12-31" }, "USD", today).date).toBeUndefined();
    expect(normalizeScan({ total: "10", date: "2026-02-30" }, "USD", today).date).toBeUndefined();
    expect(normalizeScan({ total: "10", date: "2026-10-30" }, "USD", today).date).toBe("2026-10-30"); // a day of slack
    for (const raw of ["not json", "[1,2]", null, 42, []]) expect(normalizeScan(raw, "USD", today)).toEqual({});
  });
  it("bounds lengths (description ≤ 120) and item count", () => {
    const r = normalizeScan({ merchant: "M".repeat(500), total: "100", items: Array.from({ length: 300 }, (_, i) => ({ name: `i${i}`, price: "1" })) }, "USD", today);
    expect(r.description).toHaveLength(120);
    expect(r.items!.length).toBeLessThanOrEqual(100);
  });
});

describe("parseReceiptDate", () => {
  const today = "2026-10-30";
  it("reads the formats receipts use", () => {
    const cases: [string, string | null, boolean?][] = [
      ["2026-10-28", "2026-10-28"], ["28/10/2026", "2026-10-28"], ["28-10-2026 19:42", "2026-10-28"], ["28.10.2026", "2026-10-28"],
      ["27/10/2569", "2026-10-27"], // Buddhist era
      ["29/10/26", "2026-10-29"], ["29/10/69", "2026-10-29"], // 2-digit, Gregorian or Buddhist era
      ["2026年10月26日 21:10", "2026-10-26"], ["2026/10/26", "2026-10-26"],
      ["10/25/2026", "2026-10-25"], // can't be D/M (no month 25)
      ["09/10/2026", "2026-09-10", true], ["09/10/2026", "2026-10-09"], // US receipts M/D, else D/M
      ["", null], ["31/02/2026", null], ["01/01/1999", null], ["05/11/2026", null] /* future */, ["soon", null],
    ];
    for (const [raw, want, usd] of cases) expect(parseReceiptDate(raw, today, usd), raw).toBe(want);
  });
});

describe("items must rebuild the printed total", () => {
  const today = "2026-10-30";
  it("service + VAT on top (Thai receipt) → basis points for the itemized split", () => {
    const r = normalizeScan({ total: "576.73", currency: "THB", service: "49.00", tax_added: "37.73",
      items: [{ name: "Tom yum", price: "250.00" }, { name: "Pad thai", price: "120.00" }, { name: "Coconut x2", price: "120.00" }] }, "THB", today);
    expect(r).toMatchObject({ amount: 57673, serviceBp: 1000, taxBp: 700 });
    expect(r.items).toHaveLength(3);
  });
  it("a missed or misread line → no items (the amount is still the total)", () => {
    const r = normalizeScan({ total: "360.00", currency: "THB", items: [{ name: "Som tam", price: "80" }, { name: "Gai yang", price: "150" }] }, "THB", today);
    expect(r).toEqual({ amount: 36000 });
  });
  it("a single line isn't worth an itemized split", () => {
    expect(normalizeScan({ total: "80", currency: "THB", items: [{ name: "Som tam", price: "80" }] }, "THB", today).items).toBeUndefined();
  });
});
