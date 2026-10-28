// Invite links (v0.6). Registered by routes.ts: management on the group router (members only), joining on the API
// router (any signed-in identity holding a live token). The join side never reveals the group id (the trip's
// secret) until the caller is linked.
import type { Context, Hono } from "hono";
import * as db from "./db";
import * as inv from "./db-invite";
import { ENTITY_ID_RE, GROUP_ID_RE } from "./lib/ids";
import { actorLabel } from "./lib/identity";
import { LIMITS, parseMemberName } from "./lib/validate";
import type { AppEnv, GroupEnv } from "./routes";


export interface InviteDeps {
  apiError: (c: Context, status: number, code: string, message: string) => Response;
  readJson: (c: Context) => Promise<unknown>;
}

const isUnique = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message);

export function registerInvites(api: Hono<AppEnv>, g: Hono<GroupEnv>, { apiError, readJson }: InviteDeps) {
  const actor = (c: { get(key: "identity"): string | null }) => actorLabel(c.get("identity"));

  // ---------- manage (trip members) ----------
  g.get("/invite", async (c) => c.json(await inv.inviteStatus(c.env.DB, c.get("group").id)));
  g.post("/invite", async (c) => c.json(await inv.createInvite(c.env.DB, c.get("group").id, actor(c)), 201));
  g.delete("/invite", async (c) => {
    await inv.revokeInvite(c.env.DB, c.get("group").id, actor(c));
    return c.body(null, 204);
  });

  // ---------- join (anyone signed in, with the token) ----------
  const gone = (c: Context) => apiError(c, 404, "not_found", "invite link not found, revoked or expired");

  /** Resolves the token + the caller's place in that trip. */
  async function lookup(c: Context<AppEnv>) {
    const token = c.req.param("token") ?? "";
    const identity = c.get("identity");
    if (!identity) return { error: apiError(c, 401, "unauthorized", "sign in through Cloudflare Access") };
    const group = GROUP_ID_RE.test(token) ? await inv.groupByInvite(c.env.DB, token) : null;
    if (!group) return { error: gone(c) };
    const access = await db.getGroupAccess(c.env.DB, group.id, identity);
    return { group, identity, meId: access?.meId ?? null };
  }

  api.get("/join/:token", async (c) => {
    const r = await lookup(c);
    if ("error" in r) return r.error;
    const { group, meId } = r;
    const trip = { name: group.name, currency: group.currency, archived: group.archived };
    if (meId) return c.json({ joined: true, groupId: group.id, me: meId, group: trip });
    if (group.archived) return apiError(c, 409, "archived", "this trip is archived; ask someone in it to unarchive it");
    // Names only (no emails / PromptPay); `taken` = already linked to someone.
    const members = (await db.listMembers(c.env.DB, group.id)).map((m) => ({ id: m.id, name: m.name, taken: m.email !== null }));
    return c.json({ joined: false, group: trip, members, expiresAt: group.expiresAt });
  });

  /** Body: `{ memberId }` (I'm this person) or `{ name }` (add me). Idempotent for someone already in the trip. */
  api.post("/join/:token", async (c) => {
    const r = await lookup(c);
    if ("error" in r) return r.error;
    const { group, identity } = r;
    if (r.meId) return c.json({ groupId: group.id, me: r.meId });
    if (group.archived) return apiError(c, 409, "archived", "this trip is archived; ask someone in it to unarchive it");
    const body = await readJson(c);
    const o = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    if ((o.memberId === undefined) === (o.name === undefined)) return apiError(c, 400, "validation", "send either memberId or name");

    if (o.memberId !== undefined) {
      if (typeof o.memberId !== "string" || !ENTITY_ID_RE.test(o.memberId)) return apiError(c, 400, "validation", "memberId is invalid");
      try {
        const out = await inv.joinAs(c.env.DB, group.id, o.memberId, identity, actor(c));
        if (out === "not_found") return apiError(c, 404, "not_found", "that person is not in this trip");
        if (out === "taken") return apiError(c, 409, "conflict", "that person is already linked to someone else");
      } catch (e) {
        if (!isUnique(e)) throw e;
        return raced(c, group.id, identity); // same identity joined meanwhile (another tab)
      }
      return c.json({ groupId: group.id, me: o.memberId });
    }

    const name = parseMemberName({ name: o.name });
    if ((await db.countRows(c.env.DB, "members", group.id)) >= LIMITS.membersPerGroup)
      return apiError(c, 409, "conflict", `at most ${LIMITS.membersPerGroup} members per group`);
    try {
      const m = await inv.joinAsNew(c.env.DB, group.id, name, identity, actor(c));
      return c.json({ groupId: group.id, me: m.id }, 201);
    } catch (e) {
      if (!isUnique(e)) throw e;
      if (/email/i.test(String(e))) return raced(c, group.id, identity);
      return apiError(c, 409, "conflict", "someone in this trip already has that name; pick them from the list or use another name");
    }
  });

  async function raced(c: Context<AppEnv>, gid: string, identity: string) {
    const access = await db.getGroupAccess(c.env.DB, gid, identity);
    return access?.meId ? c.json({ groupId: gid, me: access.meId }) : apiError(c, 409, "conflict", "please try again");
  }
}
