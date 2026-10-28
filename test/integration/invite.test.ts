import { exports } from "cloudflare:workers";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// v0.6 invite links (docs/API.md → Invite links). Identity = Cf-Access-Authenticated-User-Email (DEV_IDENTITY=1).

async function call(who: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (who !== null) headers["Cf-Access-Authenticated-User-Email"] = who;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await exports.default.fetch(
    new Request(`http://example.com${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined };
}

type M = { id: string; name: string };

async function trip(owner: string, people = ["Ann", "Bob", "Cid"]) {
  const r = await call(owner, "POST", "/api/groups", { name: "Invite trip", currency: "THB", members: people });
  expect(r.status).toBe(201);
  const byName: Record<string, M> = Object.fromEntries((r.json.members as M[]).map((m) => [m.name, m]));
  return { gid: r.json.group.id as string, byName };
}

async function invite(owner: string, gid: string) {
  const r = await call(owner, "POST", `/api/groups/${gid}/invite`, {});
  expect(r.status).toBe(201);
  return r.json.token as string;
}

describe("invite links", () => {
  it("member creates a link; newcomer picks an unlinked person and gets in", async () => {
    const t = await trip("ann@x.io");
    expect((await call("ann@x.io", "GET", `/api/groups/${t.gid}/invite`)).json).toEqual({ active: false, expiresAt: null });
    const token = await invite("ann@x.io", t.gid);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const st = (await call("ann@x.io", "GET", `/api/groups/${t.gid}/invite`)).json;
    expect(st.active).toBe(true);
    expect(Date.parse(st.expiresAt) - Date.now()).toBeGreaterThan(13 * 86_400_000);

    const peek = await call("bob@x.io", "GET", `/api/join/${token}`);
    expect(peek.status).toBe(200);
    expect(peek.json.joined).toBe(false);
    expect(peek.json.group).toEqual({ name: "Invite trip", currency: "THB", archived: false });
    expect(peek.json.members).toEqual([
      { id: t.byName.Ann.id, name: "Ann", taken: true },
      { id: t.byName.Bob.id, name: "Bob", taken: false },
      { id: t.byName.Cid.id, name: "Cid", taken: false },
    ]);
    expect(JSON.stringify(peek.json)).not.toContain(t.gid); // the trip id stays secret until joined
    expect(JSON.stringify(peek.json)).not.toContain("ann@x.io");

    expect((await call("bob@x.io", "GET", `/api/groups/${t.gid}`)).status).toBe(403);
    const j = await call("bob@x.io", "POST", `/api/join/${token}`, { memberId: t.byName.Bob.id });
    expect(j.status).toBe(200);
    expect(j.json).toEqual({ groupId: t.gid, me: t.byName.Bob.id });
    const g = await call("bob@x.io", "GET", `/api/groups/${t.gid}`);
    expect(g.status).toBe(200);
    expect(g.json.me).toBe(t.byName.Bob.id);

    // Joining again is a no-op; peeking now says joined (and may return the id).
    expect((await call("bob@x.io", "POST", `/api/join/${token}`, { memberId: t.byName.Cid.id })).json).toEqual({ groupId: t.gid, me: t.byName.Bob.id });
    expect((await call("bob@x.io", "GET", `/api/join/${token}`)).json).toMatchObject({ joined: true, groupId: t.gid, me: t.byName.Bob.id });

    const act = (await call("ann@x.io", "GET", `/api/groups/${t.gid}/activity`)).json.activity as { action: string; detail: unknown }[];
    expect(act.map((a) => a.action)).toEqual(expect.arrayContaining(["invite.create", "member.join"]));
    expect(act.find((a) => a.action === "member.join")!.detail).toEqual({ name: "Bob" });
  });

  it("newcomer not on the list adds themselves by name", async () => {
    const t = await trip("ann2@x.io");
    const token = await invite("ann2@x.io", t.gid);
    expect((await call("dee@x.io", "POST", `/api/join/${token}`, { name: "bob" })).status).toBe(409); // name taken (case-insensitive)
    const j = await call("dee@x.io", "POST", `/api/join/${token}`, { name: " Dee " });
    expect(j.status).toBe(201);
    const g = (await call("dee@x.io", "GET", `/api/groups/${t.gid}`)).json;
    expect(g.members.map((m: M) => m.name)).toEqual(["Ann", "Bob", "Cid", "Dee"]);
    expect(g.members.find((m: M) => m.id === j.json.me).email).toBe("dee@x.io");
  });

  it("can't take someone already linked, or a person from another trip", async () => {
    const t = await trip("ann3@x.io");
    const other = await trip("zed@x.io", ["Zed", "Yan"]);
    const token = await invite("ann3@x.io", t.gid);
    expect((await call("eve@x.io", "POST", `/api/join/${token}`, { memberId: t.byName.Ann.id })).status).toBe(409);
    expect((await call("eve@x.io", "POST", `/api/join/${token}`, { memberId: other.byName.Yan.id })).status).toBe(404);
    expect((await call("eve@x.io", "GET", `/api/groups/${other.gid}`)).status).toBe(403);
    // Two newcomers race for Bob: one wins.
    const [a, b] = await Promise.all([
      call("p1@x.io", "POST", `/api/join/${token}`, { memberId: t.byName.Bob.id }),
      call("p2@x.io", "POST", `/api/join/${token}`, { memberId: t.byName.Bob.id }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it("bad bodies are rejected", async () => {
    const t = await trip("ann4@x.io");
    const token = await invite("ann4@x.io", t.gid);
    for (const body of [{}, { memberId: t.byName.Bob.id, name: "X" }, { memberId: "nope" }, { name: "" }, { name: 5 }])
      expect((await call("f@x.io", "POST", `/api/join/${token}`, body)).status).toBe(400);
  });

  it("rotate and revoke kill the old link; expired links are dead", async () => {
    const t = await trip("ann5@x.io");
    const t1 = await invite("ann5@x.io", t.gid);
    const t2 = await invite("ann5@x.io", t.gid);
    expect((await call("g@x.io", "GET", `/api/join/${t1}`)).status).toBe(404);
    expect((await call("g@x.io", "GET", `/api/join/${t2}`)).status).toBe(200);
    expect((await call("ann5@x.io", "DELETE", `/api/groups/${t.gid}/invite`)).status).toBe(204);
    expect((await call("g@x.io", "GET", `/api/join/${t2}`)).status).toBe(404);
    expect((await call("ann5@x.io", "GET", `/api/groups/${t.gid}/invite`)).json.active).toBe(false);

    const t3 = await invite("ann5@x.io", t.gid);
    await env.DB.prepare("UPDATE groups SET invite_expires = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(t.gid).run();
    expect((await call("g@x.io", "GET", `/api/join/${t3}`)).status).toBe(404);
    expect((await call("g@x.io", "POST", `/api/join/${t3}`, { name: "G" })).status).toBe(404);
    expect((await call("ann5@x.io", "GET", `/api/groups/${t.gid}/invite`)).json).toEqual({ active: false, expiresAt: null });
  });

  it("only the token's hash is stored", async () => {
    const t = await trip("ann6@x.io");
    const token = await invite("ann6@x.io", t.gid);
    const row = await env.DB.prepare("SELECT invite_hash FROM groups WHERE id = ?").bind(t.gid).first<{ invite_hash: string }>();
    expect(row!.invite_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.invite_hash).not.toContain(token);
  });

  it("only members manage invites; archived trips can't be joined but can be revoked", async () => {
    const t = await trip("ann7@x.io");
    for (const m of ["GET", "POST", "DELETE"]) expect((await call("out@x.io", m, `/api/groups/${t.gid}/invite`, m === "POST" ? {} : undefined)).status).toBe(403);
    const token = await invite("ann7@x.io", t.gid);
    expect((await call("ann7@x.io", "PATCH", `/api/groups/${t.gid}`, { archived: true })).status).toBe(200);
    expect((await call("h@x.io", "GET", `/api/join/${token}`)).status).toBe(409);
    expect((await call("h@x.io", "POST", `/api/join/${token}`, { name: "H" })).status).toBe(409);
    expect((await call("ann7@x.io", "POST", `/api/groups/${t.gid}/invite`, {})).status).toBe(409);
    expect((await call("ann7@x.io", "DELETE", `/api/groups/${t.gid}/invite`)).status).toBe(204);
  });

  it("join needs a signed-in identity and a well-formed token", async () => {
    const t = await trip("ann8@x.io");
    const token = await invite("ann8@x.io", t.gid);
    expect((await call(null, "GET", `/api/join/${token}`, undefined, { "Cf-Access-Authenticated-User-Email": "not-an-email" })).status).toBe(401);
    expect((await call("i@x.io", "GET", "/api/join/short")).status).toBe(404);
    expect((await call("i@x.io", "GET", `/api/join/${t.gid}`)).status).toBe(404); // the trip id is not an invite
  });
});

/** Counters are fixed one-minute windows: a burst that straddles a minute boundary is re-run once with a fresh key. */
async function inOneWindow<T>(burst: (key: Record<string, string>) => Promise<T>): Promise<{ out: T; key: Record<string, string> }> {
  for (let attempt = 0; ; attempt++) {
    const minute = Math.floor(Date.now() / 60_000);
    const key = { "X-Test-Rate-Key": `rl-${crypto.randomUUID()}` };
    const out = await burst(key);
    if (Math.floor(Date.now() / 60_000) === minute || attempt > 0) return { out, key };
  }
}

describe("rate limits", () => {
  it("link routes: 30 per minute per identity, then 429 with Retry-After", async () => {
    const { out: statuses, key } = await inOneWindow(async (key) => {
      const s: number[] = [];
      for (let i = 0; i < 35; i++) s.push((await call("rl@x.io", "GET", "/api/join/AAAAAAAAAAAAAAAAAAAAAA", undefined, key)).status);
      return s;
    });
    expect(statuses.slice(0, 30).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(30).every((s) => s === 429)).toBe(true);
    const r = await call("rl@x.io", "GET", "/api/view/AAAAAAAAAAAAAAAAAAAAAA", undefined, key);
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("60");
    expect(r.json.error.code).toBe("rate_limited");
    // Other API routes are on the larger budget; another key is unaffected.
    expect((await call("rl@x.io", "GET", "/api/health", undefined, key)).status).toBe(200);
    expect((await call("rl@x.io", "GET", "/api/join/AAAAAAAAAAAAAAAAAAAAAA", undefined, { "X-Test-Rate-Key": `other-${crypto.randomUUID()}` })).status).toBe(404);
  });

  it("whole API: 600 per minute per identity", async () => {
    const { out: first429 } = await inOneWindow(async (key) => {
      for (let i = 0; i < 610; i++) if ((await call("rl2@x.io", "GET", "/api/health", undefined, key)).status === 429) return i;
      return -1;
    });
    expect(first429).toBe(600);
  });

  it("without the test key, dev mode is not limited (E2E shares one identity)", async () => {
    for (let i = 0; i < 35; i++) expect((await call("rl3@x.io", "GET", "/api/join/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
  });
});
