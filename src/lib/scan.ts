// Receipt scan (v0.11, #2): a receipt photo → suggested bill fields, via a vision model on Workers AI. The model's
// answer is untrusted text: everything is re-validated here and only suggestions go back (the person checks them
// in the bill dialog before saving).
import { CATEGORIES, LIMITS, type Category } from "./validate";
import { itemizedTotal } from "./split";

export const SCAN_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

// The model fills every field (JSON-schema decoding skips optional ones, so all are required; "" / [] = not on the
// receipt). Dates are copied as printed and converted here (Buddhist-era years, 2-digit years, 年月日, US M/D).
export const PROMPT = `You read photos of shop and restaurant receipts. Copy what is printed; never guess or calculate.
- merchant: the shop or restaurant name (usually the top line)
- date: the purchase date exactly as printed (e.g. "28/10/2026", "27/10/2569", "2026年10月26日", "10/25/2026"); "" if none
- currency: ISO 4217 code from the symbol, words or country (฿, บาท, Thai text → THB; ¥, 円, Japanese text → JPY; $ in the US → USD)
- total: the final amount paid (the last and biggest total), digits and a dot only
- subtotal: the sum of the items before service and tax, if printed; else ""
- service: service charge or tip amount, if printed; else ""
- tax_added: tax ADDED on top of the subtotal (e.g. "VAT 7%" or "Tax" lines that increase the total); "" when tax is included in the prices ("VAT included", 内消費税) or there is none
- category: the best fit of ${CATEGORIES.join(", ")} (restaurants, cafes, bars, street food → food; supermarkets, convenience stores → groceries)
- items: every purchased line with its line price (quantity × unit price, as printed at the right). Leave out totals, subtotals, tax, service, discounts, payment (cash, card, change) lines.
Amounts: digits with an optional decimal point, no currency signs, no thousands separators.`;

const amountField = { type: "string" };
const SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string" },
    date: { type: "string" },
    currency: { type: "string" },
    total: amountField,
    subtotal: amountField,
    service: amountField,
    tax_added: amountField,
    category: { type: "string", enum: [...CATEGORIES] },
    items: { type: "array", items: { type: "object", properties: { name: { type: "string" }, price: amountField }, required: ["name", "price"] } },
  },
  required: ["merchant", "date", "currency", "total", "subtotal", "service", "tax_added", "category", "items"],
};

/** What the dialog gets: every field optional. Amounts in minor units of the trip currency (fx: of `fx.currency`). */
export interface ReceiptScan {
  description?: string;
  amount?: number;
  date?: string;
  category?: Category;
  fx?: { currency: string; amount: number };
  /** Only when they (plus service and tax) add up to the printed total. */
  items?: { description: string; amount: number }[];
  /** With items: service charge / tip and added tax as the itemized split's basis points (tax on top of service). */
  serviceBp?: number;
  taxBp?: number;
}

export function fractionDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** "1,234.50" / "1234" / "45.9" → minor units; null when it isn't a plain positive amount. */
export function toMinor(v: unknown, currency: string): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).replace(/[,\s]/g, "");
  const d = fractionDigits(currency);
  const m = s.match(/^(\d{1,12})(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  const frac = (m[2] ?? "").slice(0, d).padEnd(d, "0");
  const n = Number(m[1]) * 10 ** d + (d ? Number(frac) : 0);
  return Number.isSafeInteger(n) && n > 0 && n <= LIMITS.amountMax ? n : null;
}

const clean = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max) || undefined : undefined;

const iso = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
};

/**
 * A date as printed on a receipt → YYYY-MM-DD, or null. Handles YYYY-MM-DD, D/M/Y (Thai, European), M/D/Y when the day
 * can't be a month (or `usd`), 2-digit years, Buddhist-era years (2569 → 2026), 2026年10月26日. Never in the future
 * (a day of slack for time zones) and not before 2000.
 */
export function parseReceiptDate(raw: unknown, today: string, usd = false): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const year = (y: number) => {
    if (y < 100) y += 2000;
    if (y > 2400) y -= 543; // Buddhist era
    return y;
  };
  let out: string | null = null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/))) out = iso(year(+m[1]), +m[2], +m[3]);
  else if ((m = s.match(/(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{2,4})/))) {
    const [a, b, y] = [+m[1], +m[2], year(+m[3])];
    // Day first, unless that can't be (13+ as a month) or it's a US receipt with a valid month first.
    out = (usd && a <= 12) || b > 12 ? iso(y, a, b) : iso(y, b, a);
    if (y > 2100) out = null;
    // 2-digit Buddhist-era years ("29/10/69") read as 2069 above: try them as BE.
    if (out && out > today && +m[3] < 100) out = iso(2500 + +m[3] - 543, b > 12 ? a : b, b > 12 ? b : a);
  }
  if (!out) return null;
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return out >= "2000-01-01" && out <= tomorrow ? out : null;
}

/** The model's JSON (or a string of it) → safe suggestions for a trip in `tripCurrency`. */
export function normalizeScan(raw: unknown, tripCurrency: string, today: string): ReceiptScan {
  let o = raw;
  if (typeof o === "string") {
    try {
      o = JSON.parse(o.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {
      return {};
    }
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return {};
  const r = o as Record<string, unknown>;
  const out: ReceiptScan = {};
  const description = clean(r.merchant, LIMITS.descriptionMax);
  if (description) out.description = description;
  const cur = typeof r.currency === "string" && /^[A-Za-z]{3}$/.test(r.currency.trim()) ? r.currency.trim().toUpperCase() : tripCurrency;
  const total = toMinor(r.total, cur);
  if (total !== null) {
    if (cur === tripCurrency) out.amount = total;
    else out.fx = { currency: cur, amount: total };
  }
  const date = parseReceiptDate(r.date, today, cur === "USD");
  if (date) out.date = date;
  if (typeof r.category === "string" && (CATEGORIES as readonly string[]).includes(r.category)) out.category = r.category as Category;

  // Items only in the trip's own currency (itemized splits don't take fx), and only when they rebuild the printed
  // total — items + service + tax, the way the itemized split computes it — or the dialog would show a wrong amount.
  if (Array.isArray(r.items) && cur === tripCurrency && total !== null) {
    const items = r.items.slice(0, LIMITS.itemsPerBill).flatMap((it) => {
      if (typeof it !== "object" || it === null) return [];
      const name = clean((it as Record<string, unknown>).name, LIMITS.descriptionMax);
      const amount = toMinor((it as Record<string, unknown>).price, cur);
      return name && amount !== null ? [{ description: name, amount }] : [];
    });
    const sub = items.reduce((a, it) => a + it.amount, 0);
    const service = toMinor(r.service, cur) ?? 0;
    const tax = toMinor(r.tax_added, cur) ?? 0;
    if (items.length > 1 && sub > 0) {
      const serviceBp = Math.round((service / sub) * 10_000);
      const taxBp = Math.round((tax / (sub + service)) * 10_000);
      const rebuilt = itemizedTotal(sub, serviceBp, taxBp);
      if (Math.abs(rebuilt - total) <= 2 && serviceBp <= 10_000 && taxBp <= 10_000) {
        out.items = items;
        if (serviceBp) out.serviceBp = serviceBp;
        if (taxBp) out.taxBp = taxBp;
      }
    }
  }
  return out;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Canned answer for local dev and tests (`SCAN_FAKE=1`; never set on prod): no AI calls, no account needed. */
const FAKE = {
  merchant: "Som Tam Nua", date: "28/10/2569", currency: "THB", total: "288.37", subtotal: "245.00", service: "24.50", tax_added: "18.87",
  category: "food", items: [{ name: "Som tam", price: "120.00" }, { name: "Grilled chicken", price: "125.00" }],
};

/** Runs the model on one image; returns its raw answer (normalizeScan turns it into suggestions). */
export async function runScan(env: { AI?: Ai; SCAN_FAKE?: string }, bytes: Uint8Array, type: string): Promise<unknown> {
  if (env.SCAN_FAKE === "1") return FAKE;
  if (!env.AI) throw new Error("receipt scanning is not set up");
  const out = (await env.AI.run(SCAN_MODEL, scanRequest(bytes, type) as never)) as { response?: unknown };
  return out?.response ?? out;
}

/** The model request (exported for the prompt lab in scripts/scan-lab). */
export function scanRequest(bytes: Uint8Array, type: string, prompt = PROMPT) {
  return {
    messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:${type};base64,${base64(bytes)}` } }] }],
    response_format: { type: "json_schema", json_schema: SCHEMA },
    max_tokens: 1024,
    temperature: 0,
  };
}
