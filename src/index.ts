import { Hono } from "hono";
import { api, apiError, RECEIPT_MAX, scheduledMaintenance, type AppEnv } from "./routes";
import { ValidationError } from "./lib/validate";
import { verifyAccessJwt } from "./lib/access";
import { devIdentity, identityFromClaims, isDevIdentity } from "./lib/identity";
import { readLimited } from "./lib/body";
import { timedD1 } from "./lib/dbtiming";
import { ratePlan } from "./lib/ratelimit";

const MAX_BODY = 32 * 1024;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  await next();
  // Asset responses may be immutable; rebuild so headers are mutable.
  c.res = new Response(c.res.body, c.res);
  // Keep a stricter per-route CSP (receipt images are served with `sandbox`).
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!c.res.headers.has(k)) c.res.headers.set(k, v);
  if (c.req.path.startsWith("/api/")) c.res.headers.set("Cache-Control", "no-store");
});

// Identity (who may open which trip): the verified Cloudflare Access JWT on prod. Headers are trusted only when
// DEV_IDENTITY=1 (local `wrangler dev --var` / test configs, never wrangler.jsonc). Neither → null → trip routes 401.
app.use("*", async (c, next) => {
  const team = c.env.ACCESS_TEAM_DOMAIN;
  const aud = c.env.ACCESS_AUD;
  if (isDevIdentity(c.env)) {
    c.set("identity", devIdentity(c.req.raw));
  } else if (team && aud) {
    const claims = await verifyAccessJwt(c.req.header("Cf-Access-Jwt-Assertion"), team, aud);
    if (!claims) return apiError(c, 401, "unauthorized", "valid Cloudflare Access token required");
    c.set("identity", identityFromClaims(claims));
  } else {
    c.set("identity", null);
  }
  await next();
});

// Rate limit per verified identity; who gets which limit: src/lib/ratelimit.ts.
app.use("/api/*", async (c, next) => {
  const { key, link } = ratePlan(
    c.get("identity"), c.req.header("CF-Connecting-IP") ?? null, c.req.path, c.req.header("X-Test-Rate-Key") ?? null, isDevIdentity(c.env),
  );
  if (key === null) return next();
  const limiters = link ? [c.env.API_LIMIT, c.env.LINK_LIMIT] : [c.env.API_LIMIT];
  for (const l of limiters) {
    if (!(await l.limit({ key })).success) {
      const res = apiError(c, 429, "rate_limited", "too many requests; wait a minute and try again");
      res.headers.set("Retry-After", "60");
      return res;
    }
  }
  await next();
});

app.use("/api/*", async (c, next) => {
  const m = c.req.method;
  if (m === "PUT" && /\/receipt$/.test(c.req.path)) {
    // Receipt upload: raw image body, sniffed in the route. Larger cap than JSON.
    if (!/^image\/(jpeg|png|webp)$/i.test(c.req.header("Content-Type") ?? ""))
      return apiError(c, 415, "unsupported_media_type", "Content-Type must be image/jpeg, image/png or image/webp");
    if (Number(c.req.header("Content-Length") ?? "0") > RECEIPT_MAX) return apiError(c, 413, "payload_too_large", "receipt must be at most 2 MB");
  } else if (m === "POST" || m === "PUT" || m === "PATCH") {
    const ct = c.req.header("Content-Type") ?? "";
    if (!/^application\/json\b/i.test(ct)) return apiError(c, 415, "unsupported_media_type", "Content-Type must be application/json");
    const len = Number(c.req.header("Content-Length") ?? "0");
    if (len > MAX_BODY) return apiError(c, 413, "payload_too_large", "request body too large");
    // Content-Length may be absent (chunked): enforce on actual bytes, without buffering more than the cap.
    if (!(await readLimited(c.req.raw.clone(), MAX_BODY))) return apiError(c, 413, "payload_too_large", "request body too large");
  }
  await next();
});

app.route("/api", api);

app.all("/api/*", (c) => apiError(c, 404, "not_found", "no such endpoint"));

app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));
app.all("*", (c) => apiError(c, 405, "method_not_allowed", "method not allowed"));

app.onError((err, c) => {
  if (err instanceof ValidationError) return apiError(c, 400, "validation", err.message);
  console.error("unhandled", err);
  return apiError(c, 500, "internal", "internal error");
});

const SLOW_MS = 800;

export default {
  // API responses carry `Server-Timing: db;dur=…;desc="N round trips", app;dur=…` (docs/ARCHITECTURE.md → Performance).
  async fetch(req, env, ctx) {
    const t0 = performance.now();
    const timer = timedD1(env.DB);
    const res = await app.fetch(req, { ...env, DB: timer.db }, ctx);
    const path = new URL(req.url).pathname;
    if (!path.startsWith("/api/")) return res;
    const ms = performance.now() - t0;
    const out = new Response(res.body, res);
    out.headers.append("Server-Timing", `db;dur=${Math.round(timer.ms())};desc="${timer.count()} round trips", app;dur=${Math.round(ms)}`);
    // Ids in the path are secrets: log the route shape only.
    if (ms > SLOW_MS) console.warn("slow request", { method: req.method, route: path.replace(/[A-Za-z0-9_-]{16,}/g, ":id"), ms: Math.round(ms), db: timer.count(), dbMs: Math.round(timer.ms()) });
    return out;
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(scheduledMaintenance(env));
  },
} satisfies ExportedHandler<Env>;
