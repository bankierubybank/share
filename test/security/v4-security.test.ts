import { afterAll, describe, expect, it } from "vitest";
import { api, BASE_URL, cleanupGroups, makeGroup, today } from "../helpers/http";

// v0.4: trips are visible only to linked identities.
// Locally (wrangler dev --var DEV_IDENTITY:1) the identity is the Cf-Access-Authenticated-User-Email header, so we can
// act as several people. On prod the identity is the verified Access JWT, so that header must change nothing.

afterAll(cleanupGroups);

const remote = !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE_URL);
const as = (email: string) => ({ "Cf-Access-Authenticated-User-Email": email });
const equal = (members: string[]) => ({ mode: "equal", members });

describe.skipIf(remote)("membership (local, several identities)", () => {
  async function privateTrip() {
    const g = await makeGroup(["Owner", "Guest"]);
    const bill = await api("POST", `/api/groups/${g.gid}/bills`, {
      description: "Secret dinner", date: today(), amount: 4200, paidBy: g.ids.Owner, split: equal([g.ids.Owner, g.ids.Guest]),
    });
    expect(bill.status, bill.text).toBe(201);
    return { ...g, bid: bill.json.bill.id as string };
  }

  it("an outsider with the link gets 403 everywhere and learns nothing", async () => {
    const t = await privateTrip();
    const out = as("outsider@evil.io");
    for (const [m, p, body] of [
      ["GET", ""], ["GET", "/summary"], ["GET", "/activity"], ["GET", `/bills/${t.bid}/comments`], ["GET", `/bills/${t.bid}/receipt`],
      ["PUT", `/bills/${t.bid}`, { description: "x", date: today(), amount: 1, paidBy: t.ids.Owner, split: equal([t.ids.Owner]) }],
      ["DELETE", `/bills/${t.bid}`], ["POST", "/me", { memberId: t.ids.Guest }],
      ["PATCH", `/members/${t.ids.Guest}`, { email: "outsider@evil.io" }],
    ] as [string, string, unknown?][]) {
      const r = await api(m, `/api/groups/${t.gid}${p}`, body, out);
      expect([m, p, r.status]).toEqual([m, p, 403]);
      expect(r.text).not.toContain("Secret dinner");
      expect(r.text).not.toContain("Owner");
    }
    // Still there for the owner (nothing was changed by the attempts).
    const own = await api("GET", `/api/groups/${t.gid}`);
    expect(own.json.bills.map((b: { description: string }) => b.description)).toEqual(["Secret dinner"]);
    expect(own.json.members.find((x: { name: string }) => x.name === "Guest").email).toBeNull();
  });

  it("an outsider can't pull a trip into theirs (merge) or push a bill into it (move)", async () => {
    const victim = await privateTrip();
    const theirs = await api("POST", "/api/groups", { name: "Attacker", currency: "USD", members: ["Owner", "Guest"] }, as("outsider@evil.io"));
    expect(theirs.status).toBe(201);
    const tgid = theirs.json.group.id as string;
    const merge = await api("POST", `/api/groups/${tgid}/merge`, { sourceGroupId: victim.gid, addMissingMembers: true }, as("outsider@evil.io"));
    expect(merge.status).toBe(404);
    expect((await api("GET", `/api/groups/${victim.gid}`)).json.bills).toHaveLength(1); // untouched

    const tb = await api("POST", `/api/groups/${tgid}/bills`, {
      description: "Spam", date: today(), amount: 1, paidBy: theirs.json.members[0].id, split: equal([theirs.json.members[0].id]),
    }, as("outsider@evil.io"));
    const move = await api("POST", `/api/groups/${tgid}/bills/${tb.json.bill.id}/move`, { targetGroupId: victim.gid, addMissingMembers: true }, as("outsider@evil.io"));
    expect(move.status).toBe(404);
    expect((await api("DELETE", `/api/groups/${tgid}`, undefined, as("outsider@evil.io"))).status).toBe(204);
  });

  it("my-trips lists only my trips; no identity → 401", async () => {
    const t = await privateTrip();
    const mine = (await api("GET", "/api/me/groups", undefined, as("outsider@evil.io"))).json.groups as { id: string }[];
    expect(mine.map((g) => g.id)).not.toContain(t.gid);
    for (const bad of ["<script>alert(1)</script>", "x@y@z", "a b@c.io"]) {
      expect((await api("GET", "/api/me/groups", undefined, as(bad))).status).toBe(401);
      expect((await api("GET", `/api/groups/${t.gid}`, undefined, as(bad))).status).toBe(401);
      expect((await api("POST", "/api/groups", { name: "X", currency: "USD", members: ["A"] }, as(bad))).status).toBe(401);
    }
  });

  it("a forged (unsigned) Access JWT is not an identity", async () => {
    const t = await privateTrip();
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const jwt = `${b64({ alg: "none" })}.${b64({ email: "outsider@evil.io" })}.sig`;
    // Default dev identity (the owner) is still the caller: the JWT is ignored, not trusted.
    const r = await api("GET", "/api/me", undefined, { "Cf-Access-Jwt-Assertion": jwt });
    expect(r.json.actor).not.toBe("outsider@evil.io");
    expect((await api("GET", `/api/groups/${t.gid}`, undefined, { ...as("outsider@evil.io"), "Cf-Access-Jwt-Assertion": jwt })).status).toBe(403);
  });
});

describe.skipIf(!remote)("membership (prod: identity only from the verified Access JWT)", () => {
  it("a spoofed Access email header doesn't change who I am", async () => {
    const r = await api("GET", "/api/me", undefined, as("victim@example.com"));
    expect(r.json.actor).toBe("service token");
    const g = await makeGroup(["Me", "You"]);
    const one = await api("GET", `/api/groups/${g.gid}`, undefined, as("victim@example.com"));
    expect(one.status).toBe(200); // still the service token's own trip
    expect(one.json.members[0].email).toMatch(/^svc:/);
  });
});
