// Comments, subgroups, read-only view links, move/merge. Registered by routes.ts on the group router.
import type { Context, Hono } from "hono";
import * as db from "./db";
import * as social from "./db-social";
import { ENTITY_ID_RE, GROUP_ID_RE } from "./lib/ids";
import { matchMembersByName, parseComment, parseMove, parseSubgroup, SOCIAL_LIMITS } from "./lib/social";
import { actorOf } from "./lib/actor";
import type { AppEnv } from "./routes";

type GroupEnv = AppEnv & { Variables: { group: db.Group } };
type GCtx = Context<GroupEnv>;

export interface SocialDeps {
  apiError: (c: Context, status: number, code: string, message: string) => Response;
  readJson: (c: Context) => Promise<unknown>;
  summaryOf: (members: db.Member[], bills: db.Bill[]) => unknown;
}

export function registerSocial(api: Hono<AppEnv>, g: Hono<GroupEnv>, { apiError, readJson, summaryOf }: SocialDeps) {
  const actor = (c: GCtx) => actorOf(c.req.raw);
  const gidOf = (c: GCtx) => c.get("group").id;
  const memberIds = async (c: GCtx) => new Set((await db.listMembers(c.env.DB, gidOf(c))).map((m) => m.id));
  const liveBill = async (c: GCtx) => {
    const bid = c.req.param("bid") ?? "";
    return ENTITY_ID_RE.test(bid) ? db.getBill(c.env.DB, gidOf(c), bid) : null;
  };

  // ---------- comments ----------
  g.get("/bills/:bid/comments", async (c) => {
    const bill = await liveBill(c);
    if (!bill) return apiError(c, 404, "not_found", "bill not found");
    return c.json({ comments: await social.listComments(c.env.DB, gidOf(c), bill.id) });
  });

  g.post("/bills/:bid/comments", async (c) => {
    const bill = await liveBill(c);
    if (!bill) return apiError(c, 404, "not_found", "bill not found");
    const input = parseComment(await readJson(c), await memberIds(c));
    if ((await social.countComments(c.env.DB, bill.id)) >= SOCIAL_LIMITS.commentsPerBill)
      return apiError(c, 409, "conflict", `at most ${SOCIAL_LIMITS.commentsPerBill} comments per bill`);
    const comment = await social.addComment(c.env.DB, gidOf(c), bill.id, input.body, input.authorMemberId, actor(c), bill.description);
    return c.json({ comment }, 201);
  });

  g.delete("/bills/:bid/comments/:cid", async (c) => {
    const cid = c.req.param("cid");
    const bill = await liveBill(c);
    if (!bill || !ENTITY_ID_RE.test(cid) || !(await social.deleteComment(c.env.DB, gidOf(c), bill.id, cid)))
      return apiError(c, 404, "not_found", "comment not found");
    return c.body(null, 204);
  });

  // ---------- subgroups ----------
  g.get("/subgroups", async (c) => c.json({ subgroups: await social.listSubgroups(c.env.DB, gidOf(c)) }));

  g.post("/subgroups", async (c) => {
    const input = parseSubgroup(await readJson(c), await memberIds(c));
    if ((await social.countSubgroups(c.env.DB, gidOf(c))) >= SOCIAL_LIMITS.subgroupsPerGroup)
      return apiError(c, 409, "conflict", `at most ${SOCIAL_LIMITS.subgroupsPerGroup} subgroups per group`);
    return c.json({ subgroup: await social.saveSubgroup(c.env.DB, gidOf(c), null, input.name, input.memberIds) }, 201);
  });

  g.put("/subgroups/:sid", async (c) => {
    const sid = c.req.param("sid");
    if (!ENTITY_ID_RE.test(sid)) return apiError(c, 404, "not_found", "subgroup not found");
    const input = parseSubgroup(await readJson(c), await memberIds(c));
    const sg = await social.saveSubgroup(c.env.DB, gidOf(c), sid, input.name, input.memberIds);
    return sg ? c.json({ subgroup: sg }) : apiError(c, 404, "not_found", "subgroup not found");
  });

  g.delete("/subgroups/:sid", async (c) => {
    const sid = c.req.param("sid");
    if (!ENTITY_ID_RE.test(sid) || !(await social.deleteSubgroup(c.env.DB, gidOf(c), sid))) return apiError(c, 404, "not_found", "subgroup not found");
    return c.body(null, 204);
  });

  // ---------- read-only view link ----------
  g.get("/view-link", async (c) => c.json({ viewId: await social.getViewId(c.env.DB, gidOf(c)) }));
  g.post("/view-link", async (c) => c.json({ viewId: await social.setViewId(c.env.DB, gidOf(c), true, actor(c)) }, 201));
  g.delete("/view-link", async (c) => {
    await social.setViewId(c.env.DB, gidOf(c), false, actor(c));
    return c.body(null, 204);
  });

  /** Read-only snapshot. Never exposes the group id (the edit secret) or receipts/activity. */
  api.get("/view/:vid", async (c) => {
    const vid = c.req.param("vid");
    const gid = GROUP_ID_RE.test(vid) ? await social.groupIdByViewId(c.env.DB, vid) : null;
    const group = gid ? await db.getGroup(c.env.DB, gid) : null;
    if (!group) return apiError(c, 404, "not_found", "link not found or revoked");
    const [members, bills] = await Promise.all([db.listMembers(c.env.DB, group.id), db.listBills(c.env.DB, group.id)]);
    const { id: _secret, ...publicGroup } = group;
    return c.json({
      group: publicGroup,
      members: members.map(({ promptpay: _pp, ...m }) => m),
      bills: bills.map(({ createdBy: _cb, hasReceipt: _r, recurrenceId: _rid, ...b }) => b),
      summary: summaryOf(members, bills),
      readOnly: true,
    });
  });

  // ---------- move / merge ----------

  async function prepareMove(c: GCtx, from: db.Group, to: db.Group, bills: db.Bill[], addMissing: boolean) {
    if (from.id === to.id) return { error: apiError(c, 400, "validation", "source and target are the same group") };
    if (from.currency !== to.currency)
      return { error: apiError(c, 400, "validation", `currencies differ (${from.currency} vs ${to.currency}); move needs the same currency`) };
    const [fromMembers, toMembers] = await Promise.all([db.listMembers(c.env.DB, from.id), db.listMembers(c.env.DB, to.id)]);
    const needed = social.membersUsedBy(bills, fromMembers);
    const { map, missing } = matchMembersByName(needed, toMembers);
    if (missing.length && !addMissing)
      return { error: c.json({ error: { code: "missing_members", message: `missing in target: ${missing.map((m) => m.name).join(", ")}`, missing: missing.map((m) => m.name) } }, 409) };
    if (toMembers.length + missing.length > 50) return { error: apiError(c, 409, "conflict", "target would exceed 50 members") };
    const added = await social.addMembersFor(c.env.DB, to.id, missing, actorOf(c.req.raw));
    for (const [k, v] of added) map.set(k, v);
    return { map, added: missing.map((m) => m.name) };
  }

  g.post("/bills/:bid/move", async (c) => {
    const from = c.get("group");
    const bill = await liveBill(c);
    if (!bill) return apiError(c, 404, "not_found", "bill not found");
    const { groupId, addMissingMembers } = parseMove(await readJson(c), "targetGroupId");
    const to = await db.getGroup(c.env.DB, groupId);
    if (!to) return apiError(c, 404, "not_found", "target group not found");
    if (to.archived) return apiError(c, 409, "archived", "target group is archived");
    const r = await prepareMove(c, from, to, [bill], addMissingMembers);
    if ("error" in r) return r.error;
    await social.moveBills(c.env.DB, from, to, [bill], r.map, actor(c));
    return c.json({ bill: await db.getBill(c.env.DB, to.id, bill.id), targetGroupId: to.id, addedMembers: r.added });
  });

  /** Moves every live bill of the source group into this group, then archives the source. */
  g.post("/merge", async (c) => {
    const to = c.get("group");
    const { groupId, addMissingMembers } = parseMove(await readJson(c), "sourceGroupId");
    const from = await db.getGroup(c.env.DB, groupId);
    if (!from) return apiError(c, 404, "not_found", "source group not found");
    const bills = await db.listBills(c.env.DB, from.id);
    if ((await db.countRows(c.env.DB, "bills", to.id)) + bills.length > 5000) return apiError(c, 409, "conflict", "would exceed 5000 bills");
    const r = await prepareMove(c, from, to, bills, addMissingMembers);
    if ("error" in r) return r.error;
    await social.moveBills(c.env.DB, from, to, bills, r.map, actor(c));
    // Stop the source's repeating bills (their templates point at the old members) and archive it.
    await c.env.DB.prepare("UPDATE recurrences SET active = 0, last_error = 'group merged' WHERE group_id = ? AND active = 1").bind(from.id).run();
    await db.updateGroup(c.env.DB, from.id, { archived: true }, actor(c), from);
    // entity null: the source's id is its edit secret and must not be readable from the target's activity.
    await db.logActivity(c.env.DB, to.id, actor(c), "group.merge", null, { from: from.name, bills: bills.length }).run();
    return c.json({ moved: bills.length, addedMembers: r.added, sourceArchived: true });
  });
}
