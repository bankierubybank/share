import type { Share } from "./money";
import { splitEqual } from "./money";
import { allocate, convertAmount, currencyDigits, RATE_RE, splitItemized } from "./split";
import { normalizePromptPayId } from "./promptpay-id";
import { cleanEmail } from "./identity";

export const LIMITS = {
  nameMax: 60,
  descriptionMax: 120,
  amountMax: 100_000_000_000,
  membersPerGroup: 50,
  billsPerGroup: 5000,
  itemsPerBill: 100,
  recurrencesPerGroup: 20,
  weightMax: 10_000,
} as const;

export const CATEGORIES = ["food", "groceries", "lodging", "transport", "activities", "shopping", "utilities", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
/** A bill's category: built-in, or "c:<id>" = one of the trip's own (v0.11). */
export type BillCategory = Category | `c:${string}`;
/** Icons a trip's own category may use (v0.11). Keep in sync with CUSTOM_ICONS in web/src/categories.ts. */
export const CUSTOM_ICONS = [
  "label", "flight", "train", "local_gas_station", "local_cafe", "local_bar", "restaurant", "shopping_cart", "hotel",
  "directions_car", "local_activity", "shopping_bag", "celebration", "spa", "hiking", "beach_access", "fitness_center",
  "sports_soccer", "pets", "medical_services", "school", "sell", "bolt", "receipt",
] as const;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function fail(msg: string): never {
  throw new ValidationError(msg);
}

export function cleanName(v: unknown, field = "name", max: number = LIMITS.nameMax): string {
  if (typeof v !== "string") fail(`${field} must be a string`);
  // Collapse whitespace, strip control chars.
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (s.length < 1) fail(`${field} is required`);
  if (s.length > max) fail(`${field} must be at most ${max} characters`);
  return s;
}

export function cleanCurrency(v: unknown, field = "currency"): string {
  if (typeof v !== "string" || !/^[A-Z]{3}$/.test(v)) fail(`${field} must be a 3-letter ISO code`);
  return v;
}

export function cleanAmount(v: unknown, field = "amount", allowZero = false): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) fail(`${field} must be an integer (minor units)`);
  if (v < (allowZero ? 0 : 1) || v > LIMITS.amountMax) fail(`${field} out of range`);
  return v;
}

function cleanInt(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) fail(`${field} must be an integer ${min}–${max}`);
  return v;
}

export function cleanDate(v: unknown, field = "date"): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) fail(`${field} must be YYYY-MM-DD`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) fail(`${field} is not a valid date`);
  return v;
}

function cleanPromptPay(v: unknown): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string") fail("promptpay must be a string");
  const id = normalizePromptPayId(v);
  if (!id) fail("promptpay must be a 10-digit mobile, 13-digit ID or 15-digit e-wallet number");
  return id;
}

export interface NewGroupInput {
  name: string;
  currency: string;
  members: string[];
  /** Index of the creator in `members` (default 0). */
  me: number;
}

export function parseNewGroup(body: unknown): NewGroupInput {
  if (!isObj(body)) fail("body must be an object");
  const name = cleanName(body.name);
  const currency = cleanCurrency(body.currency);
  if (!Array.isArray(body.members)) fail("members must be an array");
  if (body.members.length < 1) fail("at least one member is required");
  if (body.members.length > LIMITS.membersPerGroup) fail(`at most ${LIMITS.membersPerGroup} members`);
  const members = body.members.map((m) => cleanName(m, "member name"));
  const seen = new Set<string>();
  for (const m of members) {
    const k = m.toLowerCase();
    if (seen.has(k)) fail(`duplicate member name: ${m}`);
    seen.add(k);
  }
  let me = 0;
  if (body.me !== undefined) {
    if (!Number.isInteger(body.me) || (body.me as number) < 0 || (body.me as number) >= members.length) fail("me must be the index of one of the members");
    me = body.me as number;
  }
  return { name, currency, members, me };
}

export interface GroupPatch {
  name?: string;
  currency?: string;
  archived?: boolean;
  /** null clears it. */
  budget?: number | null;
  /** Trip dates (v0.11), YYYY-MM-DD; null clears. */
  startDate?: string | null;
  endDate?: string | null;
}

export function parseGroupPatch(body: unknown): GroupPatch {
  if (!isObj(body)) fail("body must be an object");
  const out: GroupPatch = {};
  if (body.name !== undefined) out.name = cleanName(body.name);
  if (body.currency !== undefined) out.currency = cleanCurrency(body.currency);
  if (body.archived !== undefined) {
    if (typeof body.archived !== "boolean") fail("archived must be a boolean");
    out.archived = body.archived;
  }
  if (body.budget !== undefined) {
    if (body.budget !== null && (!Number.isSafeInteger(body.budget) || (body.budget as number) <= 0 || (body.budget as number) > LIMITS.amountMax))
      fail(`budget must be null or a positive integer of minor units ≤ ${LIMITS.amountMax}`);
    out.budget = body.budget as number | null;
  }
  for (const k of ["startDate", "endDate"] as const) {
    if (body[k] !== undefined) out[k] = body[k] === null ? null : cleanDate(body[k], k);
  }
  if (!Object.keys(out).length) fail("nothing to update");
  return out;
}

export function parseMemberName(body: unknown): string {
  if (!isObj(body)) fail("body must be an object");
  return cleanName(body.name);
}

export interface MemberInput {
  name?: string;
  promptpay?: string | null;
  /** Linked identity; null unlinks. */
  email?: string | null;
}

/** For POST (name required) and PATCH (any of name / promptpay). */
export function parseMember(body: unknown, requireName: boolean): MemberInput {
  if (!isObj(body)) fail("body must be an object");
  const out: MemberInput = {};
  if (body.name !== undefined || requireName) out.name = cleanName(body.name);
  if (body.promptpay !== undefined) out.promptpay = cleanPromptPay(body.promptpay);
  if (body.email !== undefined) {
    if (body.email === null || body.email === "") out.email = null;
    else out.email = cleanEmail(typeof body.email === "string" ? body.email.trim() : body.email) ?? fail("email must be a valid email address");
  }
  if (!Object.keys(out).length) fail("nothing to update");
  return out;
}

// ---------- bills ----------

export type SplitMode = "equal" | "exact" | "shares" | "percent" | "itemized";

export interface Fx {
  currency: string;
  amount: number;
  rate: string;
}

export interface BillInput {
  kind: "expense" | "payment";
  description: string;
  amount: number;
  payers: Share[];
  date: string;
  category: BillCategory;
  splitMode: SplitMode;
  /** Normalized split as sent (for editing). */
  split: Record<string, unknown>;
  shares: Share[];
  fx: Fx | null;
}

export function memberList(v: unknown, field: string, memberIds: ReadonlySet<string>): string[] {
  if (!Array.isArray(v) || v.length < 1) fail(`${field} must be a non-empty array`);
  const seen = new Set<string>();
  for (const id of v) {
    if (typeof id !== "string" || !memberIds.has(id)) fail(`${field} contains an unknown member`);
    if (seen.has(id)) fail(`${field} contains duplicates`);
    seen.add(id);
  }
  return v as string[];
}

function memberEntries<T>(
  v: unknown,
  field: string,
  memberIds: ReadonlySet<string>,
  value: (e: Record<string, unknown>) => T,
): { memberId: string; value: T }[] {
  if (!Array.isArray(v) || v.length < 1) fail(`${field} must be a non-empty array`);
  const seen = new Set<string>();
  return v.map((e) => {
    if (!isObj(e)) fail(`each ${field} entry must be an object`);
    if (typeof e.memberId !== "string" || !memberIds.has(e.memberId)) fail(`${field} contains an unknown member`);
    if (seen.has(e.memberId)) fail(`${field} contains duplicates`);
    seen.add(e.memberId);
    return { memberId: e.memberId, value: value(e) };
  });
}

const positive = (shares: Share[]) => shares.filter((s) => s.amount > 0);

/**
 * Validates a bill body and resolves the split into concrete shares.
 * Amount rules: itemized → computed from items; fx → converted from fx.amount; otherwise `amount`.
 * When computed, a provided `amount` must match (lets clients show the same number first).
 */
/** `customIds`: the trip's own category ids (v0.11) — "c:<id>" is accepted only for those. */
export function parseBill(body: unknown, memberIds: ReadonlySet<string>, groupCurrency: string, customIds: ReadonlySet<string> = new Set()): BillInput {
  if (!isObj(body)) fail("body must be an object");
  const kind = body.kind === undefined ? "expense" : body.kind;
  if (kind !== "expense" && kind !== "payment") fail("kind must be 'expense' or 'payment'");
  const description = cleanName(body.description, "description", LIMITS.descriptionMax);
  const date = cleanDate(body.date);
  const category = (body.category === undefined ? "other" : body.category) as BillCategory;
  const custom = typeof category === "string" && category.startsWith("c:") && customIds.has(category.slice(2));
  if (!custom && !CATEGORIES.includes(category as Category)) fail(`category must be one of ${CATEGORIES.join(", ")} or one of the trip's own`);
  const split = body.split;
  if (!isObj(split)) fail("split is required");

  // fx (multi-currency)
  let fx: Fx | null = null;
  if (body.fx !== undefined && body.fx !== null) {
    if (!isObj(body.fx)) fail("fx must be an object");
    const currency = cleanCurrency(body.fx.currency, "fx.currency");
    if (currency === groupCurrency) fail("fx.currency must differ from the group currency");
    const amount = cleanAmount(body.fx.amount, "fx.amount");
    if (typeof body.fx.rate !== "string" || !RATE_RE.test(body.fx.rate) || /^0(\.0*)?$/.test(body.fx.rate))
      fail("fx.rate must be a positive decimal string with at most 8 decimals");
    fx = { currency, amount, rate: body.fx.rate };
  }

  let amount: number;
  let shares: Share[];
  let mode: SplitMode;
  let normSplit: Record<string, unknown>;

  const computedAmount = (computed: number) => {
    if (body.amount !== undefined && body.amount !== computed) fail(`amount must equal the computed total (${computed})`);
    return cleanAmount(computed, "computed amount");
  };

  if (split.mode === "itemized") {
    if (fx) fail("itemized bills must be in the group currency");
    if (!Array.isArray(split.items) || split.items.length < 1) fail("split.items must be a non-empty array");
    if (split.items.length > LIMITS.itemsPerBill) fail(`at most ${LIMITS.itemsPerBill} items`);
    const items = split.items.map((it, i) => {
      if (!isObj(it)) fail("each item must be an object");
      return {
        description: cleanName(it.description, `item ${i + 1} description`, LIMITS.descriptionMax),
        amount: cleanAmount(it.amount, `item ${i + 1} amount`),
        members: memberList(it.members, `item ${i + 1} members`, memberIds),
      };
    });
    const serviceBp = split.serviceBp === undefined ? 0 : cleanInt(split.serviceBp, "split.serviceBp", 0, 10000);
    const taxBp = split.taxBp === undefined ? 0 : cleanInt(split.taxBp, "split.taxBp", 0, 10000);
    const r = splitItemized(items, serviceBp, taxBp);
    amount = computedAmount(r.total);
    shares = positive(r.shares);
    mode = "itemized";
    normSplit = { mode, items, serviceBp, taxBp };
  } else {
    amount = fx
      ? computedAmount(convertAmount(fx.amount, currencyDigits(fx.currency), currencyDigits(groupCurrency), fx.rate))
      : cleanAmount(body.amount);
    if (split.mode === "equal") {
      const members = memberList(split.members, "split.members", memberIds);
      shares = splitEqual(amount, members);
      mode = "equal";
      normSplit = { mode, members };
    } else if (split.mode === "exact") {
      const e = memberEntries(split.shares, "split.shares", memberIds, (x) => cleanAmount(x.amount, "share amount", true));
      shares = e.map((x) => ({ memberId: x.memberId, amount: x.value }));
      const sum = shares.reduce((a, s) => a + s.amount, 0);
      if (sum !== amount) fail(`shares sum (${sum}) must equal amount (${amount})`);
      shares = positive(shares);
      mode = "exact";
      normSplit = { mode, shares };
    } else if (split.mode === "shares") {
      const e = memberEntries(split.weights, "split.weights", memberIds, (x) => cleanInt(x.weight, "weight", 0, LIMITS.weightMax));
      if (e.every((x) => x.value === 0)) fail("at least one weight must be positive");
      const parts = allocate(amount, e.map((x) => x.value));
      shares = positive(e.map((x, i) => ({ memberId: x.memberId, amount: parts[i] })));
      mode = "shares";
      normSplit = { mode, weights: e.map((x) => ({ memberId: x.memberId, weight: x.value })) };
    } else if (split.mode === "percent") {
      const e = memberEntries(split.percents, "split.percents", memberIds, (x) => cleanInt(x.bp, "percent (bp)", 0, 10000));
      const total = e.reduce((a, x) => a + x.value, 0);
      if (total !== 10000) fail(`percents must add up to 100% (got ${total / 100}%)`);
      const parts = allocate(amount, e.map((x) => x.value));
      shares = positive(e.map((x, i) => ({ memberId: x.memberId, amount: parts[i] })));
      mode = "percent";
      normSplit = { mode, percents: e.map((x) => ({ memberId: x.memberId, bp: x.value })) };
    } else {
      fail("split.mode must be one of equal, exact, shares, percent, itemized");
    }
  }
  if (!shares.length) fail("at least one share must be positive");

  // payers
  let payers: Share[];
  if (body.payers !== undefined) {
    const e = memberEntries(body.payers, "payers", memberIds, (x) => cleanAmount(x.amount, "payer amount"));
    payers = e.map((x) => ({ memberId: x.memberId, amount: x.value }));
    const sum = payers.reduce((a, p) => a + p.amount, 0);
    if (sum !== amount) fail(`payers sum (${sum}) must equal amount (${amount})`);
  } else {
    if (typeof body.paidBy !== "string" || !memberIds.has(body.paidBy)) fail("paidBy must be a member of the group");
    payers = [{ memberId: body.paidBy, amount }];
  }

  if (kind === "payment") {
    if (mode !== "equal") fail("a payment must use split mode 'equal' with one receiver");
    if (payers.length !== 1) fail("a payment must have exactly one payer");
    if (shares.length !== 1) fail("a payment must have exactly one receiver");
    if (shares[0].memberId === payers[0].memberId) fail("payer and receiver must differ");
  }
  return { kind, description, amount, payers, date, category, splitMode: mode, split: normSplit, shares, fx };
}

// ---------- recurring ----------

export interface RecurrenceInput {
  frequency: "weekly" | "monthly";
  startDate: string;
  template: Record<string, unknown>;
}

/** Validates a recurring bill: the template is a bill body without `date`, checked against current members. */
export const RECURRENCE_BACKFILL_DAYS = 92;

/** `today` (YYYY-MM-DD, UTC) is injectable for tests. */
export function parseRecurrence(body: unknown, memberIds: ReadonlySet<string>, groupCurrency: string, today?: string, customIds?: ReadonlySet<string>): RecurrenceInput {
  if (!isObj(body)) fail("body must be an object");
  if (body.frequency !== "weekly" && body.frequency !== "monthly") fail("frequency must be 'weekly' or 'monthly'");
  const startDate = cleanDate(body.startDate, "startDate");
  // Bounded backfill: a far-past start would create hundreds of bills on the next page load.
  const days = (Date.parse(`${startDate}T00:00:00Z`) - Date.parse(`${today ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000;
  if (days < -RECURRENCE_BACKFILL_DAYS || days > 366) fail(`startDate must be within the last ${RECURRENCE_BACKFILL_DAYS} days and the next year`);
  if (!isObj(body.bill)) fail("bill is required");
  const { date: _ignored, ...template } = body.bill;
  const b = parseBill({ ...template, date: startDate }, memberIds, groupCurrency, customIds);
  if (b.kind !== "expense") fail("only expenses can repeat");
  return { frequency: body.frequency, startDate, template };
}

/** Next occurrence after `date`. Monthly keeps the anchor day, clamped to month length (31 → 28/30/31). */
export function nextOccurrence(date: string, frequency: "weekly" | "monthly", anchorDay: number): string {
  const [y, m, d] = date.split("-").map(Number);
  if (frequency === "weekly") return new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const days = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(anchorDay, days)).padStart(2, "0")}`;
}

/** Offline-queued bills: a client-made key (the queue's temporary id) so a retried create is not added twice. */
export function parseClientRef(body: unknown): string | null {
  const v = isObj(body) ? body.clientRef : undefined;
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) fail("clientRef must be 8–64 letters, digits, - or _");
  return v;
}
