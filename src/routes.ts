import { Hono } from "hono";
import type { Context } from "hono";
import * as db from "./db";
import { computeBalances, computeSettlements } from "./lib/money";
import { ENTITY_ID_RE, GROUP_ID_RE } from "./lib/ids";
import { LIMITS, parseBill, parseGroupPatch, parseMemberName, parseNewGroup } from "./lib/validate";

export type AppEnv = { Bindings: Env };

export const VERSION = "0.1.1";

export function apiError(c: Context, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status as 400);
}

const isUnique = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message);

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return Symbol.for("invalid-json");
  }
}

export const api = new Hono<AppEnv>();

api.get("/health", (c) => c.json({ ok: true, version: VERSION }));

api.post("/groups", async (c) => {
  const body = await readJson(c);
  const input = parseNewGroup(body);
  const out = await db.createGroup(c.env.DB, input.name, input.currency, input.members);
  return c.json(out, 201);
});

// Group-scoped routes: validate id format + existence once.
const g = new Hono<AppEnv & { Variables: { group: db.Group } }>();

g.use("*", async (c, next) => {
  const gid = c.req.param("gid") ?? "";
  if (!GROUP_ID_RE.test(gid)) return apiError(c, 404, "not_found", "group not found");
  const group = await db.getGroup(c.env.DB, gid);
  if (!group) return apiError(c, 404, "not_found", "group not found");
  c.set("group", group);
  await next();
});

g.get("/", async (c) => {
  const group = c.get("group");
  const [members, bills] = await Promise.all([db.listMembers(c.env.DB, group.id), db.listBills(c.env.DB, group.id)]);
  return c.json({ group, members, bills });
});

g.patch("/", async (c) => {
  const patch = parseGroupPatch(await readJson(c));
  const group = await db.updateGroup(c.env.DB, c.get("group").id, patch);
  return c.json({ group });
});

g.post("/members", async (c) => {
  const name = parseMemberName(await readJson(c));
  const gid = c.get("group").id;
  if ((await db.countRows(c.env.DB, "members", gid)) >= LIMITS.membersPerGroup)
    return apiError(c, 409, "conflict", `at most ${LIMITS.membersPerGroup} members per group`);
  try {
    return c.json({ member: await db.addMember(c.env.DB, gid, name) }, 201);
  } catch (e) {
    if (isUnique(e)) return apiError(c, 409, "conflict", "a member with that name already exists");
    throw e;
  }
});

g.patch("/members/:mid", async (c) => {
  const mid = c.req.param("mid");
  if (!ENTITY_ID_RE.test(mid)) return apiError(c, 404, "not_found", "member not found");
  const name = parseMemberName(await readJson(c));
  try {
    const member = await db.renameMember(c.env.DB, c.get("group").id, mid, name);
    if (!member) return apiError(c, 404, "not_found", "member not found");
    return c.json({ member });
  } catch (e) {
    if (isUnique(e)) return apiError(c, 409, "conflict", "a member with that name already exists");
    throw e;
  }
});

g.delete("/members/:mid", async (c) => {
  const mid = c.req.param("mid");
  const gid = c.get("group").id;
  if (!ENTITY_ID_RE.test(mid)) return apiError(c, 404, "not_found", "member not found");
  if (await db.memberInUse(c.env.DB, gid, mid))
    return apiError(c, 409, "conflict", "member is used by bills; delete or edit those bills first");
  if (!(await db.deleteMember(c.env.DB, gid, mid))) return apiError(c, 404, "not_found", "member not found");
  return c.body(null, 204);
});

async function memberIdSet(c: Context<AppEnv & { Variables: { group: db.Group } }>) {
  return new Set((await db.listMembers(c.env.DB, c.get("group").id)).map((m) => m.id));
}

g.post("/bills", async (c) => {
  const gid = c.get("group").id;
  const input = parseBill(await readJson(c), await memberIdSet(c));
  if ((await db.countRows(c.env.DB, "bills", gid)) >= LIMITS.billsPerGroup)
    return apiError(c, 409, "conflict", `at most ${LIMITS.billsPerGroup} bills per group`);
  return c.json({ bill: await db.createBill(c.env.DB, gid, input) }, 201);
});

g.put("/bills/:bid", async (c) => {
  const bid = c.req.param("bid");
  const gid = c.get("group").id;
  if (!ENTITY_ID_RE.test(bid) || !(await db.getBill(c.env.DB, gid, bid)))
    return apiError(c, 404, "not_found", "bill not found");
  const input = parseBill(await readJson(c), await memberIdSet(c));
  return c.json({ bill: await db.updateBill(c.env.DB, gid, bid, input) });
});

g.delete("/bills/:bid", async (c) => {
  const bid = c.req.param("bid");
  if (!ENTITY_ID_RE.test(bid) || !(await db.deleteBill(c.env.DB, c.get("group").id, bid)))
    return apiError(c, 404, "not_found", "bill not found");
  return c.body(null, 204);
});

g.get("/summary", async (c) => {
  const gid = c.get("group").id;
  const [members, bills] = await Promise.all([db.listMembers(c.env.DB, gid), db.listBills(c.env.DB, gid)]);
  const balances = computeBalances(
    members.map((m) => m.id),
    bills,
  );
  const total = bills.filter((b) => b.kind === "expense").reduce((a, b) => a + b.amount, 0);
  return c.json({ balances, settlements: computeSettlements(balances), total });
});

api.route("/groups/:gid", g);
