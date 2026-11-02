// v0.11 routes: a trip's own categories (#12), receipt scan (#2), email suggestions (#9), Web Push (#6).
// Registered by routes.ts (group router = members only; API router = any signed-in identity).
import type { Context, Hono } from "hono";
import { listMembers } from "./db";
import * as v11 from "./db-v11";
import { readLimited } from "./lib/body";
import { ENTITY_ID_RE } from "./lib/ids";
import { actorLabel } from "./lib/identity";
import { normalizeScan, runScan } from "./lib/scan";
import { b64uEncode, buildPushRequest, isPushEndpoint } from "./lib/webpush";
import { cleanName, CUSTOM_ICONS, ValidationError } from "./lib/validate";
import type { AppEnv, GroupEnv } from "./routes";

export interface V11Deps {
  apiError: (c: Context, status: number, code: string, message: string) => Response;
  readJson: (c: Context) => Promise<unknown>;
}

export const CATEGORIES_PER_TRIP = 20;
const SCAN_MAX = 2 * 1024 * 1024;

const isUnique = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Only the big browser push services: a stored endpoint is a URL the Worker will POST to. */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/];
export const allowedPushEndpoint = (url: string) => isPushEndpoint(url) && PUSH_HOSTS.some((re) => re.test(new URL(url).hostname));

/**
 * The push `Topic` header (lets the service replace an undelivered notice) travels unencrypted to Google / Apple /
 * Mozilla / Microsoft, so it must not be the trip id (ids are secrets): a hash of it instead (ISSUES #57).
 */
export async function pushTopic(gid: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`share-push-topic:${gid}`)));
  return b64uEncode(digest).slice(0, 32);
}

/** For tests: replaced to capture outgoing push requests instead of sending them. */
export const pushDeps = { fetch: (url: string, init: RequestInit) => fetch(url, init) };

function parseCategory(body: unknown) {
  if (!isObj(body)) throw new ValidationError("body must be an object");
  const name = cleanName(body.name, "name", 24);
  if (typeof body.icon !== "string" || !(CUSTOM_ICONS as readonly string[]).includes(body.icon)) throw new ValidationError("icon is not one of the allowed icons");
  return { name, icon: body.icon };
}

function sniffImage(b: Uint8Array): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

// ---------- push messages ----------

export type PushEvent =
  | { kind: "expense" | "payment"; who: string; description: string; amount: number; currency: string; to?: string; toIdentity?: string | null }
  | { kind: "comment"; who: string; description: string; text: string } // v0.12
  | { kind: "added"; who: string }; // v0.12: someone put your sign-in email on a person in this trip

function formatAmount(th: boolean, amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(th ? "th-TH" : "en", { style: "currency", currency, currencyDisplay: "narrowSymbol" })
      .format(amount / 10 ** (new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2));
  } catch {
    return `${amount} ${currency}`;
  }
}

/** The notice for one browser: `recipient` = that browser's identity (a payment to them says "paid you"). */
export function message(lang: string, trip: string, e: PushEvent, recipient?: string) {
  const th = lang === "th";
  let body: string;
  if (e.kind === "comment") {
    const text = [...e.text].length > 80 ? `${[...e.text].slice(0, 79).join("")}…` : e.text;
    body = th ? `${e.who} ใน “${e.description}”: ${text}` : `${e.who} on “${e.description}”: ${text}`;
  } else if (e.kind === "added") {
    body = th ? `${e.who} เพิ่มคุณเข้าทริปนี้` : `${e.who} added you to this trip`;
  } else {
    const amount = formatAmount(th, e.amount, e.currency);
    const toYou = e.kind === "payment" && !!recipient && e.toIdentity === recipient;
    body = e.kind === "payment"
      ? toYou ? (th ? `${e.who} โอนให้คุณ ${amount}` : `${e.who} paid you ${amount}`)
        : th ? `${e.who} โอนให้ ${e.to ?? ""} ${amount}` : `${e.who} paid ${e.to ?? ""} ${amount}`
      : th ? `${e.who} เพิ่ม “${e.description}” · ${amount}` : `${e.who} added “${e.description}” · ${amount}`;
  }
  return { title: trip, body };
}

/**
 * Tells everyone else in the trip (their browsers that turned notifications on). Never throws; dead subscriptions
 * (404/410 from the push service) are removed. Payloads are end-to-end encrypted to each browser.
 */
export async function notifyTrip(env: Env, gid: string, trip: string, actorIdentity: string | null, e: PushEvent, origin: string, only?: string) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return 0;
  const vapid = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: origin };
  const topic = await pushTopic(gid);
  let sent = 0;
  for (const s of await v11.pushTargets(env.DB, gid, actorIdentity, only)) {
    try {
      const { title, body } = message(s.lang, trip, e, s.identity);
      const { url, init } = await buildPushRequest({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        { title, body, url: `/g/${gid}`, tag: gid }, vapid, { ttl: 6 * 3600, topic });
      const res = await pushDeps.fetch(url, init);
      if (res.status === 404 || res.status === 410) await v11.deletePushSubscription(env.DB, s.endpoint);
      else if (res.ok) sent++;
    } catch (err) {
      console.warn("push failed", err instanceof Error ? err.message : "error"); // never log the endpoint (a capability URL)
    }
  }
  return sent;
}

/**
 * Sends a notice after the response (waitUntil), named after the caller's person in this trip. `build` gets the trip's
 * people by id; returning null sends nothing. `only` = just that identity's browsers. Never throws.
 */
export function pushInBackground(
  c: Context<GroupEnv>, build: (people: Map<string, { name: string; email: string | null }>, who: string) => PushEvent | null, only?: string,
) {
  const group = c.get("group");
  const work = (async () => {
    if (!c.env.VAPID_PUBLIC_KEY || !c.env.VAPID_PRIVATE_KEY) return;
    const people = new Map((await listMembers(c.env.DB, group.id)).map((m) => [m.id, { name: m.name, email: m.email }]));
    const me = c.get("me");
    const e = build(people, (me && people.get(me)?.name) || "Someone");
    if (e) await notifyTrip(c.env, group.id, group.name, c.get("identity"), e, new URL(c.req.url).origin, only);
  })().catch((err) => console.warn("notify failed", err instanceof Error ? err.message : "error"));
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    /* no execution context (some test harnesses): it still runs */
  }
}

export function registerV11(api: Hono<AppEnv>, g: Hono<GroupEnv>, { apiError, readJson }: V11Deps) {
  const actor = (c: Context<GroupEnv>) => actorLabel(c.get("identity"));
  const gidOf = (c: Context<GroupEnv>) => c.get("group").id;

  // ---------- categories ----------
  g.get("/categories", async (c) => c.json({ categories: await v11.listCategories(c.env.DB, gidOf(c)) }));

  g.post("/categories", async (c) => {
    const { name, icon } = parseCategory(await readJson(c));
    if ((await v11.countCategories(c.env.DB, gidOf(c))) >= CATEGORIES_PER_TRIP)
      return apiError(c, 409, "limit", `at most ${CATEGORIES_PER_TRIP} categories per trip`);
    try {
      return c.json({ category: await v11.saveCategory(c.env.DB, gidOf(c), null, name, icon, actor(c)) }, 201);
    } catch (e) {
      if (isUnique(e)) return apiError(c, 409, "conflict", "this trip already has a category with that name");
      throw e;
    }
  });

  g.patch("/categories/:cid", async (c) => {
    const cid = c.req.param("cid");
    if (!ENTITY_ID_RE.test(cid)) return apiError(c, 404, "not_found", "category not found");
    const { name, icon } = parseCategory(await readJson(c));
    try {
      const cat = await v11.saveCategory(c.env.DB, gidOf(c), cid, name, icon, actor(c));
      return cat ? c.json({ category: cat }) : apiError(c, 404, "not_found", "category not found");
    } catch (e) {
      if (isUnique(e)) return apiError(c, 409, "conflict", "this trip already has a category with that name");
      throw e;
    }
  });

  g.delete("/categories/:cid", async (c) => {
    const cid = c.req.param("cid");
    if (!ENTITY_ID_RE.test(cid) || !(await v11.deleteCategory(c.env.DB, gidOf(c), cid, actor(c)))) return apiError(c, 404, "not_found", "category not found");
    return c.body(null, 204);
  });

  // ---------- receipt scan ----------
  g.post("/scan", async (c) => {
    // Costs model time: its own small per-person limit on top of the API limit (src/index.ts).
    const identity = c.get("identity");
    if (identity && c.env.SCAN_LIMIT && !(await c.env.SCAN_LIMIT.limit({ key: identity })).success) {
      const res = apiError(c, 429, "rate_limited", "too many scans; wait a minute");
      res.headers.set("Retry-After", "60");
      return res;
    }
    const bytes = await readLimited(c.req.raw, SCAN_MAX);
    if (!bytes) return apiError(c, 413, "payload_too_large", "image must be at most 2 MB");
    const type = sniffImage(bytes);
    if (!type) return apiError(c, 415, "unsupported_media_type", "send a JPEG, PNG or WebP photo");
    let raw: unknown;
    try {
      raw = await runScan(c.env, bytes, type);
    } catch (e) {
      console.warn("scan failed", e instanceof Error ? e.message : "error");
      return apiError(c, 502, "scan_failed", "couldn't read the receipt right now; enter it by hand");
    }
    return c.json({ scan: normalizeScan(raw, c.get("group").currency, new Date().toISOString().slice(0, 10)) });
  });

  // ---------- email suggestions ----------
  api.get("/me/contacts", async (c) => {
    const identity = c.get("identity");
    if (!identity) return apiError(c, 401, "unauthorized", "sign in through Cloudflare Access");
    return c.json({ contacts: await v11.contactsFor(c.env.DB, identity) });
  });

  // ---------- Web Push ----------
  api.get("/push/key", (c) =>
    c.env.VAPID_PUBLIC_KEY && c.env.VAPID_PRIVATE_KEY ? c.json({ publicKey: c.env.VAPID_PUBLIC_KEY }) : apiError(c, 404, "push_off", "notifications are not set up"));

  api.post("/me/push", async (c) => {
    const identity = c.get("identity");
    if (!identity) return apiError(c, 401, "unauthorized", "sign in through Cloudflare Access");
    const b = await readJson(c);
    const keys = isObj(b) && isObj(b.keys) ? b.keys : null;
    const endpoint = isObj(b) && typeof b.endpoint === "string" && b.endpoint.length <= 600 ? b.endpoint : "";
    if (!allowedPushEndpoint(endpoint)) return apiError(c, 400, "validation", "endpoint must be a browser push service URL");
    const p256dh = typeof keys?.p256dh === "string" && /^[A-Za-z0-9_-]{86,88}$/.test(keys.p256dh) ? keys.p256dh : null;
    const auth = typeof keys?.auth === "string" && /^[A-Za-z0-9_-]{16,24}$/.test(keys.auth) ? keys.auth : null;
    if (!p256dh || !auth) return apiError(c, 400, "validation", "keys.p256dh and keys.auth are required");
    const lang = isObj(b) && b.lang === "th" ? "th" : "en";
    await v11.savePushSubscription(c.env.DB, { endpoint, identity, p256dh, auth, lang });
    return c.json({ ok: true }, 201);
  });

  api.delete("/me/push", async (c) => {
    const identity = c.get("identity");
    if (!identity) return apiError(c, 401, "unauthorized", "sign in through Cloudflare Access");
    const b = await readJson(c);
    const endpoint = isObj(b) && typeof b.endpoint === "string" ? b.endpoint : "";
    await v11.deletePushSubscription(c.env.DB, endpoint, identity);
    return c.body(null, 204);
  });
}
