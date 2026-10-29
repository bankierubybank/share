// D1 access for v0.11: a trip's own categories (#12), email suggestions from my other trips (#9) and Web Push
// subscriptions (#6). Everything trip-scoped takes the group id.
import { logActivity } from "./db";
import { entityId } from "./lib/ids";

export interface CustomCategory { id: string; name: string; icon: string }

// ---------- categories ----------

export const categoriesStatement = (db: D1Database, gid: string) =>
  db.prepare("SELECT id, name, icon FROM categories WHERE group_id = ? ORDER BY created_at, id").bind(gid);

export async function listCategories(db: D1Database, gid: string): Promise<CustomCategory[]> {
  return (await categoriesStatement(db, gid).all<CustomCategory>()).results;
}

export async function countCategories(db: D1Database, gid: string): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) n FROM categories WHERE group_id = ?").bind(gid).first<{ n: number }>())?.n ?? 0;
}

/** Insert (no `cid`) or update; null = no such category in this trip. Throws on a duplicate name (UNIQUE). */
export async function saveCategory(db: D1Database, gid: string, cid: string | null, name: string, icon: string, actor: string | null): Promise<CustomCategory | null> {
  if (cid) {
    const r = await db.prepare("UPDATE categories SET name = ?, icon = ? WHERE id = ? AND group_id = ?").bind(name, icon, cid, gid).run();
    return r.meta.changes ? { id: cid, name, icon } : null;
  }
  const id = entityId();
  await db.batch([
    db.prepare("INSERT INTO categories (id, group_id, name, icon) VALUES (?, ?, ?, ?)").bind(id, gid, name, icon),
    logActivity(db, gid, actor, "category.add", id, { name }),
  ]);
  return { id, name, icon };
}

/** Bills keep pointing at the id (they read as "Other" from now on). */
export async function deleteCategory(db: D1Database, gid: string, cid: string): Promise<boolean> {
  return (await db.prepare("DELETE FROM categories WHERE id = ? AND group_id = ?").bind(cid, gid).run()).meta.changes > 0;
}

// ---------- contacts ----------

/** People linked in my (live) trips, newest trip first, one row per email; never me, never service tokens. */
export async function contactsFor(db: D1Database, identity: string) {
  const { results } = await db
    .prepare(
      `SELECT o.email, o.name, MAX(g.created_at) AS at
       FROM members me JOIN groups g ON g.id = me.group_id AND g.deleted_at IS NULL
         JOIN members o ON o.group_id = me.group_id AND o.email IS NOT NULL AND o.email != ?1 AND o.email NOT LIKE 'svc:%'
       WHERE me.email = ?1 GROUP BY o.email ORDER BY at DESC LIMIT 100`,
    )
    .bind(identity)
    .all<{ email: string; name: string }>();
  return results.map(({ email, name }) => ({ email, name }));
}

// ---------- push subscriptions ----------

export interface PushRow { endpoint: string; identity: string; p256dh: string; auth: string; lang: string }

export const PUSH_PER_IDENTITY = 10;

/** One row per browser; re-subscribing (or another account in the same browser) takes the row over. */
export async function savePushSubscription(db: D1Database, row: PushRow) {
  await db.batch([
    db.prepare(
      `INSERT INTO push_subscriptions (endpoint, identity, p256dh, auth, lang) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET identity = excluded.identity, p256dh = excluded.p256dh, auth = excluded.auth, lang = excluded.lang`,
    ).bind(row.endpoint, row.identity, row.p256dh, row.auth, row.lang),
    // Keep the newest few per person (old browsers rarely say goodbye).
    db.prepare(
      `DELETE FROM push_subscriptions WHERE identity = ?1 AND endpoint NOT IN
         (SELECT endpoint FROM push_subscriptions WHERE identity = ?1 ORDER BY created_at DESC LIMIT ${PUSH_PER_IDENTITY})`,
    ).bind(row.identity),
  ]);
}

export async function deletePushSubscription(db: D1Database, endpoint: string, identity?: string) {
  const r = identity
    ? await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND identity = ?").bind(endpoint, identity).run()
    : await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
  return r.meta.changes > 0;
}

/** Browsers of everyone linked to the trip except `except` (whoever made the change). */
export async function pushTargets(db: D1Database, gid: string, except: string | null): Promise<PushRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.endpoint, s.identity, s.p256dh, s.auth, s.lang FROM push_subscriptions s
       JOIN members m ON m.email = s.identity WHERE m.group_id = ? AND s.identity != ? LIMIT 200`,
    )
    .bind(gid, except ?? "")
    .all<PushRow>();
  return results;
}
