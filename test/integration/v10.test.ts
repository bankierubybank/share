import { exports } from "cloudflare:workers";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { scheduledMaintenance } from "../../src/routes";

// v0.10 review fixes: deleted trips go to a 30-day bin (#3), a person's sign-in email is theirs once they've opened
// the trip (#3), comments are always by the signed-in person (#4).

const A = "ann10@x.io";
const B = "ben10@x.io";

async function call(who: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "Cf-Access-Authenticated-User-Email": who };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await exports.default.fetch(new Request(`http://example.com${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

/** Ann's trip; Ben linked and (optionally) has opened it. */
async function trip(benSeen = true) {
  const r = await call(A, "POST", "/api/groups", { name: "Bin trip", currency: "THB", members: ["Ann", "Ben"] });
  expect(r.status).toBe(201);
  const [ann, ben] = (r.json.members as { id: string }[]).map((m) => m.id);
  const gid = r.json.group.id as string;
  expect((await call(A, "PATCH", `/api/groups/${gid}/members/${ben}`, { email: B })).status).toBe(200);
  if (benSeen) expect((await call(B, "GET", `/api/groups/${gid}`)).status).toBe(200);
  return { gid, ann, ben };
}

const bill = (ids: string[]) => ({ description: "Taxi", amount: 1000, paidBy: ids[0], date: "2026-10-01", category: "transport", split: { mode: "equal", members: ids } });

describe("trip bin", () => {
  it("delete → hidden everywhere, 410 for its people, restorable by any of them", async () => {
    const t = await trip();
    expect((await call(A, "DELETE", `/api/groups/${t.gid}`)).status).toBe(204);
    for (const who of [A, B]) {
      const r = await call(who, "GET", `/api/groups/${t.gid}/full`);
      expect(r.status).toBe(410);
      expect(r.json.error.code).toBe("trip_deleted");
      expect((await call(who, "GET", "/api/me/groups")).json.groups.some((g: { id: string }) => g.id === t.gid)).toBe(false);
      expect((await call(who, "GET", "/api/me/overview")).json.trips.some((g: { groupId: string }) => g.groupId === t.gid)).toBe(false);
    }
    expect((await call(A, "POST", `/api/groups/${t.gid}/bills`, bill([t.ann]))).status).toBe(410);
    expect((await call("stranger@x.io", "GET", `/api/groups/${t.gid}/full`)).status).toBe(404);
    expect((await call("stranger@x.io", "POST", `/api/groups/${t.gid}/restore`, {})).status).toBe(404);

    const bin = (await call(B, "GET", "/api/me/deleted")).json.trips as { id: string; alone: boolean; deletedAt: string; purgeAt: string }[];
    const mine = bin.find((x) => x.id === t.gid)!;
    expect(mine.alone).toBe(false);
    expect(Date.parse(mine.purgeAt) - Date.parse(mine.deletedAt)).toBe(30 * 86_400_000);

    // Ben (not the one who deleted it) brings it back.
    const r = await call(B, "POST", `/api/groups/${t.gid}/restore`, {});
    expect(r.status).toBe(200);
    expect(r.json.group.id).toBe(t.gid);
    expect((await call(A, "GET", `/api/groups/${t.gid}/full`)).status).toBe(200);
    expect((await call(A, "POST", `/api/groups/${t.gid}/restore`, {})).status).toBe(409);
    const acts = (await call(A, "GET", `/api/groups/${t.gid}/activity`)).json.activity.map((a: { action: string }) => a.action);
    expect(acts).toEqual(expect.arrayContaining(["group.delete", "group.restore"]));
  });

  it("forever: refused while others are linked; allowed when alone", async () => {
    const t = await trip();
    const r = await call(A, "DELETE", `/api/groups/${t.gid}?forever=1`);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("others_linked");
    expect((await call(A, "GET", `/api/groups/${t.gid}`)).status).toBe(200); // untouched
    // Binned first, still refused for good.
    await call(A, "DELETE", `/api/groups/${t.gid}`);
    expect((await call(A, "DELETE", `/api/groups/${t.gid}?forever=1`)).status).toBe(409);

    const solo = await call(A, "POST", "/api/groups", { name: "Solo", currency: "THB", members: ["Ann", "Nobody"] });
    const sid = solo.json.group.id as string;
    await call(A, "DELETE", `/api/groups/${sid}`);
    expect((await call(A, "GET", "/api/me/deleted")).json.trips.find((x: { id: string }) => x.id === sid).alone).toBe(true);
    expect((await call(A, "DELETE", `/api/groups/${sid}?forever=1`)).status).toBe(204);
    expect((await call(A, "GET", `/api/groups/${sid}`)).status).toBe(404);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM groups WHERE id = ?").bind(sid).first<{ n: number }>())!.n).toBe(0);
  });

  it("invite links, view links and move/merge don't reach a binned trip", async () => {
    const t = await trip();
    const other = await call(A, "POST", "/api/groups", { name: "Other", currency: "THB", members: ["Ann", "Ben"] });
    const oid = other.json.group.id as string;
    const oAnn = other.json.members[0].id as string;
    const obid = (await call(A, "POST", `/api/groups/${oid}/bills`, bill([oAnn]))).json.bill.id as string;
    const token = (await call(A, "POST", `/api/groups/${t.gid}/invite`, {})).json.token as string;
    const vid = (await call(A, "POST", `/api/groups/${t.gid}/view-link`, {})).json.viewId as string;
    await call(A, "DELETE", `/api/groups/${t.gid}`);
    expect((await call("new@x.io", "GET", `/api/join/${token}`)).status).toBe(404);
    expect((await call(A, "GET", `/api/view/${vid}`)).status).toBe(404);
    expect((await call(A, "POST", `/api/groups/${oid}/bills/${obid}/move`, { targetGroupId: t.gid })).status).toBe(404);
    expect((await call(A, "POST", `/api/groups/${oid}/merge`, { sourceGroupId: t.gid })).status).toBe(404);
  });

  it("the daily job removes trips binned more than 30 days ago (with receipts), not newer ones", async () => {
    const old = await trip();
    const recent = await trip();
    await env.RECEIPTS.put(`${old.gid}/x/receipt`, "img");
    const bid = (await call(A, "POST", `/api/groups/${old.gid}/bills`, bill([old.ann]))).json.bill.id as string;
    await env.DB.prepare("UPDATE bills SET receipt_key = ? WHERE id = ?").bind(`${old.gid}/x/receipt`, bid).run();
    await call(A, "DELETE", `/api/groups/${old.gid}`);
    await call(A, "DELETE", `/api/groups/${recent.gid}`);
    await env.DB.prepare("UPDATE groups SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-31 days') WHERE id = ?").bind(old.gid).run();
    await env.DB.prepare("UPDATE groups SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-29 days') WHERE id = ?").bind(recent.gid).run();
    await scheduledMaintenance(env);
    const n = async (id: string) => (await env.DB.prepare("SELECT COUNT(*) n FROM groups WHERE id = ?").bind(id).first<{ n: number }>())!.n;
    expect(await n(old.gid)).toBe(0);
    expect(await n(recent.gid)).toBe(1);
    expect(await env.RECEIPTS.get(`${old.gid}/x/receipt`)).toBeNull();
  });
});

describe("sign-in email is yours once you've opened the trip", () => {
  it("others can fix a typed email until that person opens the trip; then only they can change it", async () => {
    const t = await trip(false);
    // Not opened yet: Ann fixes a typo.
    expect((await call(A, "PATCH", `/api/groups/${t.gid}/members/${t.ben}`, { email: "ben10b@x.io" })).status).toBe(200);
    expect((await call(A, "PATCH", `/api/groups/${t.gid}/members/${t.ben}`, { email: B })).status).toBe(200);
    expect((await call(B, "GET", `/api/groups/${t.gid}`)).status).toBe(200); // Ben opens it
    for (const email of ["thief@x.io", null]) {
      const r = await call(A, "PATCH", `/api/groups/${t.gid}/members/${t.ben}`, { email });
      expect(r.status, String(email)).toBe(403);
      expect(r.json.error.code).toBe("email_locked");
    }
    // Other fields, or the same email again, are fine.
    expect((await call(A, "PATCH", `/api/groups/${t.gid}/members/${t.ben}`, { name: "Benny", email: B })).status).toBe(200);
    // Ben himself can move his link to another address (which then counts as not opened yet).
    expect((await call(B, "PATCH", `/api/groups/${t.gid}/members/${t.ben}`, { email: "ben10new@x.io" })).status).toBe(200);
    expect((await call(A, "PATCH", `/api/groups/${t.gid}/members/${t.ben}`, { email: B })).status).toBe(200);
  });

  it("joining by invite link or claiming locks it at once; the creator is locked", async () => {
    const r = await call(A, "POST", "/api/groups", { name: "Inv", currency: "THB", members: ["Ann", "Cy"] });
    const gid = r.json.group.id as string;
    const [ann, cy] = (r.json.members as { id: string }[]).map((m) => m.id);
    const token = (await call(A, "POST", `/api/groups/${gid}/invite`, {})).json.token as string;
    expect((await call("cy10@x.io", "POST", `/api/join/${token}`, { memberId: cy })).status).toBe(200);
    expect((await call(A, "PATCH", `/api/groups/${gid}/members/${cy}`, { email: "x@x.io" })).status).toBe(403);
    expect((await call("cy10@x.io", "PATCH", `/api/groups/${gid}/members/${ann}`, { email: "x@x.io" })).status).toBe(403);
  });
});

describe("comments are by the signed-in person", () => {
  it("memberId in the body can't make a comment look like someone else's", async () => {
    const t = await trip();
    const bid = (await call(A, "POST", `/api/groups/${t.gid}/bills`, bill([t.ann, t.ben]))).json.bill.id as string;
    const r = await call(A, "POST", `/api/groups/${t.gid}/bills/${bid}/comments`, { body: "I'll pay it all — Ben", memberId: t.ben });
    expect(r.status).toBe(201);
    expect(r.json.comment.authorMemberId).toBe(t.ann);
    const r2 = await call(B, "POST", `/api/groups/${t.gid}/bills/${bid}/comments`, { body: "no" });
    expect(r2.json.comment.authorMemberId).toBe(t.ben);
  });
});
