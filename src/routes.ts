import { Hono } from "hono";
import type { Context } from "hono";
import * as db from "./db";
import { computeBalances, computeSettlements } from "./lib/money";
import { ENTITY_ID_RE, GROUP_ID_RE, randomId } from "./lib/ids";
import {
  LIMITS, ValidationError, nextOccurrence, parseBill, parseGroupPatch, parseMember, parseNewGroup, parseRecurrence,
} from "./lib/validate";
import { actorLabel } from "./lib/identity";
import { runBackup } from "./backup";
import { readLimited } from "./lib/body";
import { registerSocial } from "./routes-social";
import { stripMemberFromSubgroups } from "./db-social";

/** `identity`: verified caller (src/lib/identity.ts), set by src/index.ts; null = unknown → 401 on trip routes. */
export type AppEnv = { Bindings: Env; Variables: { identity: string | null } };
/** `me`: the caller's member id in the group (null only while claiming an unclaimed trip). */
export type GroupEnv = { Bindings: Env; Variables: { identity: string | null; group: db.Group; me: string | null } };
type GCtx = Context<GroupEnv>;

export const VERSION = "0.4.0";
export const RECEIPT_MAX = 2 * 1024 * 1024;
const PURGE_DAYS = 30;

export function apiError(c: Context, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status as 400);
}

const isUnique = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
const today = () => new Date().toISOString().slice(0, 10);

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return Symbol.for("invalid-json");
  }
}

/** Creates bills for every due occurrence (lazy on read + daily cron). Archived groups are skipped. */
export async function materializeDue(env: Env, gid?: string): Promise<number> {
  let created = 0;
  for (const r of await db.dueRecurrences(env.DB, today(), gid)) {
    const group = await db.getGroup(env.DB, r.group_id);
    if (!group) continue;
    const memberIds = new Set((await db.listMembers(env.DB, r.group_id)).map((m) => m.id));
    // Work out every due date first (≤60 per run), then claim + insert them in one go: on prod each D1 round
    // trip costs 100 ms+, so per-occurrence queries made catching up a series take seconds.
    const dates: string[] = [];
    let next = r.next_date;
    while (dates.length < 60 && next <= today()) {
      dates.push(next);
      next = nextOccurrence(next, r.frequency, r.anchor_day);
    }
    if (!dates.length) continue;
    const template = JSON.parse(r.template);
    let inputs;
    try {
      inputs = dates.map((date) => parseBill({ ...template, date }, memberIds, group.currency));
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      await db.failRecurrence(env.DB, r.id, e.message);
      continue;
    }
    const room = LIMITS.billsPerGroup - (await db.countRows(env.DB, "bills", r.group_id));
    if (room < inputs.length) {
      // Create what fits, then stop the series.
      if (room > 0 && (await db.createOccurrences(env.DB, r.group_id, r.id, dates[0], dates[room], inputs.slice(0, room)))) created += room;
      await db.failRecurrence(env.DB, r.id, `group reached ${LIMITS.billsPerGroup} bills`);
      continue;
    }
    if (await db.createOccurrences(env.DB, r.group_id, r.id, dates[0], next, inputs)) created += inputs.length;
  }
  return created;
}

export async function scheduledMaintenance(env: Env) {
  // Steps are independent: a failed backup must not stop repeating bills or the purge (and vice versa).
  // Backup runs first so the snapshot still holds bills about to be purged.
  const steps: [string, () => Promise<unknown>][] = [
    ["backup", () => runBackup(env)],
    ["recurring", () => materializeDue(env)],
    ["purge", async () => {
      const keys = await db.purgeDeleted(env.DB, PURGE_DAYS);
      if (keys.length) await env.RECEIPTS.delete(keys);
    }],
  ];
  const failed: string[] = [];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (e) {
      failed.push(name);
      console.error(`scheduled ${name} failed`, e);
    }
  }
  if (failed.length) throw new Error(`scheduled maintenance failed: ${failed.join(", ")}`); // visible in Workers logs
}

export const api = new Hono<AppEnv>();

api.get("/health", (c) => c.json({ ok: true, version: VERSION }));

const noIdentity = (c: Context) => apiError(c, 401, "unauthorized", "sign in through Cloudflare Access");

api.get("/me", (c) => c.json({ actor: actorLabel(c.get("identity")) }));

/** Trips the caller is linked to (home page). */
api.get("/me/groups", async (c) => {
  const identity = c.get("identity");
  if (!identity) return noIdentity(c);
  return c.json({ groups: await db.groupsFor(c.env.DB, identity) });
});

api.post("/groups", async (c) => {
  const identity = c.get("identity");
  if (!identity) return noIdentity(c);
  const input = parseNewGroup(await readJson(c));
  const out = await db.createGroup(c.env.DB, input.name, input.currency, input.members, input.me, identity, actorLabel(identity));
  return c.json({ ...out, me: out.members[input.me].id }, 201);
});

// Group-scoped routes: validate id format + existence once; only linked people get in; archived = read-only.
const g = new Hono<GroupEnv>();

g.use("*", async (c, next) => {
  const gid = c.req.param("gid") ?? "";
  if (!GROUP_ID_RE.test(gid)) return apiError(c, 404, "not_found", "group not found");
  const identity = c.get("identity");
  if (!identity) return noIdentity(c);
  const access = await db.getGroupAccess(c.env.DB, gid, identity);
  if (!access) return apiError(c, 404, "not_found", "group not found");
  const { group, meId, claimed } = access;
  const m = c.req.method;
  const isClaim = m === "POST" && /\/me\/?$/.test(c.req.path);
  // Pre-0.4 trips have nobody linked: the first visitor says who they are (POST /me), which locks the trip.
  // Until then only the names are returned, to pick from.
  if (!meId && !(isClaim && !claimed)) {
    if (claimed) return apiError(c, 403, "not_member", `${actorLabel(identity)} is not in this trip; ask someone in it to add your email under People`);
    const members = (await db.listMembers(c.env.DB, gid)).map(({ id, name }) => ({ id, name }));
    return c.json({ error: { code: "claim_required", message: "nobody is linked to this trip yet; pick who you are", members } }, 403);
  }
  const isRoot = /\/groups\/[^/]+\/?$/.test(c.req.path);
  // Revoking a read-only link (and saying who you are) must always be possible, even while archived.
  const isRevoke = m === "DELETE" && /\/view-link\/?$/.test(c.req.path);
  if (group.archived && m !== "GET" && m !== "HEAD" && !isRevoke && !isClaim && !(isRoot && (m === "PATCH" || m === "DELETE")))
    return apiError(c, 409, "archived", "group is archived; unarchive it to make changes");
  c.set("group", group);
  c.set("me", meId);
  await next();
});

const actor = (c: GCtx) => actorLabel(c.get("identity"));
const gidOf = (c: GCtx) => c.get("group").id;

g.get("/", async (c) => {
  const group = c.get("group");
  if (!group.archived) await materializeDue(c.env, group.id);
  const [members, bills] = await Promise.all([db.listMembers(c.env.DB, group.id), db.listBills(c.env.DB, group.id)]);
  return c.json({ group, members, bills, me: c.get("me") });
});

/** "This is me": claim an unclaimed trip, or move my link to another (unlinked) person. */
g.post("/me", async (c) => {
  const body = await readJson(c);
  const mid = typeof body === "object" && body !== null ? (body as { memberId?: unknown }).memberId : undefined;
  if (typeof mid !== "string" || !ENTITY_ID_RE.test(mid)) return apiError(c, 400, "validation", "memberId is required");
  const r = await db.linkMe(c.env.DB, gidOf(c), mid, c.get("identity")!, c.get("me"), actor(c));
  if (r === "not_found") return apiError(c, 404, "not_found", "member not found");
  if (r === "taken") return apiError(c, 409, "conflict", "that person is linked to someone else");
  if (r === "race") return apiError(c, 409, "conflict", "someone else just claimed this trip; reload");
  return c.json({ me: mid });
});

g.patch("/", async (c) => {
  const patch = parseGroupPatch(await readJson(c));
  if (c.get("group").archived && (patch.name !== undefined || patch.currency !== undefined) && patch.archived !== false)
    return apiError(c, 409, "archived", "group is archived; unarchive it to make changes");
  const group = await db.updateGroup(c.env.DB, gidOf(c), patch, actor(c), c.get("group"));
  return c.json({ group });
});

g.delete("/", async (c) => {
  const keys = await db.deleteGroup(c.env.DB, gidOf(c));
  if (keys.length) await c.env.RECEIPTS.delete(keys);
  return c.body(null, 204);
});

// ---------- members ----------

const memberConflict = (c: GCtx, e: unknown) =>
  /email/i.test(String(e))
    ? apiError(c, 409, "conflict", "that email is already linked to someone in this trip")
    : apiError(c, 409, "conflict", "a member with that name already exists");
const lastLink = (c: GCtx) => apiError(c, 409, "last_link", "at least one person must keep an email, or nobody could open this trip");

/** True if `mid` holds the trip's only link (removing it would lock everyone out). */
async function wouldUnlinkLast(c: GCtx, mid: string) {
  const m = await db.getMember(c.env.DB, gidOf(c), mid);
  return !!m?.email && (await db.linkedCount(c.env.DB, gidOf(c))) <= 1;
}

g.post("/members", async (c) => {
  const input = parseMember(await readJson(c), true);
  const gid = gidOf(c);
  if ((await db.countRows(c.env.DB, "members", gid)) >= LIMITS.membersPerGroup)
    return apiError(c, 409, "conflict", `at most ${LIMITS.membersPerGroup} members per group`);
  try {
    return c.json({ member: await db.addMember(c.env.DB, gid, input.name!, input.promptpay ?? null, input.email ?? null, actor(c)) }, 201);
  } catch (e) {
    if (isUnique(e)) return memberConflict(c, e);
    throw e;
  }
});

g.patch("/members/:mid", async (c) => {
  const mid = c.req.param("mid");
  if (!ENTITY_ID_RE.test(mid)) return apiError(c, 404, "not_found", "member not found");
  const patch = parseMember(await readJson(c), false);
  if (patch.email === null && (await wouldUnlinkLast(c, mid))) return lastLink(c);
  try {
    const member = await db.updateMember(c.env.DB, gidOf(c), mid, patch, actor(c));
    if (!member) return apiError(c, 404, "not_found", "member not found");
    return c.json({ member });
  } catch (e) {
    if (isUnique(e)) return memberConflict(c, e);
    throw e;
  }
});

g.delete("/members/:mid", async (c) => {
  const mid = c.req.param("mid");
  const gid = gidOf(c);
  if (!ENTITY_ID_RE.test(mid)) return apiError(c, 404, "not_found", "member not found");
  if (await db.memberInUse(c.env.DB, gid, mid))
    return apiError(c, 409, "conflict", "member is used by bills or recurring bills; change those first");
  if (await wouldUnlinkLast(c, mid)) return lastLink(c);
  const r = await db.deleteMember(c.env.DB, gid, mid, actor(c));
  if (!r.ok) return apiError(c, 404, "not_found", "member not found");
  await stripMemberFromSubgroups(c.env.DB, gid, mid);
  if (r.receiptKeys.length) await c.env.RECEIPTS.delete(r.receiptKeys);
  return c.body(null, 204);
});

// ---------- bills ----------

async function memberIdSet(c: GCtx) {
  return new Set((await db.listMembers(c.env.DB, gidOf(c))).map((m) => m.id));
}

g.post("/bills", async (c) => {
  const gid = gidOf(c);
  const input = parseBill(await readJson(c), await memberIdSet(c), c.get("group").currency);
  if ((await db.countRows(c.env.DB, "bills", gid)) >= LIMITS.billsPerGroup)
    return apiError(c, 409, "conflict", `at most ${LIMITS.billsPerGroup} bills per group`);
  return c.json({ bill: await db.createBill(c.env.DB, gid, input, actor(c)) }, 201);
});

g.put("/bills/:bid", async (c) => {
  const bid = c.req.param("bid");
  const gid = gidOf(c);
  if (!ENTITY_ID_RE.test(bid) || !(await db.getBill(c.env.DB, gid, bid))) return apiError(c, 404, "not_found", "bill not found");
  const input = parseBill(await readJson(c), await memberIdSet(c), c.get("group").currency);
  return c.json({ bill: await db.updateBill(c.env.DB, gid, bid, input, actor(c)) });
});

g.delete("/bills/:bid", async (c) => {
  const bid = c.req.param("bid");
  if (!ENTITY_ID_RE.test(bid) || !(await db.deleteBill(c.env.DB, gidOf(c), bid, actor(c))))
    return apiError(c, 404, "not_found", "bill not found");
  return c.body(null, 204);
});

g.post("/bills/:bid/restore", async (c) => {
  const bid = c.req.param("bid");
  const bill = ENTITY_ID_RE.test(bid) ? await db.restoreBill(c.env.DB, gidOf(c), bid, actor(c)) : null;
  if (!bill) return apiError(c, 404, "not_found", "no deleted bill with that id");
  return c.json({ bill });
});

// ---------- receipts (R2) ----------

function sniffImage(b: Uint8Array): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP")
    return "image/webp";
  return null;
}

g.put("/bills/:bid/receipt", async (c) => {
  const bid = c.req.param("bid");
  const gid = gidOf(c);
  if (!ENTITY_ID_RE.test(bid) || !(await db.getBill(c.env.DB, gid, bid))) return apiError(c, 404, "not_found", "bill not found");
  const bytes = await readLimited(c.req.raw, RECEIPT_MAX); // bounded even without Content-Length
  if (!bytes) return apiError(c, 413, "payload_too_large", "receipt must be at most 2 MB");
  const type = sniffImage(bytes);
  if (!type) return apiError(c, 415, "unsupported_media_type", "receipt must be a JPEG, PNG or WebP image");
  const key = `${gid}/${bid}/${randomId(9)}`;
  await c.env.RECEIPTS.put(key, bytes, { httpMetadata: { contentType: type } });
  const prev = await db.setReceipt(c.env.DB, gid, bid, key, actor(c));
  if (prev) await c.env.RECEIPTS.delete(prev);
  return c.json({ ok: true }, 201);
});

g.get("/bills/:bid/receipt", async (c) => {
  const bid = c.req.param("bid");
  const key = ENTITY_ID_RE.test(bid) ? await db.receiptKey(c.env.DB, gidOf(c), bid) : null;
  const obj = key ? await c.env.RECEIPTS.get(key) : null;
  if (!obj) return apiError(c, 404, "not_found", "no receipt");
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=3600",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
});

g.delete("/bills/:bid/receipt", async (c) => {
  const bid = c.req.param("bid");
  const gid = gidOf(c);
  const key = ENTITY_ID_RE.test(bid) ? await db.receiptKey(c.env.DB, gid, bid) : null;
  if (!key) return apiError(c, 404, "not_found", "no receipt");
  await db.setReceipt(c.env.DB, gid, bid, null, actor(c));
  await c.env.RECEIPTS.delete(key);
  return c.body(null, 204);
});

// ---------- summary / activity ----------

export function summaryOf(members: db.Member[], bills: db.Bill[]) {
  const balances = computeBalances(members.map((m) => m.id), bills);
  const expenses = bills.filter((b) => b.kind === "expense");
  const byCategory: Record<string, number> = {};
  for (const b of expenses) byCategory[b.category] = (byCategory[b.category] ?? 0) + b.amount;
  const total = expenses.reduce((a, b) => a + b.amount, 0);
  return { balances, settlements: computeSettlements(balances), total, byCategory };
}

g.get("/summary", async (c) => {
  const gid = gidOf(c);
  if (!c.get("group").archived) await materializeDue(c.env, gid);
  const [members, bills] = await Promise.all([db.listMembers(c.env.DB, gid), db.listBills(c.env.DB, gid)]);
  return c.json(summaryOf(members, bills));
});

g.get("/activity", async (c) => {
  const limit = Math.min(Math.max(Math.floor(Number(c.req.query("limit") ?? 50)) || 50, 1), 100);
  const before = c.req.query("before");
  if (before !== undefined && !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(before)) return apiError(c, 400, "validation", "before must be an ISO timestamp");
  const gid = gidOf(c);
  const [items, deleted] = await Promise.all([db.listActivity(c.env.DB, gid, limit, before), db.deletedBillIds(c.env.DB, gid)]);
  // `restorable` lets the UI offer Undo on delete entries whose bill is still in the bin.
  return c.json({ activity: items.map((a) => ({ ...a, restorable: a.action === "bill.delete" && a.entityId !== null && deleted.has(a.entityId) })) });
});

// ---------- recurring ----------

g.get("/recurring", async (c) => c.json({ recurring: await db.listRecurrences(c.env.DB, gidOf(c)) }));

g.post("/recurring", async (c) => {
  const gid = gidOf(c);
  const input = parseRecurrence(await readJson(c), await memberIdSet(c), c.get("group").currency);
  if ((await db.countRows(c.env.DB, "recurrences", gid)) >= LIMITS.recurrencesPerGroup)
    return apiError(c, 409, "conflict", `at most ${LIMITS.recurrencesPerGroup} recurring bills per group`);
  const rec = await db.createRecurrence(c.env.DB, gid, input.frequency, input.startDate, input.template, actor(c));
  const created = await materializeDue(c.env, gid);
  return c.json({ recurring: (await db.listRecurrences(c.env.DB, gid)).find((r) => r.id === rec.id), created }, 201);
});

g.delete("/recurring/:rid", async (c) => {
  const rid = c.req.param("rid");
  if (!ENTITY_ID_RE.test(rid) || !(await db.stopRecurrence(c.env.DB, gidOf(c), rid, actor(c))))
    return apiError(c, 404, "not_found", "no active recurring bill with that id");
  return c.body(null, 204);
});

registerSocial(api, g, { apiError, readJson, summaryOf });

api.route("/groups/:gid", g);
