// Validation for comments, saved subgroups and moving/merging bills between groups (pure).
import { cleanName, memberList, ValidationError } from "./validate";

export const SOCIAL_LIMITS = { commentMax: 500, commentsPerBill: 200, subgroupsPerGroup: 20, subgroupNameMax: 40 } as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function fail(msg: string): never {
  throw new ValidationError(msg);
}

export function parseComment(body: unknown, memberIds: ReadonlySet<string>): { body: string; authorMemberId: string | null } {
  if (!isObj(body)) fail("body must be an object");
  if (typeof body.body !== "string") fail("body must be a string");
  // Keep newlines (comments may be multi-line); strip other control chars.
  const text = body.body.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) fail("comment is empty");
  // Count code points (an emoji is one character), not UTF-16 units.
  if ([...text].length > SOCIAL_LIMITS.commentMax) fail(`comment must be at most ${SOCIAL_LIMITS.commentMax} characters`);
  let authorMemberId: string | null = null;
  if (body.memberId !== undefined && body.memberId !== null) {
    if (typeof body.memberId !== "string" || !memberIds.has(body.memberId)) fail("memberId must be a member of the group");
    authorMemberId = body.memberId;
  }
  return { body: text, authorMemberId };
}

export function parseSubgroup(body: unknown, memberIds: ReadonlySet<string>): { name: string; memberIds: string[] } {
  if (!isObj(body)) fail("body must be an object");
  return { name: cleanName(body.name, "name", SOCIAL_LIMITS.subgroupNameMax), memberIds: memberList(body.memberIds, "memberIds", memberIds) };
}

export function parseMove(body: unknown, field: "targetGroupId" | "sourceGroupId"): { groupId: string; addMissingMembers: boolean } {
  if (!isObj(body)) fail("body must be an object");
  const v = body[field];
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(v)) fail(`${field} must be a group id`);
  if (body.addMissingMembers !== undefined && typeof body.addMissingMembers !== "boolean") fail("addMissingMembers must be a boolean");
  return { groupId: v, addMissingMembers: body.addMissingMembers === true };
}

type Entry = { memberId: string } & Record<string, unknown>;

/** Rewrites member ids inside a normalized split (BillInput.split) using `map` (old → new). */
export function remapSplit(split: Record<string, unknown>, map: ReadonlyMap<string, string>): Record<string, unknown> {
  const m = (id: string) => map.get(id) ?? id;
  const e = (list: Entry[]) => list.map((x) => ({ ...x, memberId: m(x.memberId) }));
  const s = structuredClone(split);
  switch (s.mode) {
    case "equal": s.members = (s.members as string[]).map(m); break;
    case "exact": s.shares = e(s.shares as Entry[]); break;
    case "shares": s.weights = e(s.weights as Entry[]); break;
    case "percent": s.percents = e(s.percents as Entry[]); break;
    case "itemized": s.items = (s.items as { members: string[] }[]).map((it) => ({ ...it, members: it.members.map(m) })); break;
  }
  return s;
}

/**
 * Maps member ids of a source group onto a target group by name (case-insensitive).
 * Returns the map plus names that don't exist in the target.
 */
export function matchMembersByName(
  needed: { id: string; name: string }[],
  target: { id: string; name: string }[],
): { map: Map<string, string>; missing: { id: string; name: string }[] } {
  const byName = new Map(target.map((t) => [t.name.toLowerCase(), t.id]));
  const map = new Map<string, string>();
  const missing: { id: string; name: string }[] = [];
  for (const n of needed) {
    const hit = byName.get(n.name.toLowerCase());
    if (hit) map.set(n.id, hit);
    else missing.push(n);
  }
  return { map, missing };
}
