import { createRemoteJWKSet, jwtVerify } from "jose";

// Cache JWKS per team domain across requests in the same isolate (keys only, no request state).
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(teamDomain: string) {
  let set = jwksCache.get(teamDomain);
  if (!set) {
    set = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, set);
  }
  return set;
}

/** Verifies the Cloudflare Access JWT. Returns true when valid for the configured team + audience. */
export async function verifyAccessJwt(token: string | null | undefined, teamDomain: string, aud: string): Promise<boolean> {
  if (!token) return false;
  try {
    await jwtVerify(token, jwks(teamDomain), { issuer: `https://${teamDomain}`, audience: aud });
    return true;
  } catch {
    return false;
  }
}
