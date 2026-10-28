import { afterAll, describe, expect, it } from "vitest";
import { api, BASE_URL, cleanupGroups, makeGroup, today } from "../helpers/http";

// v0.6 invite links. The join side must never hand out the trip id (its secret), emails, PromptPay or bills to
// someone not yet in the trip, and must not accept junk tokens.

afterAll(cleanupGroups);

const remote = !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE_URL);
const as = (email: string) => ({ "Cf-Access-Authenticated-User-Email": email });

async function tripWithInvite() {
  const g = await makeGroup(["Owner", "Guest"]);
  const pp = await api("PATCH", `/api/groups/${g.gid}/members/${g.ids.Owner}`, { promptpay: "0812345678" });
  expect(pp.status, pp.text).toBe(200);
  const bill = await api("POST", `/api/groups/${g.gid}/bills`, {
    description: "Secret dinner", date: today(), amount: 4200, paidBy: g.ids.Owner, split: { mode: "equal", members: [g.ids.Owner, g.ids.Guest] },
  });
  expect(bill.status, bill.text).toBe(201);
  const inv = await api("POST", `/api/groups/${g.gid}/invite`, {});
  expect(inv.status, inv.text).toBe(201);
  return { ...g, token: inv.json.token as string };
}

describe("invite links (any target)", () => {
  it("the token is not the trip id and the trip id is not a token", async () => {
    const t = await tripWithInvite();
    expect(t.token).not.toBe(t.gid);
    expect((await api("GET", `/api/join/${t.gid}`)).status).toBe(404);
  });

  it("junk tokens never 2xx/5xx", async () => {
    for (const p of ["x", "%00", "..%2F..%2Fapi%2Fhealth", "A".repeat(200), "AAAAAAAAAAAAAAAAAAAAA*", "' OR 1=1 --"]) {
      for (const m of ["GET", "POST"]) {
        const r = await api(m, `/api/join/${p}`, m === "POST" ? { name: "X" } : undefined);
        expect([m, p, r.status < 500 && !(r.status >= 200 && r.status < 300)]).toEqual([m, p, true]);
      }
    }
  });

  it("join is CSRF-guarded like every write (JSON only)", async () => {
    const t = await tripWithInvite();
    const r = await api("POST", `/api/join/${t.token}`, "name=Mallory", { "Content-Type": "application/x-www-form-urlencoded" });
    expect(r.status).toBe(415);
  });

  it("a member peeking at their own invite just gets their trip; a spoofed identity header changes nothing on prod", async () => {
    const t = await tripWithInvite();
    const r = await api("GET", `/api/join/${t.token}`);
    expect(r.json).toMatchObject({ joined: true, groupId: t.gid });
    if (remote) {
      // Prod ignores the dev header: still the service token's identity (already in the trip).
      const s = await api("POST", `/api/join/${t.token}`, { name: "Spoofed" }, as("victim@example.com"));
      expect(s.status).toBe(200);
      expect(s.json.groupId).toBe(t.gid);
      const members = (await api("GET", `/api/groups/${t.gid}`)).json.members as { name: string }[];
      expect(members.map((m) => m.name)).toEqual(["Owner", "Guest"]);
    }
  });
});

describe.skipIf(remote)("invite links (local, several identities)", () => {
  it("an outsider peeking learns names only — no trip id, emails, PromptPay or bills", async () => {
    const t = await tripWithInvite();
    const r = await api("GET", `/api/join/${t.token}`, undefined, as("outsider@evil.io"));
    expect(r.status).toBe(200);
    expect(r.json.joined).toBe(false);
    for (const secret of [t.gid, "dev@example.com", "0812345678", "Secret dinner", "4200"]) expect(r.text).not.toContain(secret);
    expect(Object.keys(r.json.members[0]).sort()).toEqual(["id", "name", "taken"]);
  });

  it("a token for trip A can't be used to join trip B, and joining grants only that trip", async () => {
    const a = await tripWithInvite();
    const b = await tripWithInvite();
    const j = await api("POST", `/api/join/${a.token}`, { memberId: b.ids.Guest }, as("mallory@evil.io"));
    expect(j.status).toBe(404);
    const ok = await api("POST", `/api/join/${a.token}`, { memberId: a.ids.Guest }, as("mallory@evil.io"));
    expect(ok.status).toBe(200);
    expect((await api("GET", `/api/groups/${a.gid}`, undefined, as("mallory@evil.io"))).status).toBe(200);
    expect((await api("GET", `/api/groups/${b.gid}`, undefined, as("mallory@evil.io"))).status).toBe(403);
  });

  it("a newcomer can't take over a linked person, or join as a name that's taken", async () => {
    const t = await tripWithInvite();
    expect((await api("POST", `/api/join/${t.token}`, { memberId: t.ids.Owner }, as("mallory@evil.io"))).status).toBe(409);
    expect((await api("POST", `/api/join/${t.token}`, { name: "OWNER" }, as("mallory@evil.io"))).status).toBe(409);
    const owner = (await api("GET", `/api/groups/${t.gid}`)).json.members.find((m: { name: string }) => m.name === "Owner");
    expect(owner.email).toBe("dev@example.com");
  });

  it("non-members can't see, rotate or revoke a trip's invite", async () => {
    const t = await tripWithInvite();
    for (const m of ["GET", "POST", "DELETE"]) {
      const r = await api(m, `/api/groups/${t.gid}/invite`, m === "POST" ? {} : undefined, as("outsider@evil.io"));
      expect([m, r.status]).toEqual([m, 403]);
      expect(r.text).not.toContain("token");
    }
    expect((await api("GET", `/api/join/${t.token}`, undefined, as("someone@x.io"))).status).toBe(200); // still live
  });
});
