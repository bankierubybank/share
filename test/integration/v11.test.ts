import { exports } from "cloudflare:workers";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { pushDeps } from "../../src/routes-v11";

// v0.11: a trip's own categories (#12), trip dates (#7), receipt scan (#2, canned via SCAN_FAKE), email suggestions
// (#9), Web Push (#6, outgoing requests captured), retry-safe offline edits (#8, ifUpdatedAt).

async function call(who: string, method: string, path: string, body?: unknown, raw?: { body: BodyInit; type: string }) {
  const headers: Record<string, string> = { "Cf-Access-Authenticated-User-Email": who };
  if (raw) headers["Content-Type"] = raw.type;
  else if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await exports.default.fetch(new Request(`http://example.com${path}`, { method, headers, body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

async function trip(owner: string, currency = "THB", people = ["Ann", "Ben"]) {
  const r = await call(owner, "POST", "/api/groups", { name: `T11 ${currency}`, currency, members: people });
  expect(r.status).toBe(201);
  return { gid: r.json.group.id as string, ids: (r.json.members as { id: string }[]).map((m) => m.id) };
}

const bill = (ids: string[], extra: Record<string, unknown> = {}) =>
  ({ description: "Dive", amount: 4000, paidBy: ids[0], date: "2026-10-20", category: "activities", split: { mode: "equal", members: ids }, ...extra });

describe("trip categories", () => {
  it("create, use on a bill, rename, delete (bills fall back to Other on screen, keep the id)", async () => {
    const t = await trip("c11@x.io");
    const r = await call("c11@x.io", "POST", `/api/groups/${t.gid}/categories`, { name: "Diving", icon: "beach_access" });
    expect(r.status).toBe(201);
    const cid = r.json.category.id as string;
    expect((await call("c11@x.io", "POST", `/api/groups/${t.gid}/categories`, { name: "diving", icon: "label" })).status).toBe(409);
    for (const bad of [{ name: "X", icon: "<svg>" }, { name: "", icon: "label" }, { name: "x".repeat(25), icon: "label" }, { icon: "label" }])
      expect((await call("c11@x.io", "POST", `/api/groups/${t.gid}/categories`, bad)).status, JSON.stringify(bad)).toBe(400);

    const b = await call("c11@x.io", "POST", `/api/groups/${t.gid}/bills`, bill(t.ids, { category: `c:${cid}` }));
    expect(b.status).toBe(201);
    expect(b.json.bill.category).toBe(`c:${cid}`);
    const sum = (await call("c11@x.io", "GET", `/api/groups/${t.gid}/summary`)).json;
    expect(sum.byCategory[`c:${cid}`]).toBe(4000);
    expect((await call("c11@x.io", "POST", `/api/groups/${t.gid}/bills`, bill(t.ids, { category: "c:AAAAAAAAAAAAAAAA" }))).status).toBe(400);

    expect((await call("c11@x.io", "PATCH", `/api/groups/${t.gid}/categories/${cid}`, { name: "Scuba", icon: "spa" })).json.category.name).toBe("Scuba");
    expect((await call("c11@x.io", "GET", `/api/groups/${t.gid}/full`)).json.categories).toEqual([{ id: cid, name: "Scuba", icon: "spa" }]);
    expect((await call("c11@x.io", "DELETE", `/api/groups/${t.gid}/categories/${cid}`)).status).toBe(204);
    expect((await call("c11@x.io", "GET", `/api/groups/${t.gid}`)).json.bills[0].category).toBe(`c:${cid}`);
    // ...and editing that bill again needs a valid category (the dialog then shows Other).
    expect((await call("c11@x.io", "PUT", `/api/groups/${t.gid}/bills/${b.json.bill.id}`, bill(t.ids, { category: "other" }))).status).toBe(200);
  });

  it("another trip's category id is refused; at most 20 per trip; the view link shows names", async () => {
    const a = await trip("c11b@x.io");
    const b = await trip("c11b@x.io");
    const cid = (await call("c11b@x.io", "POST", `/api/groups/${a.gid}/categories`, { name: "Mine", icon: "label" })).json.category.id;
    expect((await call("c11b@x.io", "POST", `/api/groups/${b.gid}/bills`, bill(b.ids, { category: `c:${cid}` }))).status).toBe(400);
    expect((await call("c11b@x.io", "PATCH", `/api/groups/${b.gid}/categories/${cid}`, { name: "Stolen", icon: "label" })).status).toBe(404);
    expect((await call("c11b@x.io", "DELETE", `/api/groups/${b.gid}/categories/${cid}`)).status).toBe(404);
    for (let i = 1; i < 20; i++) expect((await call("c11b@x.io", "POST", `/api/groups/${a.gid}/categories`, { name: `C${i}`, icon: "label" })).status).toBe(201);
    expect((await call("c11b@x.io", "POST", `/api/groups/${a.gid}/categories`, { name: "C21", icon: "label" })).status).toBe(409);
    const vid = (await call("c11b@x.io", "POST", `/api/groups/${a.gid}/view-link`, {})).json.viewId;
    const v = (await call("c11b@x.io", "GET", `/api/view/${vid}`)).json;
    expect(v.categories).toHaveLength(20);
    expect(JSON.stringify(v)).not.toContain(a.gid);
  });
});

describe("trip dates", () => {
  it("set, validated, cleared, logged", async () => {
    const t = await trip("d11@x.io");
    const p = (body: unknown) => call("d11@x.io", "PATCH", `/api/groups/${t.gid}`, body);
    let r = await p({ startDate: "2026-11-01", endDate: "2026-11-08" });
    expect(r.status).toBe(200);
    expect(r.json.group).toMatchObject({ startDate: "2026-11-01", endDate: "2026-11-08" });
    expect((await p({ endDate: "2026-10-31" })).status).toBe(400); // before the start
    expect((await p({ startDate: "2026-11-01", endDate: "2027-12-01" })).status).toBe(400); // > a year
    expect((await p({ startDate: "2026-02-30" })).status).toBe(400);
    r = await p({ endDate: null });
    expect(r.json.group).toMatchObject({ startDate: "2026-11-01", endDate: null });
    const acts = (await call("d11@x.io", "GET", `/api/groups/${t.gid}/activity`)).json.activity.map((a: { action: string }) => a.action);
    expect(acts.filter((a: string) => a === "group.dates")).toHaveLength(2);
  });
});

describe("receipt scan", () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
  it("returns checked suggestions in the trip currency (items too), or fx for another currency", async () => {
    const t = await trip("s11@x.io");
    const r = await call("s11@x.io", "POST", `/api/groups/${t.gid}/scan`, undefined, { body: JPEG, type: "image/jpeg" });
    expect(r.status).toBe(200);
    expect(r.json.scan).toEqual({
      description: "Som Tam Nua", amount: 28837, date: "2026-10-28", category: "food", // printed 28/10/2569 (Buddhist era)
      items: [{ description: "Som tam", amount: 12000 }, { description: "Grilled chicken", amount: 12500 }],
      serviceBp: 1000, taxBp: 700, // 24.50 service + 18.87 VAT on 245.00 → 288.37, the printed total
    });
    const usd = await trip("s11@x.io", "USD");
    const r2 = await call("s11@x.io", "POST", `/api/groups/${usd.gid}/scan`, undefined, { body: JPEG, type: "image/jpeg" });
    expect(r2.json.scan.fx).toEqual({ currency: "THB", amount: 28837 });
    expect(r2.json.scan.amount).toBeUndefined();
    expect(r2.json.scan.items).toBeUndefined();
  });

  it("only images, only members, only small", async () => {
    const t = await trip("s11b@x.io");
    const path = `/api/groups/${t.gid}/scan`;
    expect((await call("s11b@x.io", "POST", path, { image: "x" })).status).toBe(415); // JSON is not an image
    expect((await call("s11b@x.io", "POST", path, undefined, { body: new TextEncoder().encode("<svg/>"), type: "image/png" })).status).toBe(415);
    expect((await call("s11b@x.io", "POST", path, undefined, { body: new Uint8Array(2 * 1024 * 1024 + 10).fill(0xff), type: "image/jpeg" })).status).toBe(413);
    expect((await call("stranger11@x.io", "POST", path, undefined, { body: JPEG, type: "image/jpeg" })).status).toBe(403);
  });
});

describe("email suggestions", () => {
  it("people linked in my live trips; never me, service tokens, binned trips or strangers' trips", async () => {
    const me = "e11@x.io";
    const a = await trip(me, "THB", ["Me", "Bo", "Cy"]);
    await call(me, "PATCH", `/api/groups/${a.gid}/members/${a.ids[1]}`, { email: "bo11@x.io" });
    const binned = await trip(me, "THB", ["Me", "Dee"]);
    await call(me, "PATCH", `/api/groups/${binned.gid}/members/${binned.ids[1]}`, { email: "dee11@x.io" });
    await call(me, "DELETE", `/api/groups/${binned.gid}`);
    const other = await trip("zz11@x.io", "THB", ["Zed", "Eve"]);
    await call("zz11@x.io", "PATCH", `/api/groups/${other.gid}/members/${other.ids[1]}`, { email: "eve11@x.io" });
    const c = (await call(me, "GET", "/api/me/contacts")).json.contacts as { email: string; name: string }[];
    expect(c).toEqual([{ email: "bo11@x.io", name: "Bo" }]);
  });
});

describe("offline edits: ifUpdatedAt", () => {
  it("applies only if nobody changed the bill since", async () => {
    const t = await trip("o11@x.io");
    const b = (await call("o11@x.io", "POST", `/api/groups/${t.gid}/bills`, bill(t.ids))).json.bill;
    const stale = await call("o11@x.io", "PUT", `/api/groups/${t.gid}/bills/${b.id}`, bill(t.ids, { amount: 5000, ifUpdatedAt: "2000-01-01T00:00:00.000Z" }));
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("stale");
    const ok = await call("o11@x.io", "PUT", `/api/groups/${t.gid}/bills/${b.id}`, bill(t.ids, { amount: 5000, ifUpdatedAt: b.updatedAt }));
    expect(ok.status).toBe(200);
    expect(ok.json.bill.amount).toBe(5000);
  });
});

describe("Web Push", () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const realFetch = pushDeps.fetch;
  let reply = 201;
  pushDeps.fetch = async (url, init) => {
    sent.push({ url, init });
    return new Response(null, { status: reply });
  };
  afterEach(() => {
    sent.length = 0;
    reply = 201;
  });

  async function browserKeys() {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
    const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return { p256dh: b64u(raw), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
  }
  const waitFor = async (n: number) => {
    for (let i = 0; i < 50 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 20));
  };

  it("public key; subscriptions only for real push services and real keys", async () => {
    const k = (await call("p11@x.io", "GET", "/api/push/key")).json;
    expect(k.publicKey).toBe(env.VAPID_PUBLIC_KEY);
    const keys = await browserKeys();
    for (const endpoint of ["https://evil.example.com/push", "http://fcm.googleapis.com/fcm/send/x", "https://127.0.0.1/x", "https://fcm.googleapis.com.evil.io/x"])
      expect((await call("p11@x.io", "POST", "/api/me/push", { endpoint, keys })).status, endpoint).toBe(400);
    expect((await call("p11@x.io", "POST", "/api/me/push", { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "short", auth: keys.auth } })).status).toBe(400);
    expect((await call("p11@x.io", "POST", "/api/me/push", { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys })).status).toBe(201);
    expect((await call("p11@x.io", "DELETE", "/api/me/push", { endpoint: "https://fcm.googleapis.com/fcm/send/abc" })).status).toBe(204);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE identity = ?").bind("p11@x.io").first<{ n: number }>())!.n).toBe(0);
  });

  it("a new bill notifies everyone else in the trip (encrypted, VAPID), not the one who added it; gone browsers are dropped", async () => {
    const t = await trip("pa11@x.io");
    await call("pa11@x.io", "PATCH", `/api/groups/${t.gid}/members/${t.ids[1]}`, { email: "pb11@x.io" });
    await call("pa11@x.io", "POST", "/api/me/push", { endpoint: "https://fcm.googleapis.com/fcm/send/ann", keys: await browserKeys() });
    await call("pb11@x.io", "POST", "/api/me/push", { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/ben", keys: await browserKeys(), lang: "th" });
    expect((await call("pa11@x.io", "POST", `/api/groups/${t.gid}/bills`, bill(t.ids))).status).toBe(201);
    await waitFor(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.map((s) => s.url)).toEqual(["https://updates.push.services.mozilla.com/wpush/v2/ben"]);
    const h = sent[0].init.headers as Record<string, string>;
    expect(h["Content-Encoding"]).toBe("aes128gcm");
    expect(h.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    expect(JSON.parse(atob(h.Authorization.split(" ")[1].slice(2).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).aud).toBe("https://updates.push.services.mozilla.com");
    expect(new TextDecoder().decode(sent[0].init.body as Uint8Array)).not.toContain("Dive"); // encrypted

    // The push service says that browser is gone → its row is removed.
    sent.length = 0;
    reply = 410;
    await call("pa11@x.io", "POST", `/api/groups/${t.gid}/bills`, bill(t.ids, { description: "Lunch" }));
    await waitFor(1);
    await new Promise((r) => setTimeout(r, 50));
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE identity = ?").bind("pb11@x.io").first<{ n: number }>())!.n).toBe(0);
  });

  it("restores the real fetch afterwards", () => {
    pushDeps.fetch = realFetch;
    expect(pushDeps.fetch).toBe(realFetch);
  });
});
