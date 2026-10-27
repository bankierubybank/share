import { exports } from "cloudflare:workers";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// v0.4: a trip is visible only to identities linked to one of its people (docs/API.md → Membership).
// Integration runs with DEV_IDENTITY=1: identity comes from the Cf-Access-Authenticated-User-Email header.

async function call(who: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (who !== null) headers["Cf-Access-Authenticated-User-Email"] = who;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await exports.default.fetch(
    new Request(`http://example.com${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

type M = { id: string; name: string; email: string | null };

async function trip(owner: string, name: string, people: string[], emails: Record<string, string> = {}, me?: number) {
  const r = await call(owner, "POST", "/api/groups", { name, currency: "THB", members: people, ...(me === undefined ? {} : { me }) });
  expect(r.status).toBe(201);
  const gid = r.json.group.id as string;
  const byName: Record<string, M> = Object.fromEntries((r.json.members as M[]).map((m) => [m.name, m]));
  for (const [person, email] of Object.entries(emails)) {
    const p = await call(owner, "PATCH", `/api/groups/${gid}/members/${byName[person].id}`, { email });
    expect(p.status).toBe(200);
  }
  return { gid, byName };
}

const myTrips = async (who: string) => ((await call(who, "GET", "/api/me/groups")).json.groups as { id: string }[]).map((g) => g.id).sort();

describe("trip visibility follows membership", () => {
  it("ABC on trip 1, CDE on trip 2: A and B see trip 1, C sees both, D sees trip 2", async () => {
    const t1 = await trip("a@x.io", "Trip 1", ["A", "B", "C"], { B: "b@x.io", C: "c@x.io" });
    const t2 = await trip("c@x.io", "Trip 2", ["C", "D", "E"], { D: "d@x.io" });

    expect(await myTrips("a@x.io")).toEqual([t1.gid]);
    expect(await myTrips("b@x.io")).toEqual([t1.gid]);
    expect(await myTrips("c@x.io")).toEqual([t1.gid, t2.gid].sort());
    expect(await myTrips("d@x.io")).toEqual([t2.gid]);
    expect(await myTrips("nobody@x.io")).toEqual([]);

    expect((await call("c@x.io", "GET", `/api/groups/${t1.gid}`)).status).toBe(200);
    expect((await call("c@x.io", "GET", `/api/groups/${t2.gid}`)).status).toBe(200);
    for (const who of ["a@x.io", "b@x.io"]) {
      const r = await call(who, "GET", `/api/groups/${t2.gid}`);
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe("not_member");
      expect(JSON.stringify(r.json)).not.toContain("Trip 2"); // nothing about the trip leaks
    }
    expect((await call("d@x.io", "GET", `/api/groups/${t1.gid}`)).status).toBe(403);
  });

  it("every group route is gated, not just GET /", async () => {
    const t = await trip("own@x.io", "Gated", ["Own", "Other"]);
    const other = t.byName.Other.id;
    const paths: [string, string, unknown?][] = [
      ["GET", "/summary"], ["GET", "/activity"], ["GET", "/recurring"], ["GET", "/subgroups"], ["GET", "/view-link"],
      ["PATCH", "", { name: "x" }], ["DELETE", ""], ["POST", "/members", { name: "Z" }],
      ["PATCH", `/members/${other}`, { email: "intruder@x.io" }],
      ["POST", "/bills", { description: "x", amount: 100, paidBy: other, date: "2026-10-01", split: { mode: "equal", members: [other] } }],
      ["POST", "/view-link", {}], ["POST", "/merge", { sourceGroupId: t.gid }],
    ];
    for (const [m, p, body] of paths) expect([m, p, (await call("intruder@x.io", m, `/api/groups/${t.gid}${p}`, body)).status]).toEqual([m, p, 403]);
    expect((await call("own@x.io", "GET", `/api/groups/${t.gid}`)).status).toBe(200); // still intact
  });

  it("GET returns `me` and member emails; creator is linked to the person picked with `me`", async () => {
    const t = await trip("z@x.io", "Me", ["Ann", "Zed"], {}, 1);
    const r = await call("z@x.io", "GET", `/api/groups/${t.gid}`);
    expect(r.json.me).toBe(t.byName.Zed.id);
    expect((r.json.members as M[]).map((m) => [m.name, m.email])).toEqual([["Ann", null], ["Zed", "z@x.io"]]);
    expect((await call("z@x.io", "POST", "/api/groups", { name: "Bad", currency: "THB", members: ["A"], me: 3 })).status).toBe(400);
  });

  it("no identity → 401", async () => {
    expect((await call("<script>", "POST", "/api/groups", { name: "X", currency: "THB", members: ["A"] })).status).toBe(401);
    expect((await call("<script>", "GET", "/api/me/groups")).status).toBe(401);
    const t = await trip("q@x.io", "Q", ["Q"]);
    expect((await call("not an email", "GET", `/api/groups/${t.gid}`)).status).toBe(401);
  });
});

describe("unclaimed (pre-0.4) trips", () => {
  async function legacy() {
    const t = await trip("tmp@x.io", "Legacy", ["Ann", "Ben"]);
    await env.DB.prepare("UPDATE members SET email = NULL WHERE group_id = ?").bind(t.gid).run();
    return t;
  }

  it("first visitor picks who they are; then the trip is locked to linked people", async () => {
    const t = await legacy();
    const r = await call("ben@x.io", "GET", `/api/groups/${t.gid}`);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("claim_required");
    expect(r.json.error.members).toEqual([{ id: t.byName.Ann.id, name: "Ann" }, { id: t.byName.Ben.id, name: "Ben" }]);
    expect(r.json.bills).toBeUndefined();

    expect((await call("ben@x.io", "POST", `/api/groups/${t.gid}/me`, { memberId: t.byName.Ben.id })).status).toBe(200);
    const g = await call("ben@x.io", "GET", `/api/groups/${t.gid}`);
    expect(g.status).toBe(200);
    expect(g.json.me).toBe(t.byName.Ben.id);

    const late = await call("ann@x.io", "GET", `/api/groups/${t.gid}`);
    expect(late.json.error.code).toBe("not_member");
    expect((await call("ann@x.io", "POST", `/api/groups/${t.gid}/me`, { memberId: t.byName.Ann.id })).status).toBe(403);
  });

  it("can be claimed while archived", async () => {
    const t = await legacy();
    await env.DB.prepare("UPDATE groups SET archived_at = '2026-01-01T00:00:00Z' WHERE id = ?").bind(t.gid).run();
    expect((await call("ann@x.io", "POST", `/api/groups/${t.gid}/me`, { memberId: t.byName.Ann.id })).status).toBe(200);
  });
});

describe("linking people", () => {
  it("move my link to another (unlinked) person", async () => {
    const t = await trip("a@y.io", "Swap", ["Wrong", "Right", "Taken"], { Taken: "t@y.io" });
    expect((await call("a@y.io", "POST", `/api/groups/${t.gid}/me`, { memberId: t.byName.Taken.id })).status).toBe(409);
    const r = await call("a@y.io", "POST", `/api/groups/${t.gid}/me`, { memberId: t.byName.Right.id });
    expect(r.status).toBe(200);
    const g = await call("a@y.io", "GET", `/api/groups/${t.gid}`);
    expect(g.json.me).toBe(t.byName.Right.id);
    expect((g.json.members as M[]).find((m) => m.name === "Wrong")?.email).toBeNull();
  });

  it("emails: validated, lowercased, unique per trip, last link can't be removed", async () => {
    const t = await trip("solo@y.io", "Emails", ["Solo", "Pal", "Gone"]);
    const url = (p: string) => `/api/groups/${t.gid}/members/${t.byName[p].id}`;
    expect((await call("solo@y.io", "PATCH", url("Pal"), { email: "not-an-email" })).status).toBe(400);
    expect((await call("solo@y.io", "PATCH", url("Pal"), { email: "SOLO@y.io" })).status).toBe(409);
    expect((await call("solo@y.io", "PATCH", url("Solo"), { email: null })).json.error.code).toBe("last_link");
    expect((await call("solo@y.io", "DELETE", url("Solo"))).json.error.code).toBe("last_link");
    const p = await call("solo@y.io", "PATCH", url("Pal"), { email: "Pal@Y.io" });
    expect(p.json.member.email).toBe("pal@y.io");
    // Now someone else is linked: Solo may leave.
    expect((await call("solo@y.io", "PATCH", url("Solo"), { email: null })).status).toBe(200);
    expect((await call("solo@y.io", "GET", `/api/groups/${t.gid}`)).status).toBe(403);
    expect((await call("pal@y.io", "GET", `/api/groups/${t.gid}`)).status).toBe(200);
  });

  it("move / merge need membership in both trips; added people are not linked", async () => {
    const mine = await trip("m@y.io", "Mine", ["M", "Sam"], { Sam: "sam@y.io" });
    const theirs = await trip("x@y.io", "Theirs", ["X", "M"]);
    expect((await call("m@y.io", "POST", `/api/groups/${mine.gid}/merge`, { sourceGroupId: theirs.gid })).status).toBe(404);
    const bill = await call("m@y.io", "POST", `/api/groups/${mine.gid}/bills`, {
      description: "Taxi", amount: 300, paidBy: mine.byName.Sam.id, date: "2026-10-01", split: { mode: "equal", members: [mine.byName.Sam.id] },
    });
    expect((await call("m@y.io", "POST", `/api/groups/${mine.gid}/bills/${bill.json.bill.id}/move`, { targetGroupId: theirs.gid, addMissingMembers: true })).status).toBe(404);

    // Once M is linked in "Theirs" too, the move works and Sam is added without an email.
    expect((await call("x@y.io", "PATCH", `/api/groups/${theirs.gid}/members/${theirs.byName.M.id}`, { email: "m@y.io" })).status).toBe(200);
    const mv = await call("m@y.io", "POST", `/api/groups/${mine.gid}/bills/${bill.json.bill.id}/move`, { targetGroupId: theirs.gid, addMissingMembers: true });
    expect(mv.status).toBe(200);
    const g = await call("x@y.io", "GET", `/api/groups/${theirs.gid}`);
    expect((g.json.members as M[]).find((m) => m.name === "Sam")?.email).toBeNull();
    expect(await myTrips("sam@y.io")).toEqual([mine.gid]);
  });

  it("read-only view snapshot has no emails", async () => {
    const t = await trip("v@y.io", "View", ["V", "W"], { W: "w@y.io" });
    const vid = (await call("v@y.io", "POST", `/api/groups/${t.gid}/view-link`, {})).json.viewId;
    const v = await call("someone@else.io", "GET", `/api/view/${vid}`);
    expect(v.status).toBe(200);
    expect(JSON.stringify(v.json)).not.toMatch(/@y\.io/);
  });
});
