// Who is making a request. This IS an authorization input (v0.4): a trip is visible only to identities linked
// to one of its people (members.email). On prod it comes from the Cloudflare Access JWT, verified in
// src/index.ts; headers are never trusted there. Locally (DEV_IDENTITY=1, set only by `wrangler dev --var`
// and the test configs) the Access email header is used, defaulting to DEV_DEFAULT_IDENTITY.

export const DEV_DEFAULT_IDENTITY = "dev@example.com";

// Conservative address shape: anything else (markup, quotes, spaces) is rejected rather than stored.
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;

export const cleanEmail = (v: unknown) => (typeof v === "string" && v.length <= 254 && EMAIL_RE.test(v) ? v.toLowerCase() : null);

/** From verified Access JWT claims: the user's email, or `svc:<client id>` for a service token. */
export function identityFromClaims(claims: Record<string, unknown>): string | null {
  const email = cleanEmail(claims.email);
  if (email) return email;
  const cn = claims.common_name;
  return typeof cn === "string" && CLIENT_ID_RE.test(cn) ? `svc:${cn}` : null;
}

/** Local development / tests only. A present-but-invalid header gives null, not the default. */
export function devIdentity(req: Request): string | null {
  const h = req.headers.get("Cf-Access-Authenticated-User-Email");
  return h === null ? DEV_DEFAULT_IDENTITY : cleanEmail(h);
}

export const isDevIdentity = (env: unknown) => (env as { DEV_IDENTITY?: string }).DEV_IDENTITY === "1";

/** For activity entries / display: service-token client ids are not shown. */
export const actorLabel = (identity: string | null) => (identity?.startsWith("svc:") ? "service token" : identity);
