// Currency formatting/parsing in integer minor units.
import { lang, locale } from "./i18n";

export const CURRENCIES = [
  "THB", "USD", "EUR", "GBP", "JPY", "SGD", "MYR", "IDR", "VND", "PHP", "KRW", "CNY",
  "HKD", "TWD", "INR", "AUD", "NZD", "CAD", "CHF", "SEK", "NOK", "DKK",
];

const REGION_CURRENCY: Record<string, string> = {
  TH: "THB", US: "USD", GB: "GBP", JP: "JPY", SG: "SGD", MY: "MYR", ID: "IDR", VN: "VND", PH: "PHP",
  KR: "KRW", CN: "CNY", HK: "HKD", TW: "TWD", IN: "INR", AU: "AUD", NZ: "NZD", CA: "CAD", CH: "CHF",
  SE: "SEK", NO: "NOK", DK: "DKK", DE: "EUR", FR: "EUR", ES: "EUR", IT: "EUR", NL: "EUR", IE: "EUR",
};

export function defaultCurrency(): string {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region ?? "";
    return REGION_CURRENCY[region] ?? "USD";
  } catch {
    return "USD";
  }
}

export function fractionDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

const fmtCache = new Map<string, Intl.NumberFormat>();
/**
 * `narrowSymbol` (฿1,250.00, $12.00) reads best for the trip's own currency. Use `code` (USD 12.00) wherever two
 * currencies appear together (fx), since narrow symbols are ambiguous ($ = USD, SGD, AUD…).
 */
export function formatMoney(minor: number, currency: string, display: "narrowSymbol" | "code" = "narrowSymbol"): string {
  const ck = `${lang()}|${currency}|${display}`;
  let f = fmtCache.get(ck);
  if (!f) {
    f = new Intl.NumberFormat(locale(), { style: "currency", currency, currencyDisplay: display });
    fmtCache.set(ck, f);
  }
  return f.format(minor / 10 ** fractionDigits(currency));
}

/** Minor units → plain decimal string for inputs (e.g. 1234 → "12.34"). */
export function toInput(minor: number, currency: string): string {
  const d = fractionDigits(currency);
  if (d === 0) return String(minor);
  const s = String(Math.abs(minor)).padStart(d + 1, "0");
  return `${minor < 0 ? "-" : ""}${s.slice(0, -d)}.${s.slice(-d)}`;
}

/** Parses a user-typed decimal into minor units without float error. Returns null if invalid. */
export function parseMoney(input: string, currency: string): number | null {
  const d = fractionDigits(currency);
  const s = input.trim().replace(/[,\s]/g, "");
  const re = d === 0 ? /^\d+$/ : new RegExp(`^(\\d+)(?:\\.(\\d{0,${d}}))?$|^\\.(\\d{1,${d}})$`);
  const m = s.match(re);
  if (!m) return null;
  if (d === 0) return Number(s);
  const whole = m[1] ?? "0";
  const frac = (m[2] ?? m[3] ?? "").padEnd(d, "0");
  const n = Number(whole) * 10 ** d + Number(frac || "0");
  return Number.isSafeInteger(n) ? n : null;
}

/** Same split as the server: remainder units to first members in order. */
export function splitEqual(amount: number, ids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const base = Math.floor(amount / ids.length);
  const rem = amount - base * ids.length;
  ids.forEach((id, i) => out.set(id, base + (i < rem ? 1 : 0)));
  return out;
}
