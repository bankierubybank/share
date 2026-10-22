import type { BillInput } from "./lib/validate";
import type { Share } from "./lib/money";
import { entityId, groupId } from "./lib/ids";

export interface Group {
  id: string;
  name: string;
  currency: string;
  createdAt: string;
}
export interface Member {
  id: string;
  name: string;
}
export interface Bill {
  id: string;
  kind: "expense" | "payment";
  description: string;
  amount: number;
  paidBy: string;
  date: string;
  splitMode: "equal" | "exact";
  shares: Share[];
  createdAt: string;
}

interface GroupRow { id: string; name: string; currency: string; created_at: string }
interface BillRow {
  id: string; kind: "expense" | "payment"; description: string; amount: number;
  paid_by: string; date: string; split_mode: "equal" | "exact"; created_at: string;
}
interface ShareRow { bill_id: string; member_id: string; amount: number }

const toGroup = (r: GroupRow): Group => ({ id: r.id, name: r.name, currency: r.currency, createdAt: r.created_at });

export async function createGroup(db: D1Database, name: string, currency: string, memberNames: string[]) {
  const gid = groupId();
  const members = memberNames.map((n) => ({ id: entityId(), name: n }));
  await db.batch([
    db.prepare("INSERT INTO groups (id, name, currency) VALUES (?, ?, ?)").bind(gid, name, currency),
    ...members.map((m, i) =>
      db.prepare("INSERT INTO members (id, group_id, name, position) VALUES (?, ?, ?, ?)").bind(m.id, gid, m.name, i),
    ),
  ]);
  return { group: (await getGroup(db, gid))!, members };
}

export async function getGroup(db: D1Database, gid: string): Promise<Group | null> {
  const r = await db.prepare("SELECT id, name, currency, created_at FROM groups WHERE id = ?").bind(gid).first<GroupRow>();
  return r ? toGroup(r) : null;
}

export async function updateGroup(db: D1Database, gid: string, patch: { name?: string; currency?: string }) {
  await db
    .prepare("UPDATE groups SET name = COALESCE(?, name), currency = COALESCE(?, currency) WHERE id = ?")
    .bind(patch.name ?? null, patch.currency ?? null, gid)
    .run();
  return getGroup(db, gid);
}

export async function listMembers(db: D1Database, gid: string): Promise<Member[]> {
  const { results } = await db
    .prepare("SELECT id, name FROM members WHERE group_id = ? ORDER BY position, created_at")
    .bind(gid)
    .all<Member>();
  return results;
}

export async function addMember(db: D1Database, gid: string, name: string): Promise<Member> {
  const id = entityId();
  await db
    .prepare(
      "INSERT INTO members (id, group_id, name, position) VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM members WHERE group_id = ?))",
    )
    .bind(id, gid, name, gid)
    .run();
  return { id, name };
}

export async function renameMember(db: D1Database, gid: string, mid: string, name: string): Promise<Member | null> {
  const r = await db.prepare("UPDATE members SET name = ? WHERE id = ? AND group_id = ?").bind(name, mid, gid).run();
  return r.meta.changes ? { id: mid, name } : null;
}

export async function memberInUse(db: D1Database, gid: string, mid: string): Promise<boolean> {
  const r = await db
    .prepare(
      `SELECT 1 FROM bills WHERE group_id = ?1 AND paid_by = ?2
       UNION ALL
       SELECT 1 FROM bill_shares s JOIN bills b ON b.id = s.bill_id WHERE b.group_id = ?1 AND s.member_id = ?2
       LIMIT 1`,
    )
    .bind(gid, mid)
    .first();
  return r !== null;
}

export async function deleteMember(db: D1Database, gid: string, mid: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM members WHERE id = ? AND group_id = ?").bind(mid, gid).run();
  return r.meta.changes > 0;
}

export async function countRows(db: D1Database, table: "members" | "bills", gid: string): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE group_id = ?`).bind(gid).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function listBills(db: D1Database, gid: string): Promise<Bill[]> {
  const [bills, shares] = await db.batch([
    db
      .prepare(
        "SELECT id, kind, description, amount, paid_by, date, split_mode, created_at FROM bills WHERE group_id = ? ORDER BY date DESC, created_at DESC",
      )
      .bind(gid),
    db
      .prepare(
        `SELECT s.bill_id, s.member_id, s.amount FROM bill_shares s
         JOIN bills b ON b.id = s.bill_id JOIN members m ON m.id = s.member_id
         WHERE b.group_id = ? ORDER BY m.position, m.created_at`,
      )
      .bind(gid),
  ]);
  const byBill = new Map<string, Share[]>();
  for (const s of shares.results as ShareRow[]) {
    const list = byBill.get(s.bill_id) ?? [];
    list.push({ memberId: s.member_id, amount: s.amount });
    byBill.set(s.bill_id, list);
  }
  return (bills.results as BillRow[]).map((b) => ({
    id: b.id,
    kind: b.kind,
    description: b.description,
    amount: b.amount,
    paidBy: b.paid_by,
    date: b.date,
    splitMode: b.split_mode,
    shares: byBill.get(b.id) ?? [],
    createdAt: b.created_at,
  }));
}

export async function getBill(db: D1Database, gid: string, bid: string): Promise<Bill | null> {
  const b = await db
    .prepare(
      "SELECT id, kind, description, amount, paid_by, date, split_mode, created_at FROM bills WHERE id = ? AND group_id = ?",
    )
    .bind(bid, gid)
    .first<BillRow>();
  if (!b) return null;
  const { results } = await db
    .prepare(
      "SELECT s.bill_id, s.member_id, s.amount FROM bill_shares s JOIN members m ON m.id = s.member_id WHERE s.bill_id = ? ORDER BY m.position, m.created_at",
    )
    .bind(bid)
    .all<ShareRow>();
  return {
    id: b.id,
    kind: b.kind,
    description: b.description,
    amount: b.amount,
    paidBy: b.paid_by,
    date: b.date,
    splitMode: b.split_mode,
    shares: results.map((s) => ({ memberId: s.member_id, amount: s.amount })),
    createdAt: b.created_at,
  };
}

const shareInserts = (db: D1Database, bid: string, shares: Share[]) =>
  shares.map((s) =>
    db.prepare("INSERT INTO bill_shares (bill_id, member_id, amount) VALUES (?, ?, ?)").bind(bid, s.memberId, s.amount),
  );

export async function createBill(db: D1Database, gid: string, input: BillInput): Promise<Bill> {
  const bid = entityId();
  await db.batch([
    db
      .prepare(
        "INSERT INTO bills (id, group_id, kind, description, amount, paid_by, date, split_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(bid, gid, input.kind, input.description, input.amount, input.paidBy, input.date, input.splitMode),
    ...shareInserts(db, bid, input.shares),
  ]);
  return (await getBill(db, gid, bid))!;
}

export async function updateBill(db: D1Database, gid: string, bid: string, input: BillInput): Promise<Bill | null> {
  // Existence + group scope checked by caller; batch is atomic.
  await db.batch([
    db
      .prepare(
        `UPDATE bills SET kind = ?, description = ?, amount = ?, paid_by = ?, date = ?, split_mode = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND group_id = ?`,
      )
      .bind(input.kind, input.description, input.amount, input.paidBy, input.date, input.splitMode, bid, gid),
    db.prepare("DELETE FROM bill_shares WHERE bill_id = ?").bind(bid),
    ...shareInserts(db, bid, input.shares),
  ]);
  return getBill(db, gid, bid);
}

export async function deleteBill(db: D1Database, gid: string, bid: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM bills WHERE id = ? AND group_id = ?").bind(bid, gid).run();
  return r.meta.changes > 0;
}
