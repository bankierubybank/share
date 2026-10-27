import { afterAll, describe, expect, it } from "vitest";
import { api, cleanupGroups, makeGroup } from "../helpers/http";

// v0.4 membership with one identity (works on prod: the service token is the caller). Multi-user cases are in
// test/integration/membership.test.ts and test/security/v4-security.test.ts (local, header-based identities).

afterAll(cleanupGroups);

type M = { id: string; name: string; email: string | null };
const rand = () => Math.random().toString(36).slice(2, 8);

describe("v0.4 trip membership (single caller)", () => {
  it("creator is linked; my trips; emails; last link; 'this is me'; view link hides emails", async () => {
    const g = await makeGroup(["Alice", "Bob", "Carol"]);
    const one = async () => (await api("GET", `/api/groups/${g.gid}`)).json as { me: string; members: M[] };

    // The creator is linked to the first person.
    let r = await one();
    expect(r.me).toBe(g.ids.Alice);
    const myId = r.members[0].email!;
    expect(myId).toBeTruthy();
    expect(r.members.slice(1).map((m) => m.email)).toEqual([null, null]);

    const mine = (await api("GET", "/api/me/groups")).json.groups as { id: string; memberName: string }[];
    expect(mine.find((x) => x.id === g.gid)?.memberName).toBe("Alice");

    // Only link: can't be removed.
    const clear = await api("PATCH", `/api/groups/${g.gid}/members/${g.ids.Alice}`, { email: null });
    expect(clear.status).toBe(409);
    expect(clear.json.error.code).toBe("last_link");

    // Add Bob's email (lowercased), refuse a duplicate.
    const bob = `Bob.${rand()}@Example.com`;
    const p = await api("PATCH", `/api/groups/${g.gid}/members/${g.ids.Bob}`, { email: bob });
    expect(p.status, p.text).toBe(200);
    expect(p.json.member.email).toBe(bob.toLowerCase());
    expect((await api("POST", `/api/groups/${g.gid}/members`, { name: "Dup", email: bob })).status).toBe(409);
    expect((await api("PATCH", `/api/groups/${g.gid}/members/${g.ids.Carol}`, { email: "nope" })).status).toBe(400);

    // "This is me" → Carol: my link moves (Alice unlinked); Bob's person is taken.
    expect((await api("POST", `/api/groups/${g.gid}/me`, { memberId: g.ids.Bob })).status).toBe(409);
    expect((await api("POST", `/api/groups/${g.gid}/me`, { memberId: g.ids.Carol })).status).toBe(200);
    r = await one();
    expect(r.me).toBe(g.ids.Carol);
    expect(r.members.map((m) => [m.name, m.email])).toEqual([["Alice", null], ["Bob", bob.toLowerCase()], ["Carol", myId]]);

    // Activity mentions the link but never the address.
    const act = JSON.stringify((await api("GET", `/api/groups/${g.gid}/activity`)).json);
    expect(act).toContain("member.email");
    expect(act).toContain("member.link");
    expect(act).not.toContain(bob.toLowerCase());

    // Read-only snapshot: no emails.
    const vid = (await api("POST", `/api/groups/${g.gid}/view-link`, {})).json.viewId as string;
    const view = await api("GET", `/api/view/${vid}`);
    expect(view.status).toBe(200);
    expect(view.text).not.toContain("@example.com");
    expect(view.text).not.toContain(myId);
  });
});
