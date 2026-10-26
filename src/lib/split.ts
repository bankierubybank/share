// Allocation math for shares / percent / itemized splits and currency conversion.
// Pure and shared by Worker and browser (web imports this file). Integer minor units only.

import { splitEqual } from "./money";

/**
 * Largest-remainder allocation: splits `total` proportionally to `weights` so the parts sum to
 * exactly `total`. Leftover units go to the largest fractional remainders; ties → earlier index.
 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, w) => a + BigInt(w), 0n);
  if (sum <= 0n) throw new Error("allocate: weights must sum to > 0");
  const t = BigInt(total);
  const parts = weights.map((w) => (t * BigInt(w)) / sum);
  const rems = weights.map((w, i) => ({ i, r: (t * BigInt(w)) % sum }));
  let left = Number(t - parts.reduce((a, p) => a + p, 0n));
  rems.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (const { i } of rems) {
    if (left <= 0) break;
    if (weights[i] === 0) continue;
    parts[i] += 1n;
    left--;
  }
  return parts.map(Number);
}

export interface Item {
  description: string;
  amount: number;
  members: string[];
}

/** Service then tax, compounding (Thai receipts: VAT applies on top of service charge). Basis points. */
export function itemizedTotal(subtotal: number, serviceBp: number, taxBp: number): number {
  const num = BigInt(subtotal) * BigInt(10000 + serviceBp) * BigInt(10000 + taxBp);
  const den = 100_000_000n;
  return Number((num * 2n + den) / (den * 2n)); // round half up
}

/** Per-member shares of an itemized bill. Returns total and shares in first-seen member order. */
export function splitItemized(items: Item[], serviceBp: number, taxBp: number) {
  const sub = new Map<string, number>();
  for (const it of items) for (const s of splitEqual(it.amount, it.members)) sub.set(s.memberId, (sub.get(s.memberId) ?? 0) + s.amount);
  const subtotal = items.reduce((a, it) => a + it.amount, 0);
  const total = itemizedTotal(subtotal, serviceBp, taxBp);
  const ids = [...sub.keys()];
  const parts = allocate(total, ids.map((id) => sub.get(id)!));
  return { subtotal, total, shares: ids.map((memberId, i) => ({ memberId, amount: parts[i] })) };
}

/** Rates are decimal strings with up to 8 fractional digits, e.g. "36.25" (1 unit of original = 36.25 group). */
export const RATE_RE = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,8})?$/;

/** Converts original minor units → group minor units, round half up. */
export function convertAmount(originalMinor: number, fromDigits: number, toDigits: number, rate: string): number {
  if (!RATE_RE.test(rate)) throw new Error("invalid rate");
  const [w, f = ""] = rate.split(".");
  const r = BigInt(w + f.padEnd(8, "0")); // rate × 1e8
  const num = BigInt(originalMinor) * r * 10n ** BigInt(toDigits);
  const den = 10n ** BigInt(fromDigits) * 100_000_000n;
  return Number((num * 2n + den) / (den * 2n));
}

export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}
