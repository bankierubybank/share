import { Hono } from "hono";
import { api, apiError, type AppEnv } from "./routes";
import { ValidationError } from "./lib/validate";
import { verifyAccessJwt } from "./lib/access";

const MAX_BODY = 32 * 1024;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
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
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v);
  if (c.req.path.startsWith("/api/")) c.res.headers.set("Cache-Control", "no-store");
});

// Optional defense in depth: verify Cloudflare Access JWT when configured.
app.use("*", async (c, next) => {
  const team = c.env.ACCESS_TEAM_DOMAIN;
  const aud = c.env.ACCESS_AUD;
  if (team && aud) {
    const ok = await verifyAccessJwt(c.req.header("Cf-Access-Jwt-Assertion"), team, aud);
    if (!ok) return apiError(c, 401, "unauthorized", "valid Cloudflare Access token required");
  }
  await next();
});

app.use("/api/*", async (c, next) => {
  const m = c.req.method;
  if (m === "POST" || m === "PUT" || m === "PATCH") {
    const ct = c.req.header("Content-Type") ?? "";
    if (!/^application\/json\b/i.test(ct)) return apiError(c, 415, "unsupported_media_type", "Content-Type must be application/json");
    const len = Number(c.req.header("Content-Length") ?? "0");
    if (len > MAX_BODY) return apiError(c, 413, "payload_too_large", "request body too large");
    // Content-Length may be absent (chunked): enforce on actual bytes.
    const buf = await c.req.raw.clone().arrayBuffer();
    if (buf.byteLength > MAX_BODY) return apiError(c, 413, "payload_too_large", "request body too large");
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

export default app;
