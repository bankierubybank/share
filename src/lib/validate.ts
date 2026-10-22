import type { Share } from "./money";
import { splitEqual } from "./money";

export const LIMITS = {
  nameMax: 60,
  descriptionMax: 120,
  amountMax: 100_000_000_000,
  membersPerGroup: 50,
  billsPerGroup: 5000,
} as const;

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

export function cleanCurrency(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Z]{3}$/.test(v)) fail("currency must be a 3-letter ISO code");
  return v;
}

export function cleanAmount(v: unknown, field = "amount", allowZero = false): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) fail(`${field} must be an integer (minor units)`);
  if (v < (allowZero ? 0 : 1) || v > LIMITS.amountMax) fail(`${field} out of range`);
  return v;
}

export function cleanDate(v: unknown): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) fail("date must be YYYY-MM-DD");
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) fail("date is not a valid date");
  return v;
}

export interface NewGroupInput {
  name: string;
  currency: string;
  members: string[];
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
  return { name, currency, members };
}

export function parseGroupPatch(body: unknown): { name?: string; currency?: string } {
  if (!isObj(body)) fail("body must be an object");
  const out: { name?: string; currency?: string } = {};
  if (body.name !== undefined) out.name = cleanName(body.name);
  if (body.currency !== undefined) out.currency = cleanCurrency(body.currency);
  if (!Object.keys(out).length) fail("nothing to update");
  return out;
}

export function parseMemberName(body: unknown): string {
  if (!isObj(body)) fail("body must be an object");
  return cleanName(body.name);
}

export interface BillInput {
  kind: "expense" | "payment";
  description: string;
  amount: number;
  paidBy: string;
  date: string;
  splitMode: "equal" | "exact";
  shares: Share[];
}

/** Validates bill body and resolves split into concrete shares. `memberIds` = members of the group. */
export function parseBill(body: unknown, memberIds: ReadonlySet<string>): BillInput {
  if (!isObj(body)) fail("body must be an object");
  const kind = body.kind === undefined ? "expense" : body.kind;
  if (kind !== "expense" && kind !== "payment") fail("kind must be 'expense' or 'payment'");
  const description = cleanName(body.description, "description", LIMITS.descriptionMax);
  const amount = cleanAmount(body.amount);
  if (typeof body.paidBy !== "string" || !memberIds.has(body.paidBy)) fail("paidBy must be a member of the group");
  const paidBy = body.paidBy;
  const date = cleanDate(body.date);
  const split = body.split;
  if (!isObj(split)) fail("split is required");

  let shares: Share[];
  let splitMode: "equal" | "exact";
  if (split.mode === "equal") {
    splitMode = "equal";
    if (!Array.isArray(split.members) || split.members.length < 1) fail("split.members must be a non-empty array");
    const ids = split.members as unknown[];
    const seen = new Set<string>();
    for (const id of ids) {
      if (typeof id !== "string" || !memberIds.has(id)) fail("split.members contains an unknown member");
      if (seen.has(id)) fail("split.members contains duplicates");
      seen.add(id);
    }
    shares = splitEqual(amount, ids as string[]);
  } else if (split.mode === "exact") {
    splitMode = "exact";
    if (!Array.isArray(split.shares) || split.shares.length < 1) fail("split.shares must be a non-empty array");
    const seen = new Set<string>();
    shares = (split.shares as unknown[]).map((s) => {
      if (!isObj(s)) fail("each share must be an object");
      if (typeof s.memberId !== "string" || !memberIds.has(s.memberId)) fail("split.shares contains an unknown member");
      if (seen.has(s.memberId)) fail("split.shares contains duplicates");
      seen.add(s.memberId);
      return { memberId: s.memberId, amount: cleanAmount(s.amount, "share amount", true) };
    });
    const sum = shares.reduce((a, s) => a + s.amount, 0);
    if (sum !== amount) fail(`shares sum (${sum}) must equal amount (${amount})`);
    shares = shares.filter((s) => s.amount > 0);
    if (!shares.length) fail("at least one share must be positive");
  } else {
    fail("split.mode must be 'equal' or 'exact'");
  }

  if (kind === "payment") {
    if (shares.length !== 1) fail("a payment must have exactly one receiver");
    if (shares[0].memberId === paidBy) fail("payer and receiver must differ");
  }
  return { kind, description, amount, paidBy, date, splitMode, shares };
}
