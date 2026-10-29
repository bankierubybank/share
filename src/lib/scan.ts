// Receipt scan (v0.11, #2): a receipt photo → suggested bill fields, via a vision model on Workers AI. The model's
// answer is untrusted text: everything is re-validated here and only suggestions go back (the person checks them
// in the bill dialog before saving).
import { CATEGORIES, LIMITS, type Category } from "./validate";

export const SCAN_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

const PROMPT = `You read shop receipts. Reply with JSON only:
- merchant: the shop or restaurant name
- total: the grand total actually paid, as digits with an optional decimal point (no currency sign, no thousands separators)
- currency: ISO 4217 code, from the symbol, words or country on the receipt (฿ or บาท → THB, ¥/円 → JPY)
- date: the purchase date as YYYY-MM-DD, only if printed
- category: one of ${CATEGORIES.join(", ")}
- items: each purchased line: name and price (digits)
Leave out anything you can't read. Never invent values.`;

const SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string" },
    total: { type: "string" },
    currency: { type: "string" },
    date: { type: "string" },
    category: { type: "string", enum: [...CATEGORIES] },
    items: { type: "array", items: { type: "object", properties: { name: { type: "string" }, price: { type: "string" } }, required: ["name", "price"] } },
  },
  required: ["total"],
};

/** What the dialog gets: every field optional. Amounts in minor units of the trip currency (fx: of `fx.currency`). */
export interface ReceiptScan {
  description?: string;
  amount?: number;
  date?: string;
  category?: Category;
  fx?: { currency: string; amount: number };
  items?: { description: string; amount: number }[];
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
  // A printed date, not in the future (a day of slack for time zones) and not absurdly old.
  if (typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.date >= "2000-01-01") {
    const d = new Date(`${r.date}T00:00:00Z`);
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === r.date && r.date <= tomorrow) out.date = r.date;
  }
  if (typeof r.category === "string" && (CATEGORIES as readonly string[]).includes(r.category)) out.category = r.category as Category;
  // Items only in the trip's own currency (itemized splits don't take fx).
  if (Array.isArray(r.items) && cur === tripCurrency) {
    const items = r.items.slice(0, LIMITS.itemsPerBill).flatMap((it) => {
      if (typeof it !== "object" || it === null) return [];
      const name = clean((it as Record<string, unknown>).name, LIMITS.descriptionMax);
      const amount = toMinor((it as Record<string, unknown>).price, cur);
      return name && amount !== null ? [{ description: name, amount }] : [];
    });
    if (items.length) out.items = items;
  }
  return out;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Canned answer for local dev and tests (`SCAN_FAKE=1`; never set on prod): no AI calls, no account needed. */
const FAKE = { merchant: "Som Tam Nua", total: "245.00", currency: "THB", date: "2026-10-28", category: "food", items: [{ name: "Som tam", price: "120" }, { name: "Grilled chicken", price: "125" }] };

/** Runs the model on one image; returns its raw answer (normalizeScan turns it into suggestions). */
export async function runScan(env: { AI?: Ai; SCAN_FAKE?: string }, bytes: Uint8Array, type: string): Promise<unknown> {
  if (env.SCAN_FAKE === "1") return FAKE;
  if (!env.AI) throw new Error("receipt scanning is not set up");
  const out = (await env.AI.run(SCAN_MODEL, {
    messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: `data:${type};base64,${base64(bytes)}` } }] }],
    response_format: { type: "json_schema", json_schema: SCHEMA },
    max_tokens: 1024,
    temperature: 0,
  } as never)) as { response?: unknown };
  return out?.response ?? out;
}
