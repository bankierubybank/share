// Home overview (v0.8): my position in every trip I'm linked to, and my spending by month — one batch.
// Must agree with src/lib/money.ts computeBalances: net = paid − owed over expenses, plus payments I made minus
// payments I received. Bills from before multi-payer support have no bill_payers rows: their payer is `paid_by`.

export interface TripPosition {
  groupId: string;
  /** What I paid on expenses / my share of expenses / my net (incl. settle-up payments), in minor units. */
  paid: number;
  owed: number;
  net: number;
  /** The trip's expense total and live bill count. */
  total: number;
  bills: number;
}
export interface MonthSpend { month: string; currency: string; owed: number }

const MINE = `
  me AS (SELECT id AS mid, group_id AS gid FROM members WHERE email = ?1),
  live AS (SELECT b.id, b.group_id, b.kind, b.amount, b.paid_by, b.date FROM bills b JOIN me ON b.group_id = me.gid WHERE b.deleted_at IS NULL),
  pay AS (
    SELECT l.group_id, l.kind, bp.amount FROM live l
      JOIN me ON me.gid = l.group_id JOIN bill_payers bp ON bp.bill_id = l.id AND bp.member_id = me.mid
    UNION ALL
    SELECT l.group_id, l.kind, l.amount FROM live l JOIN me ON me.gid = l.group_id
      WHERE l.paid_by = me.mid AND NOT EXISTS (SELECT 1 FROM bill_payers bp WHERE bp.bill_id = l.id)
  ),
  shr AS (
    SELECT l.group_id, l.kind, l.date, bs.amount FROM live l
      JOIN me ON me.gid = l.group_id JOIN bill_shares bs ON bs.bill_id = l.id AND bs.member_id = me.mid
  )`;

export async function overview(db: D1Database, identity: string): Promise<{ trips: TripPosition[]; months: MonthSpend[] }> {
  const [trips, months] = await db.batch([
    db.prepare(`WITH ${MINE}
      SELECT me.gid AS groupId,
        (SELECT COALESCE(SUM(amount), 0) FROM pay WHERE group_id = me.gid AND kind = 'expense') AS paid,
        (SELECT COALESCE(SUM(amount), 0) FROM shr WHERE group_id = me.gid AND kind = 'expense') AS owed,
        (SELECT COALESCE(SUM(amount), 0) FROM pay WHERE group_id = me.gid AND kind = 'payment')
          - (SELECT COALESCE(SUM(amount), 0) FROM shr WHERE group_id = me.gid AND kind = 'payment') AS transfers,
        (SELECT COALESCE(SUM(amount), 0) FROM live WHERE group_id = me.gid AND kind = 'expense') AS total,
        (SELECT COUNT(*) FROM live WHERE group_id = me.gid) AS bills
      FROM me`).bind(identity),
    // My share of expenses per month and currency (trips differ in currency; never add them up across).
    db.prepare(`WITH ${MINE}
      SELECT substr(shr.date, 1, 7) AS month, g.currency AS currency, SUM(shr.amount) AS owed
      FROM shr JOIN groups g ON g.id = shr.group_id WHERE shr.kind = 'expense'
      GROUP BY month, g.currency ORDER BY month DESC, g.currency LIMIT 36`).bind(identity),
  ]);
  type Row = { groupId: string; paid: number; owed: number; transfers: number; total: number; bills: number };
  return {
    trips: (trips.results as Row[]).map((r) => ({
      groupId: r.groupId, paid: r.paid, owed: r.owed, net: r.paid - r.owed + r.transfers, total: r.total, bills: r.bills,
    })),
    months: months.results as unknown as MonthSpend[],
  };
}

/** Changes whenever something in the trip changes (activity log + bill edits): cheap poll for live refresh. */
export const versionStatement = (db: D1Database, gid: string) =>
  db
    .prepare(
      `SELECT (SELECT COUNT(*) || ':' || COALESCE(MAX(at), '') FROM activity WHERE group_id = ?1)
         || '|' || (SELECT COALESCE(MAX(updated_at), '') FROM bills WHERE group_id = ?1) AS v`,
    )
    .bind(gid);

export async function tripVersion(db: D1Database, gid: string): Promise<string> {
  return (await versionStatement(db, gid).first<{ v: string }>())?.v ?? "";
}
