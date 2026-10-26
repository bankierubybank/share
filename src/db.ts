import type { BillInput, Fx, SplitMode } from "./lib/validate";
import type { Share } from "./lib/money";
import { entityId, groupId } from "./lib/ids";

export interface Group {
  id: string;
  name: string;
  currency: string;
  archived: boolean;
  createdAt: string;
}
export interface Member {
  id: string;
  name: string;
  promptpay: string | null;
}
export interface Bill {
  id: string;
  kind: "expense" | "payment";
  description: string;
  amount: number;
  /** First payer, kept for single-payer clients. */
  paidBy: string;
  payers: Share[];
  date: string;
  category: string;
  splitMode: SplitMode;
  split: Record<string, unknown>;
  shares: Share[];
  fx: Fx | null;
  hasReceipt: boolean;
  recurrenceId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  commentCount: number;
}
export interface Activity {
  id: string;
  at: string;
  actor: string | null;
  action: string;
  entityId: string | null;
  detail: Record<string, unknown> | null;
}
export interface Recurrence {
  id: string;
  frequency: "weekly" | "monthly";
  nextDate: string;
  active: boolean;
  lastError: string | null;
  template: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
}

interface GroupRow { id: string; name: string; currency: string; archived_at: string | null; created_at: string }
interface BillRow {
  id: string; kind: "expense" | "payment"; description: string; amount: number; paid_by: string; date: string;
  split_mode: SplitMode; split_json: string | null; category: string; original_currency: string | null;
  original_amount: number | null; fx_rate: string | null; receipt_key: string | null; recurrence_id: string | null;
  created_by: string | null; created_at: string; updated_at: string; comment_count: number;
}
interface ShareRow { bill_id: string; member_id: string; amount: number }

const BILL_COLS =
  "(SELECT count(*) FROM bill_comments c WHERE c.bill_id = b.id) AS comment_count, b.id, b.kind, b.description, b.amount, b.paid_by, b.date, b.split_mode, b.split_json, b.category, b.original_currency, b.original_amount, b.fx_rate, b.receipt_key, b.recurrence_id, b.created_by, b.created_at, b.updated_at";
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const toGroup = (r: GroupRow): Group => ({
  id: r.id, name: r.name, currency: r.currency, archived: r.archived_at !== null, createdAt: r.created_at,
});

/** Legacy rows (pre-0002) have no split_json: derive it from resolved shares. */
function splitOf(b: BillRow, shares: Share[]): Record<string, unknown> {
  if (b.split_json) return JSON.parse(b.split_json);
  return b.split_mode === "equal"
    ? { mode: "equal", members: shares.map((s) => s.memberId) }
    : { mode: "exact", shares };
}

function toBill(b: BillRow, shares: Share[], payers: Share[]): Bill {
  const p = payers.length ? payers : [{ memberId: b.paid_by, amount: b.amount }];
  return {
    id: b.id,
    kind: b.kind,
    description: b.description,
    amount: b.amount,
    paidBy: p[0].memberId,
    payers: p,
    date: b.date,
    category: b.category,
    splitMode: b.split_mode,
    split: splitOf(b, shares),
    shares,
    fx: b.original_currency && b.original_amount !== null && b.fx_rate
      ? { currency: b.original_currency, amount: b.original_amount, rate: b.fx_rate }
      : null,
    hasReceipt: b.receipt_key !== null,
    recurrenceId: b.recurrence_id,
    createdBy: b.created_by,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
    commentCount: b.comment_count ?? 0,
  };
}

// ---------- groups ----------

export async function createGroup(db: D1Database, name: string, currency: string, memberNames: string[], actor: string | null) {
  const gid = groupId();
  const members = memberNames.map((n) => ({ id: entityId(), name: n, promptpay: null }));
  await db.batch([
    db.prepare("INSERT INTO groups (id, name, currency) VALUES (?, ?, ?)").bind(gid, name, currency),
    ...members.map((m, i) =>
      db.prepare("INSERT INTO members (id, group_id, name, position) VALUES (?, ?, ?, ?)").bind(m.id, gid, m.name, i),
    ),
    logActivity(db, gid, actor, "group.create", gid, { name, members: memberNames.length }),
  ]);
  return { group: (await getGroup(db, gid))!, members };
}

export async function getGroup(db: D1Database, gid: string): Promise<Group | null> {
  const r = await db.prepare("SELECT id, name, currency, archived_at, created_at FROM groups WHERE id = ?").bind(gid).first<GroupRow>();
  return r ? toGroup(r) : null;
}

export async function updateGroup(
  db: D1Database, gid: string, patch: { name?: string; currency?: string; archived?: boolean }, actor: string | null, before: Group,
) {
  const archivedSql = patch.archived === undefined ? "archived_at" : patch.archived ? `COALESCE(archived_at, ${NOW})` : "NULL";
  const stmts = [
    db
      .prepare(`UPDATE groups SET name = COALESCE(?, name), currency = COALESCE(?, currency), archived_at = ${archivedSql} WHERE id = ?`)
      .bind(patch.name ?? null, patch.currency ?? null, gid),
  ];
  if (patch.name !== undefined && patch.name !== before.name)
    stmts.push(logActivity(db, gid, actor, "group.rename", gid, { from: before.name, to: patch.name }));
  if (patch.currency !== undefined && patch.currency !== before.currency)
    stmts.push(logActivity(db, gid, actor, "group.currency", gid, { from: before.currency, to: patch.currency }));
  if (patch.archived !== undefined && patch.archived !== before.archived)
    stmts.push(logActivity(db, gid, actor, patch.archived ? "group.archive" : "group.unarchive", gid, null));
  await db.batch(stmts);
  return getGroup(db, gid);
}

/** Hard delete (cascades). Returns receipt keys so the caller can remove them from R2. */
export async function deleteGroup(db: D1Database, gid: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT receipt_key FROM bills WHERE group_id = ? AND receipt_key IS NOT NULL")
    .bind(gid)
    .all<{ receipt_key: string }>();
  await db.prepare("DELETE FROM groups WHERE id = ?").bind(gid).run();
  return results.map((r) => r.receipt_key);
}

// ---------- members ----------

export async function listMembers(db: D1Database, gid: string): Promise<Member[]> {
  const { results } = await db
    .prepare("SELECT id, name, promptpay FROM members WHERE group_id = ? ORDER BY position, created_at")
    .bind(gid)
    .all<Member>();
  return results;
}

export async function addMember(db: D1Database, gid: string, name: string, promptpay: string | null, actor: string | null): Promise<Member> {
  const id = entityId();
  await db.batch([
    db
      .prepare(
        "INSERT INTO members (id, group_id, name, promptpay, position) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM members WHERE group_id = ?))",
      )
      .bind(id, gid, name, promptpay, gid),
    logActivity(db, gid, actor, "member.add", id, { name }),
  ]);
  return { id, name, promptpay };
}

export async function updateMember(
  db: D1Database, gid: string, mid: string, patch: { name?: string; promptpay?: string | null }, actor: string | null,
): Promise<Member | null> {
  const before = await db.prepare("SELECT id, name, promptpay FROM members WHERE id = ? AND group_id = ?").bind(mid, gid).first<Member>();
  if (!before) return null;
  const after: Member = {
    id: mid,
    name: patch.name ?? before.name,
    promptpay: patch.promptpay === undefined ? before.promptpay : patch.promptpay,
  };
  const stmts = [db.prepare("UPDATE members SET name = ?, promptpay = ? WHERE id = ? AND group_id = ?").bind(after.name, after.promptpay, mid, gid)];
  if (after.name !== before.name) stmts.push(logActivity(db, gid, actor, "member.rename", mid, { from: before.name, to: after.name }));
  if (after.promptpay !== before.promptpay) stmts.push(logActivity(db, gid, actor, "member.promptpay", mid, { name: after.name, set: after.promptpay !== null }));
  await db.batch(stmts);
  return after;
}

/** In use = on a live bill (payer or share) or in an active recurring template. Soft-deleted bills don't count. */
export async function memberInUse(db: D1Database, gid: string, mid: string): Promise<boolean> {
  const r = await db
    .prepare(
      `SELECT 1 FROM bill_payers p JOIN bills b ON b.id = p.bill_id WHERE b.group_id = ?1 AND p.member_id = ?2 AND b.deleted_at IS NULL
       UNION ALL
       SELECT 1 FROM bill_shares s JOIN bills b ON b.id = s.bill_id WHERE b.group_id = ?1 AND s.member_id = ?2 AND b.deleted_at IS NULL
       UNION ALL
       SELECT 1 FROM recurrences WHERE group_id = ?1 AND active = 1 AND instr(template, ?2) > 0
       LIMIT 1`,
    )
    .bind(gid, mid)
    .first();
  return r !== null;
}

/** Deletes a member; first purges soft-deleted bills that still reference them. Returns purged receipt keys. */
export async function deleteMember(db: D1Database, gid: string, mid: string, actor: string | null): Promise<{ ok: boolean; receiptKeys: string[] }> {
  const m = await db.prepare("SELECT name FROM members WHERE id = ? AND group_id = ?").bind(mid, gid).first<{ name: string }>();
  if (!m) return { ok: false, receiptKeys: [] };
  const refs = `SELECT b.id FROM bills b WHERE b.group_id = ?1 AND b.deleted_at IS NOT NULL AND (
      b.paid_by = ?2 OR EXISTS (SELECT 1 FROM bill_payers p WHERE p.bill_id = b.id AND p.member_id = ?2)
      OR EXISTS (SELECT 1 FROM bill_shares s WHERE s.bill_id = b.id AND s.member_id = ?2))`;
  const { results } = await db
    .prepare(`SELECT receipt_key FROM bills WHERE id IN (${refs}) AND receipt_key IS NOT NULL`)
    .bind(gid, mid)
    .all<{ receipt_key: string }>();
  await db.batch([
    db.prepare(`DELETE FROM bills WHERE id IN (${refs})`).bind(gid, mid),
    db.prepare("DELETE FROM recurrences WHERE group_id = ? AND active = 0 AND instr(template, ?) > 0").bind(gid, mid),
    db.prepare("DELETE FROM members WHERE id = ? AND group_id = ?").bind(mid, gid),
    logActivity(db, gid, actor, "member.remove", mid, { name: m.name }),
  ]);
  return { ok: true, receiptKeys: results.map((r) => r.receipt_key) };
}

export async function countRows(db: D1Database, table: "members" | "bills" | "recurrences", gid: string): Promise<number> {
  const extra = table === "bills" ? " AND deleted_at IS NULL" : table === "recurrences" ? " AND active = 1" : "";
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE group_id = ?${extra}`).bind(gid).first<{ n: number }>();
  return r?.n ?? 0;
}

// ---------- bills ----------

function groupShares(rows: ShareRow[]) {
  const by = new Map<string, Share[]>();
  for (const s of rows) {
    const list = by.get(s.bill_id) ?? [];
    list.push({ memberId: s.member_id, amount: s.amount });
    by.set(s.bill_id, list);
  }
  return by;
}

const JOIN_MEMBER = "JOIN members m ON m.id = x.member_id";
const MEMBER_ORDER = "ORDER BY m.position, m.created_at";
const ORDER_BY_MEMBER = `${JOIN_MEMBER} ${MEMBER_ORDER}`;

export async function listBills(db: D1Database, gid: string): Promise<Bill[]> {
  const live = "b.group_id = ? AND b.deleted_at IS NULL";
  const [bills, shares, payers] = await db.batch([
    db.prepare(`SELECT ${BILL_COLS} FROM bills b WHERE ${live} ORDER BY b.date DESC, b.created_at DESC`).bind(gid),
    db.prepare(`SELECT x.bill_id, x.member_id, x.amount FROM bill_shares x JOIN bills b ON b.id = x.bill_id AND ${live} ${ORDER_BY_MEMBER}`).bind(gid),
    db.prepare(`SELECT x.bill_id, x.member_id, x.amount FROM bill_payers x JOIN bills b ON b.id = x.bill_id AND ${live} ${ORDER_BY_MEMBER}`).bind(gid),
  ]);
  const s = groupShares(shares.results as ShareRow[]);
  const p = groupShares(payers.results as ShareRow[]);
  return (bills.results as BillRow[]).map((b) => toBill(b, s.get(b.id) ?? [], p.get(b.id) ?? []));
}

export async function getBill(db: D1Database, gid: string, bid: string, includeDeleted = false): Promise<Bill | null> {
  const b = await db
    .prepare(`SELECT ${BILL_COLS} FROM bills b WHERE b.id = ? AND b.group_id = ?${includeDeleted ? "" : " AND b.deleted_at IS NULL"}`)
    .bind(bid, gid)
    .first<BillRow>();
  if (!b) return null;
  const [shares, payers] = await db.batch([
    db.prepare(`SELECT x.bill_id, x.member_id, x.amount FROM bill_shares x ${JOIN_MEMBER} WHERE x.bill_id = ? ${MEMBER_ORDER}`).bind(bid),
    db.prepare(`SELECT x.bill_id, x.member_id, x.amount FROM bill_payers x ${JOIN_MEMBER} WHERE x.bill_id = ? ${MEMBER_ORDER}`).bind(bid),
  ]);
  return toBill(
    b,
    (shares.results as ShareRow[]).map((s) => ({ memberId: s.member_id, amount: s.amount })),
    (payers.results as ShareRow[]).map((s) => ({ memberId: s.member_id, amount: s.amount })),
  );
}

const childInserts = (db: D1Database, bid: string, input: BillInput) => [
  ...input.shares.map((s) =>
    db.prepare("INSERT INTO bill_shares (bill_id, member_id, amount) VALUES (?, ?, ?)").bind(bid, s.memberId, s.amount),
  ),
  ...input.payers.map((p) =>
    db.prepare("INSERT INTO bill_payers (bill_id, member_id, amount) VALUES (?, ?, ?)").bind(bid, p.memberId, p.amount),
  ),
];

const billDetail = (input: BillInput) => ({ description: input.description, amount: input.amount, kind: input.kind });

export async function createBill(
  db: D1Database, gid: string, input: BillInput, actor: string | null, recurrenceId: string | null = null,
): Promise<Bill> {
  const bid = entityId();
  await db.batch([
    db
      .prepare(
        `INSERT INTO bills (id, group_id, kind, description, amount, paid_by, date, split_mode, split_json, category,
          original_currency, original_amount, fx_rate, recurrence_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        bid, gid, input.kind, input.description, input.amount, input.payers[0].memberId, input.date, input.splitMode,
        JSON.stringify(input.split), input.category, input.fx?.currency ?? null, input.fx?.amount ?? null, input.fx?.rate ?? null,
        recurrenceId, actor,
      ),
    ...childInserts(db, bid, input),
    logActivity(db, gid, actor, recurrenceId ? "bill.recurring" : "bill.create", bid, billDetail(input)),
  ]);
  return (await getBill(db, gid, bid))!;
}

export async function updateBill(db: D1Database, gid: string, bid: string, input: BillInput, actor: string | null): Promise<Bill | null> {
  // Existence + group scope checked by caller; batch is atomic.
  await db.batch([
    db
      .prepare(
        `UPDATE bills SET kind = ?, description = ?, amount = ?, paid_by = ?, date = ?, split_mode = ?, split_json = ?, category = ?,
         original_currency = ?, original_amount = ?, fx_rate = ?, updated_at = ${NOW} WHERE id = ? AND group_id = ?`,
      )
      .bind(
        input.kind, input.description, input.amount, input.payers[0].memberId, input.date, input.splitMode, JSON.stringify(input.split),
        input.category, input.fx?.currency ?? null, input.fx?.amount ?? null, input.fx?.rate ?? null, bid, gid,
      ),
    db.prepare("DELETE FROM bill_shares WHERE bill_id = ?").bind(bid),
    db.prepare("DELETE FROM bill_payers WHERE bill_id = ?").bind(bid),
    ...childInserts(db, bid, input),
    logActivity(db, gid, actor, "bill.update", bid, billDetail(input)),
  ]);
  return getBill(db, gid, bid);
}

/** Soft delete: restorable via restoreBill until purged (30 days). */
export async function deleteBill(db: D1Database, gid: string, bid: string, actor: string | null): Promise<boolean> {
  const b = await getBill(db, gid, bid);
  if (!b) return false;
  await db.batch([
    db.prepare(`UPDATE bills SET deleted_at = ${NOW} WHERE id = ? AND group_id = ? AND deleted_at IS NULL`).bind(bid, gid),
    logActivity(db, gid, actor, "bill.delete", bid, { description: b.description, amount: b.amount, kind: b.kind }),
  ]);
  return true;
}

export async function restoreBill(db: D1Database, gid: string, bid: string, actor: string | null): Promise<Bill | null> {
  const r = await db.prepare("UPDATE bills SET deleted_at = NULL WHERE id = ? AND group_id = ? AND deleted_at IS NOT NULL").bind(bid, gid).run();
  if (!r.meta.changes) return null;
  const b = (await getBill(db, gid, bid))!;
  await logActivity(db, gid, actor, "bill.restore", bid, { description: b.description, amount: b.amount, kind: b.kind }).run();
  return b;
}

export async function deletedBillIds(db: D1Database, gid: string): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT id FROM bills WHERE group_id = ? AND deleted_at IS NOT NULL").bind(gid).all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

/** Removes soft-deleted bills older than `days`. Returns receipt keys to remove from R2. */
export async function purgeDeleted(db: D1Database, days: number): Promise<string[]> {
  const cutoff = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${Math.floor(days)} days')`;
  const { results } = await db
    .prepare(`SELECT receipt_key FROM bills WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff} AND receipt_key IS NOT NULL`)
    .all<{ receipt_key: string }>();
  await db.prepare(`DELETE FROM bills WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff}`).run();
  return results.map((r) => r.receipt_key);
}

// ---------- receipts ----------

export async function setReceipt(db: D1Database, gid: string, bid: string, key: string | null, actor: string | null): Promise<string | null> {
  const prev = await db.prepare("SELECT receipt_key, description FROM bills WHERE id = ? AND group_id = ?").bind(bid, gid).first<{ receipt_key: string | null; description: string }>();
  await db.batch([
    db.prepare("UPDATE bills SET receipt_key = ? WHERE id = ? AND group_id = ?").bind(key, bid, gid),
    logActivity(db, gid, actor, key ? "receipt.add" : "receipt.remove", bid, { description: prev?.description ?? "" }),
  ]);
  return prev?.receipt_key ?? null;
}

export async function receiptKey(db: D1Database, gid: string, bid: string): Promise<string | null> {
  const r = await db.prepare("SELECT receipt_key FROM bills WHERE id = ? AND group_id = ? AND deleted_at IS NULL").bind(bid, gid).first<{ receipt_key: string | null }>();
  return r?.receipt_key ?? null;
}

// ---------- activity ----------

export function logActivity(db: D1Database, gid: string, actor: string | null, action: string, ref: string | null, detail: unknown) {
  return db
    .prepare("INSERT INTO activity (id, group_id, actor, action, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(entityId(), gid, actor, action, ref, detail === null ? null : JSON.stringify(detail));
}

export async function listActivity(db: D1Database, gid: string, limit: number, before?: string): Promise<Activity[]> {
  const { results } = await db
    .prepare(
      `SELECT id, at, actor, action, entity_id, detail FROM activity WHERE group_id = ?${before ? " AND at < ?" : ""} ORDER BY at DESC, id DESC LIMIT ${limit}`,
    )
    .bind(...(before ? [gid, before] : [gid]))
    .all<{ id: string; at: string; actor: string | null; action: string; entity_id: string | null; detail: string | null }>();
  return results.map((r) => ({
    id: r.id, at: r.at, actor: r.actor, action: r.action, entityId: r.entity_id, detail: r.detail ? JSON.parse(r.detail) : null,
  }));
}

// ---------- recurrences ----------

interface RecRow {
  id: string; group_id: string; frequency: "weekly" | "monthly"; anchor_day: number; next_date: string; template: string;
  active: number; last_error: string | null; created_by: string | null; created_at: string;
}
const toRec = (r: RecRow): Recurrence => ({
  id: r.id, frequency: r.frequency, nextDate: r.next_date, active: r.active === 1, lastError: r.last_error,
  template: JSON.parse(r.template), createdBy: r.created_by, createdAt: r.created_at,
});

export async function listRecurrences(db: D1Database, gid: string): Promise<Recurrence[]> {
  const { results } = await db
    .prepare("SELECT * FROM recurrences WHERE group_id = ? ORDER BY active DESC, next_date")
    .bind(gid)
    .all<RecRow>();
  return results.map(toRec);
}

export async function createRecurrence(
  db: D1Database, gid: string, frequency: "weekly" | "monthly", startDate: string, template: Record<string, unknown>, actor: string | null,
): Promise<Recurrence> {
  const id = entityId();
  await db.batch([
    db
      .prepare("INSERT INTO recurrences (id, group_id, frequency, anchor_day, next_date, template, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, gid, frequency, Number(startDate.slice(8, 10)), startDate, JSON.stringify(template), actor),
    logActivity(db, gid, actor, "recurring.create", id, { description: template.description, frequency }),
  ]);
  const r = await db.prepare("SELECT * FROM recurrences WHERE id = ?").bind(id).first<RecRow>();
  return toRec(r!);
}

export async function stopRecurrence(db: D1Database, gid: string, rid: string, actor: string | null): Promise<boolean> {
  const r = await db.prepare("SELECT template FROM recurrences WHERE id = ? AND group_id = ? AND active = 1").bind(rid, gid).first<{ template: string }>();
  if (!r) return false;
  await db.batch([
    db.prepare("UPDATE recurrences SET active = 0 WHERE id = ? AND group_id = ?").bind(rid, gid),
    logActivity(db, gid, actor, "recurring.stop", rid, { description: JSON.parse(r.template).description }),
  ]);
  return true;
}

export async function dueRecurrences(db: D1Database, today: string, gid?: string): Promise<(RecRow & { anchor_day: number })[]> {
  const { results } = await db
    .prepare(
      `SELECT r.* FROM recurrences r JOIN groups g ON g.id = r.group_id
       WHERE r.active = 1 AND r.next_date <= ? AND g.archived_at IS NULL${gid ? " AND r.group_id = ?" : ""} ORDER BY r.next_date LIMIT 100`,
    )
    .bind(...(gid ? [today, gid] : [today]))
    .all<RecRow>();
  return results;
}

/** Optimistic claim of one occurrence: only one concurrent caller advances next_date. */
export async function claimOccurrence(db: D1Database, rid: string, from: string, to: string): Promise<boolean> {
  const r = await db.prepare("UPDATE recurrences SET next_date = ? WHERE id = ? AND next_date = ? AND active = 1").bind(to, rid, from).run();
  return r.meta.changes > 0;
}

export async function failRecurrence(db: D1Database, rid: string, error: string) {
  await db.prepare("UPDATE recurrences SET active = 0, last_error = ? WHERE id = ?").bind(error.slice(0, 200), rid).run();
}
