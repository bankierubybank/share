// Who is making a request, as told by Cloudflare Access. Used for display (activity log, "added by") only —
// it is NOT an authorization decision. Access sets these on requests it lets through to the origin.

function b64urlJson(part: string): Record<string, unknown> | null {
  try {
    const s = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(s + "=".repeat((4 - (s.length % 4)) % 4)));
  } catch {
    return null;
  }
}

// Conservative address shape: anything else (markup, quotes, spaces) is dropped rather than stored.
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$/;
const cleanEmail = (v: unknown) => (typeof v === "string" && v.length <= 254 && EMAIL_RE.test(v) ? v.toLowerCase() : null);

/** Email of the signed-in Access user, "service token" for service-token requests, else null. */
export function actorOf(req: Request): string | null {
  const email = cleanEmail(req.headers.get("Cf-Access-Authenticated-User-Email"));
  if (email) return email;
  const jwt = req.headers.get("Cf-Access-Jwt-Assertion");
  const payload = jwt ? b64urlJson(jwt.split(".")[1] ?? "") : null;
  const jwtEmail = cleanEmail(payload?.email);
  if (jwtEmail) return jwtEmail;
  if (payload && typeof payload.common_name === "string") return "service token";
  return null;
}
