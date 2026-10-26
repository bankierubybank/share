import { Hono } from "hono";
import type { Context } from "hono";
import * as db from "./db";
import { computeBalances, computeSettlements } from "./lib/money";
import { ENTITY_ID_RE, GROUP_ID_RE, randomId } from "./lib/ids";
import {
  LIMITS, ValidationError, nextOccurrence, parseBill, parseGroupPatch, parseMember, parseNewGroup, parseRecurrence,
} from "./lib/validate";
import { actorOf } from "./lib/actor";
import { runBackup } from "./backup";

export type AppEnv = { Bindings: Env };
type GroupEnv = AppEnv & { Variables: { group: db.Group } };
type GCtx = Context<GroupEnv>;

export const VERSION = "0.2.0";
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
    let date = r.next_date;
    for (let n = 0; n < 60 && date <= today(); n++) {
      const next = nextOccurrence(date, r.frequency, r.anchor_day);
      let input;
      try {
        input = parseBill({ ...JSON.parse(r.template), date }, memberIds, group.currency);
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        await db.failRecurrence(env.DB, r.id, e.message);
        break;
      }
      if (!(await db.claimOccurrence(env.DB, r.id, date, next))) break; // another request got it
      await db.createBill(env.DB, r.group_id, input, "recurring", r.id);
      created++;
      date = next;
    }
  }
  return created;
}

export async function scheduledMaintenance(env: Env) {
  // Backup first so the snapshot still holds bills about to be purged.
  await runBackup(env);
  await materializeDue(env);
  const keys = await db.purgeDeleted(env.DB, PURGE_DAYS);
  if (keys.length) await env.RECEIPTS.delete(keys);
}

export const api = new Hono<AppEnv>();

api.get("/health", (c) => c.json({ ok: true, version: VERSION }));

api.get("/me", (c) => c.json({ actor: actorOf(c.req.raw) }));

api.post("/groups", async (c) => {
  const input = parseNewGroup(await readJson(c));
  const out = await db.createGroup(c.env.DB, input.name, input.currency, input.members, actorOf(c.req.raw));
  return c.json(out, 201);
});

// Group-scoped routes: validate id format + existence once; archived groups are read-only.
const g = new Hono<GroupEnv>();

g.use("*", async (c, next) => {
  const gid = c.req.param("gid") ?? "";
  if (!GROUP_ID_RE.test(gid)) return apiError(c, 404, "not_found", "group not found");
  const group = await db.getGroup(c.env.DB, gid);
  if (!group) return apiError(c, 404, "not_found", "group not found");
  const m = c.req.method;
  const isRoot = /\/groups\/[^/]+\/?$/.test(c.req.path);
  if (group.archived && m !== "GET" && m !== "HEAD" && !(isRoot && (m === "PATCH" || m === "DELETE")))
    return apiError(c, 409, "archived", "group is archived; unarchive it to make changes");
  c.set("group", group);
  await next();
});

const actor = (c: GCtx) => actorOf(c.req.raw);
const gidOf = (c: GCtx) => c.get("group").id;

g.get("/", async (c) => {
  const group = c.get("group");
  if (!group.archived) await materializeDue(c.env, group.id);
  const [members, bills] = await Promise.all([db.listMembers(c.env.DB, group.id), db.listBills(c.env.DB, group.id)]);
  return c.json({ group, members, bills });
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

g.post("/members", async (c) => {
  const input = parseMember(await readJson(c), true);
  const gid = gidOf(c);
  if ((await db.countRows(c.env.DB, "members", gid)) >= LIMITS.membersPerGroup)
    return apiError(c, 409, "conflict", `at most ${LIMITS.membersPerGroup} members per group`);
  try {
    return c.json({ member: await db.addMember(c.env.DB, gid, input.name!, input.promptpay ?? null, actor(c)) }, 201);
  } catch (e) {
    if (isUnique(e)) return apiError(c, 409, "conflict", "a member with that name already exists");
    throw e;
  }
});

g.patch("/members/:mid", async (c) => {
  const mid = c.req.param("mid");
  if (!ENTITY_ID_RE.test(mid)) return apiError(c, 404, "not_found", "member not found");
  const patch = parseMember(await readJson(c), false);
  try {
    const member = await db.updateMember(c.env.DB, gidOf(c), mid, patch, actor(c));
    if (!member) return apiError(c, 404, "not_found", "member not found");
    return c.json({ member });
  } catch (e) {
    if (isUnique(e)) return apiError(c, 409, "conflict", "a member with that name already exists");
    throw e;
  }
});

g.delete("/members/:mid", async (c) => {
  const mid = c.req.param("mid");
  const gid = gidOf(c);
  if (!ENTITY_ID_RE.test(mid)) return apiError(c, 404, "not_found", "member not found");
  if (await db.memberInUse(c.env.DB, gid, mid))
    return apiError(c, 409, "conflict", "member is used by bills or recurring bills; change those first");
  const r = await db.deleteMember(c.env.DB, gid, mid, actor(c));
  if (!r.ok) return apiError(c, 404, "not_found", "member not found");
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
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > RECEIPT_MAX) return apiError(c, 413, "payload_too_large", "receipt must be at most 2 MB");
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

g.get("/summary", async (c) => {
  const gid = gidOf(c);
  if (!c.get("group").archived) await materializeDue(c.env, gid);
  const [members, bills] = await Promise.all([db.listMembers(c.env.DB, gid), db.listBills(c.env.DB, gid)]);
  const balances = computeBalances(members.map((m) => m.id), bills);
  const expenses = bills.filter((b) => b.kind === "expense");
  const byCategory: Record<string, number> = {};
  for (const b of expenses) byCategory[b.category] = (byCategory[b.category] ?? 0) + b.amount;
  const total = expenses.reduce((a, b) => a + b.amount, 0);
  return c.json({ balances, settlements: computeSettlements(balances), total, byCategory });
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

api.route("/groups/:gid", g);
