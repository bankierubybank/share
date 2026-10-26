import { describe, expect, it } from "vitest";
import { allocate, convertAmount, currencyDigits, itemizedTotal, splitItemized } from "../../src/lib/split";

describe("allocate", () => {
  it("proportional, sums to total", () => {
    expect(allocate(1000, [2, 1, 1])).toEqual([500, 250, 250]);
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(1, [1, 1, 1])).toEqual([1, 0, 0]);
  });
  it("leftover goes to the largest remainder", () => {
    // 1000 * 1/6 = 166.67, 2/6 = 333.33, 3/6 = 500 → 167, 333, 500
    expect(allocate(1000, [1, 2, 3])).toEqual([167, 333, 500]);
  });
  it("percent in basis points", () => {
    // 49999.5, 29999.7, 19999.8 → floors + 2 leftover to the .8 and .7 remainders
    expect(allocate(99999, [5000, 3000, 2000])).toEqual([49999, 30000, 20000]);
  });
  it("zero weight gets nothing", () => {
    expect(allocate(10, [0, 1, 1])).toEqual([0, 5, 5]);
  });
  it("handles huge amounts without float error", () => {
    const parts = allocate(100_000_000_000, [3, 3, 3]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100_000_000_000);
  });
  it("fuzz: always sums exactly", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let k = 0; k < 500; k++) {
      const w: number[] = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => Math.floor(rnd() * 1000));
      if (!w.some((x) => x > 0)) w[0] = 1;
      const total = Math.floor(rnd() * 1e9);
      const p = allocate(total, w);
      expect(p.reduce((a, b) => a + b, 0)).toBe(total);
      p.forEach((x, i) => w[i] === 0 && expect(x).toBe(0));
    }
  });
  it("rejects all-zero weights", () => {
    expect(() => allocate(10, [0, 0])).toThrow();
  });
});

describe("itemized", () => {
  it("service 10% then VAT 7% compounding", () => {
    expect(itemizedTotal(100000, 1000, 700)).toBe(117700); // 1000 → 1100 → 1177
    expect(itemizedTotal(333, 1000, 700)).toBe(392); // 391.941 → 392
  });
  it("splits items then spreads extras proportionally", () => {
    const r = splitItemized(
      [
        { description: "Pad thai", amount: 12000, members: ["a"] },
        { description: "Tom yum", amount: 24000, members: ["a", "b"] },
        { description: "Beer", amount: 9000, members: ["b", "c"] },
      ],
      1000,
      700,
    );
    expect(r.subtotal).toBe(45000);
    expect(r.total).toBe(52965);
    // subtotals a 24000, b 16500, c 4500
    expect(r.shares).toEqual([
      { memberId: "a", amount: 28248 },
      { memberId: "b", amount: 19421 },
      { memberId: "c", amount: 5296 },
    ]);
    expect(r.shares.reduce((x, s) => x + s.amount, 0)).toBe(r.total);
  });
});

describe("convertAmount", () => {
  it("USD → THB", () => {
    expect(convertAmount(1050, 2, 2, "36.25")).toBe(38063); // 10.50 × 36.25 = 380.625 → 380.63
  });
  it("JPY (0 digits) → THB", () => {
    expect(convertAmount(1000, 0, 2, "0.2345")).toBe(23450);
  });
  it("THB → JPY", () => {
    expect(convertAmount(10000, 2, 0, "4.2")).toBe(420);
  });
  it("rejects bad rates", () => {
    for (const r of ["", "abc", "-1", "1e5", "1.123456789", "01.5"]) expect(() => convertAmount(1, 2, 2, r)).toThrow();
  });
  it("currency digits", () => {
    expect(currencyDigits("THB")).toBe(2);
    expect(currencyDigits("JPY")).toBe(0);
  });
});
