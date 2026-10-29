// D1 access for invite links (v0.6): a trip member creates a link; whoever opens it (signed in through Access)
// picks who they are in the trip, or adds themselves, and is linked by their identity.
import type { Group, Member } from "./db";
import { logActivity } from "./db";
import { entityId, groupId as newToken } from "./lib/ids";

export const INVITE_DAYS = 14;

/** Hex SHA-256: only the hash is stored, so the database never holds a working link. */
export async function hashToken(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface InviteStatus { active: boolean; expiresAt: string | null }

export async function inviteStatus(db: D1Database, gid: string): Promise<InviteStatus> {
  const r = await db
    .prepare("SELECT invite_expires FROM groups WHERE id = ? AND invite_hash IS NOT NULL")
    .bind(gid)
    .first<{ invite_expires: string }>();
  const active = !!r && r.invite_expires > new Date().toISOString();
  return { active, expiresAt: active ? r!.invite_expires : null };
}

/** Creates (or rotates: the old link stops working) the trip's invite. The token is returned once, never stored. */
export async function createInvite(db: D1Database, gid: string, actor: string | null) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString();
  await db.batch([
    db.prepare("UPDATE groups SET invite_hash = ?, invite_expires = ? WHERE id = ?").bind(await hashToken(token), expiresAt, gid),
    logActivity(db, gid, actor, "invite.create", null, null),
  ]);
  return { token, expiresAt };
}

export async function revokeInvite(db: D1Database, gid: string, actor: string | null) {
  await db.batch([
    db.prepare("UPDATE groups SET invite_hash = NULL, invite_expires = NULL WHERE id = ?").bind(gid),
    logActivity(db, gid, actor, "invite.revoke", null, null),
  ]);
}

interface InviteRow { id: string; name: string; currency: string; archived_at: string | null; created_at: string; budget: number | null; start_date: string | null; end_date: string | null; invite_expires: string }

/** The trip behind a live (not expired) invite token, or null. */
export async function groupByInvite(db: D1Database, token: string): Promise<(Group & { expiresAt: string }) | null> {
  const r = await db
    .prepare("SELECT id, name, currency, archived_at, created_at, budget, start_date, end_date, invite_expires FROM groups WHERE invite_hash = ? AND deleted_at IS NULL")
    .bind(await hashToken(token))
    .first<InviteRow>();
  if (!r || r.invite_expires <= new Date().toISOString()) return null;
  return { id: r.id, name: r.name, currency: r.currency, archived: r.archived_at !== null, createdAt: r.created_at, budget: r.budget, startDate: r.start_date, endDate: r.end_date, expiresAt: r.invite_expires };
}

/** Links `identity` to an existing, still unlinked person. "taken" = someone else got there first. */
export async function joinAs(db: D1Database, gid: string, mid: string, identity: string, actor: string | null): Promise<"ok" | "not_found" | "taken"> {
  const target = await db.prepare("SELECT name, email FROM members WHERE id = ? AND group_id = ?").bind(mid, gid).first<{ name: string; email: string | null }>();
  if (!target) return "not_found";
  if (target.email !== null) return "taken";
  const [upd] = await db.batch([
    db.prepare("UPDATE members SET email = ?, seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND group_id = ? AND email IS NULL").bind(identity, mid, gid),
    db
      .prepare("INSERT INTO activity (id, group_id, actor, action, entity_id, detail) SELECT ?, ?, ?, 'member.join', ?, json_object('name', ?) WHERE changes() > 0")
      .bind(entityId(), gid, actor, mid, target.name),
  ]);
  return upd.meta.changes ? "ok" : "taken";
}

/** Adds the caller as a new person (named `name`) linked to `identity`. Throws on a duplicate name (UNIQUE). */
export async function joinAsNew(db: D1Database, gid: string, name: string, identity: string, actor: string | null): Promise<Member> {
  const id = entityId();
  await db.batch([
    db
      .prepare(
        "INSERT INTO members (id, group_id, name, email, position, seen_at) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM members WHERE group_id = ?), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      )
      .bind(id, gid, name, identity, gid),
    logActivity(db, gid, actor, "member.join", id, { name, added: true }),
  ]);
  return { id, name, promptpay: null, email: identity };
}
