// D1 access for comments, subgroups, read-only view links and moving bills between groups.
import type { Bill, Group, Member } from "./db";
import { logActivity } from "./db";
import { entityId, groupId as newViewId } from "./lib/ids";
import { remapSplit } from "./lib/social";

export interface Comment {
  id: string;
  billId: string;
  authorMemberId: string | null;
  actor: string | null;
  body: string;
  createdAt: string;
}
export interface Subgroup {
  id: string;
  name: string;
  memberIds: string[];
}

// ---------- comments ----------

interface CommentRow { id: string; bill_id: string; author_member_id: string | null; actor: string | null; body: string; created_at: string }
const toComment = (r: CommentRow): Comment => ({
  id: r.id, billId: r.bill_id, authorMemberId: r.author_member_id, actor: r.actor, body: r.body, createdAt: r.created_at,
});

export async function listComments(db: D1Database, gid: string, bid: string): Promise<Comment[]> {
  const { results } = await db
    .prepare("SELECT id, bill_id, author_member_id, actor, body, created_at FROM bill_comments WHERE group_id = ? AND bill_id = ? ORDER BY created_at, id")
    .bind(gid, bid)
    .all<CommentRow>();
  return results.map(toComment);
}

export async function countComments(db: D1Database, bid: string): Promise<number> {
  const r = await db.prepare("SELECT count(*) n FROM bill_comments WHERE bill_id = ?").bind(bid).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function addComment(
  db: D1Database, gid: string, bid: string, body: string, authorMemberId: string | null, actor: string | null, billDescription: string,
): Promise<Comment> {
  const id = entityId();
  const r = await db.batch([
    db.prepare("INSERT INTO bill_comments (id, bill_id, group_id, author_member_id, actor, body) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, bid, gid, authorMemberId, actor, body),
    logActivity(db, gid, actor, "comment.add", bid, { description: billDescription, excerpt: body.slice(0, 80) }),
    db.prepare("SELECT id, bill_id, author_member_id, actor, body, created_at FROM bill_comments WHERE id = ?").bind(id),
  ]);
  return toComment((r[2].results as CommentRow[])[0]);
}

export async function deleteComment(db: D1Database, gid: string, bid: string, cid: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM bill_comments WHERE id = ? AND bill_id = ? AND group_id = ?").bind(cid, bid, gid).run();
  return r.meta.changes > 0;
}

// ---------- subgroups ----------

export async function listSubgroups(db: D1Database, gid: string): Promise<Subgroup[]> {
  const { results } = await db.prepare("SELECT id, name, member_ids FROM subgroups WHERE group_id = ? ORDER BY created_at, id").bind(gid)
    .all<{ id: string; name: string; member_ids: string }>();
  return results.map((r) => ({ id: r.id, name: r.name, memberIds: JSON.parse(r.member_ids) }));
}

export async function countSubgroups(db: D1Database, gid: string): Promise<number> {
  const r = await db.prepare("SELECT count(*) n FROM subgroups WHERE group_id = ?").bind(gid).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function saveSubgroup(db: D1Database, gid: string, sid: string | null, name: string, memberIds: string[]): Promise<Subgroup | null> {
  if (sid) {
    const r = await db.prepare("UPDATE subgroups SET name = ?, member_ids = ? WHERE id = ? AND group_id = ?").bind(name, JSON.stringify(memberIds), sid, gid).run();
    return r.meta.changes ? { id: sid, name, memberIds } : null;
  }
  const id = entityId();
  await db.prepare("INSERT INTO subgroups (id, group_id, name, member_ids) VALUES (?, ?, ?, ?)").bind(id, gid, name, JSON.stringify(memberIds)).run();
  return { id, name, memberIds };
}

export async function deleteSubgroup(db: D1Database, gid: string, sid: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM subgroups WHERE id = ? AND group_id = ?").bind(sid, gid).run();
  return r.meta.changes > 0;
}

/** Removes a member from every subgroup (subgroups left empty are deleted). */
export async function stripMemberFromSubgroups(db: D1Database, gid: string, mid: string) {
  const subs = await listSubgroups(db, gid);
  const stmts = subs
    .filter((s) => s.memberIds.includes(mid))
    .map((s) => {
      const left = s.memberIds.filter((x) => x !== mid);
      return left.length
        ? db.prepare("UPDATE subgroups SET member_ids = ? WHERE id = ?").bind(JSON.stringify(left), s.id)
        : db.prepare("DELETE FROM subgroups WHERE id = ?").bind(s.id);
    });
  if (stmts.length) await db.batch(stmts);
}

// ---------- read-only view link ----------

export async function getViewId(db: D1Database, gid: string): Promise<string | null> {
  const r = await db.prepare("SELECT view_id FROM groups WHERE id = ?").bind(gid).first<{ view_id: string | null }>();
  return r?.view_id ?? null;
}

/** Creates (or rotates) the view id; null revokes it. */
export async function setViewId(db: D1Database, gid: string, on: boolean, actor: string | null): Promise<string | null> {
  const vid = on ? newViewId() : null;
  await db.batch([
    db.prepare("UPDATE groups SET view_id = ? WHERE id = ?").bind(vid, gid),
    logActivity(db, gid, actor, on ? "viewlink.create" : "viewlink.revoke", gid, null),
  ]);
  return vid;
}

export async function groupIdByViewId(db: D1Database, vid: string): Promise<string | null> {
  const r = await db.prepare("SELECT id FROM groups WHERE view_id = ?").bind(vid).first<{ id: string }>();
  return r?.id ?? null;
}

// ---------- move / merge ----------

/** Adds members (by name) to a group; returns their new ids keyed by the source member id. */
export async function addMembersFor(db: D1Database, gid: string, missing: { id: string; name: string }[], actor: string | null) {
  const map = new Map<string, string>();
  if (!missing.length) return map;
  const max = await db.prepare("SELECT COALESCE(MAX(position), -1) p FROM members WHERE group_id = ?").bind(gid).first<{ p: number }>();
  let pos = (max?.p ?? -1) + 1;
  const stmts = missing.flatMap((m) => {
    const id = entityId();
    map.set(m.id, id);
    return [
      db.prepare("INSERT INTO members (id, group_id, name, position) VALUES (?, ?, ?, ?)").bind(id, gid, m.name, pos++),
      logActivity(db, gid, actor, "member.add", id, { name: m.name }),
    ];
  });
  await db.batch(stmts);
  return map;
}

/** Moves live bills (with their payers, shares and comments) to another group, remapping member ids. */
export async function moveBills(
  db: D1Database, from: Group, to: Group, bills: Bill[], map: ReadonlyMap<string, string>, actor: string | null,
) {
  const m = (id: string) => map.get(id)!;
  for (let i = 0; i < bills.length; i += 25) {
    const stmts: D1PreparedStatement[] = [];
    for (const b of bills.slice(i, i + 25)) {
      stmts.push(
        db.prepare("UPDATE bills SET group_id = ?, paid_by = ?, split_json = ?, recurrence_id = NULL WHERE id = ? AND group_id = ?")
          .bind(to.id, m(b.payers[0].memberId), JSON.stringify(remapSplit(b.split, map)), b.id, from.id),
        db.prepare("DELETE FROM bill_payers WHERE bill_id = ?").bind(b.id),
        db.prepare("DELETE FROM bill_shares WHERE bill_id = ?").bind(b.id),
        ...b.payers.map((p) => db.prepare("INSERT INTO bill_payers (bill_id, member_id, amount) VALUES (?, ?, ?)").bind(b.id, m(p.memberId), p.amount)),
        ...b.shares.map((s) => db.prepare("INSERT INTO bill_shares (bill_id, member_id, amount) VALUES (?, ?, ?)").bind(b.id, m(s.memberId), s.amount)),
        // Comment authors are members of the old group: keep the text, drop the link.
        db.prepare("UPDATE bill_comments SET group_id = ?, author_member_id = NULL WHERE bill_id = ?").bind(to.id, b.id),
        logActivity(db, from.id, actor, "bill.moveOut", b.id, { description: b.description, amount: b.amount, to: to.name }),
        logActivity(db, to.id, actor, "bill.moveIn", b.id, { description: b.description, amount: b.amount, from: from.name }),
      );
    }
    await db.batch(stmts);
  }
}

/** Member ids referenced by bills (payers + shares). */
export function membersUsedBy(bills: Bill[], members: Member[]): Member[] {
  const used = new Set(bills.flatMap((b) => [...b.payers.map((p) => p.memberId), ...b.shares.map((s) => s.memberId)]));
  return members.filter((x) => used.has(x.id));
}
