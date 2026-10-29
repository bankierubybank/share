/**
 * Web Push from a Worker using only WebCrypto: RFC 8291 (aes128gcm payload encryption) + RFC 8292 (VAPID).
 * No dependencies; works in Workers and Node 24.
 */

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string }; // base64url
}
export interface VapidKeys {
  publicKey: string; // base64url, 65-byte uncompressed P-256 point
  privateKey: string; // base64url, 32-byte scalar d
  subject: string; // "mailto:..." or "https://..."
}

/** A push message body may be at most 4096 bytes: 86 header + 16 GCM tag + 1 delimiter leave 3993 for the payload. */
export const MAX_PAYLOAD_BYTES = 3993;
const RECORD_SIZE = 4096;
const enc = new TextEncoder();

// --- base64url / bytes helpers ---

export function b64uEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** HKDF-SHA256 (extract + expand in one deriveBits call). */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** WebCrypto can't import a raw scalar, so wrap d + the public point's x/y into a JWK. */
function importPrivate(publicKey: Uint8Array, d: Uint8Array, alg: { name: string; namedCurve: string }, usages: ("sign" | "deriveBits")[]) {
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error("public key must be a 65-byte uncompressed P-256 point");
  if (d.length !== 32) throw new Error("private key must be 32 bytes");
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: b64uEncode(d),
    x: b64uEncode(publicKey.slice(1, 33)),
    y: b64uEncode(publicKey.slice(33, 65)),
  };
  return crypto.subtle.importKey("jwk", jwk, alg, false, usages);
}

// The Workers typings name this field `$public`; the runtime (and Node) expect `public`.
const ecdhParams = (pub: CryptoKey) => ({ name: "ECDH", public: pub }) as unknown as SubtleCryptoDeriveKeyAlgorithm;

/** RFC 8291 aes128gcm body: salt(16) | rs(4) | idlen(1) | keyid(server public key) | ciphertext. */
export async function encryptPayload(
  sub: PushSubscriptionJson,
  payload: Uint8Array,
  opts: { salt?: Uint8Array; serverKeys?: { publicKey: Uint8Array; privateKey: Uint8Array } } = {},
): Promise<Uint8Array> {
  const uaPublic = b64uDecode(sub.keys.p256dh);
  const authSecret = b64uDecode(sub.keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("invalid p256dh key");
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error("salt must be 16 bytes");

  // Ephemeral server (application server) key pair, unless injected for test vectors.
  let asPublic: Uint8Array;
  let asPrivate: CryptoKey;
  if (opts.serverKeys) {
    asPublic = opts.serverKeys.publicKey;
    asPrivate = await importPrivate(asPublic, opts.serverKeys.privateKey, { name: "ECDH", namedCurve: "P-256" }, ["deriveBits"]);
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
    asPrivate = pair.privateKey;
  }

  const uaKey = await crypto.subtle.importKey("raw", uaPublic as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams(uaKey), asPrivate, 256));

  // RFC 8291 3.3-3.4: IKM mixes the auth secret and both public keys; CEK/nonce come from the salt.
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  // 0x02 = delimiter of the last (here: only) record.
  const plaintext = concat(payload, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, aes, plaintext as BufferSource));

  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = asPublic.length;
  return concat(header, asPublic, ct);
}

/** RFC 8292: `vapid t=<ES256 JWT>, k=<public key>`; the JWT audience is the push service's origin. */
export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64uEncode(
    enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + 12 * 3600, sub: vapid.subject })),
  );
  const key = await importPrivate(b64uDecode(vapid.publicKey), b64uDecode(vapid.privateKey), { name: "ECDSA", namedCurve: "P-256" }, ["sign"]);
  // WebCrypto already returns raw r||s (64 bytes), which is what JWS ES256 wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64uEncode(sig)}, k=${vapid.publicKey}`;
}

/** Everything fetch() needs: `fetch(url, init)` delivers the notification. */
export async function buildPushRequest(
  sub: PushSubscriptionJson,
  payloadJson: unknown,
  vapid: VapidKeys,
  opts: { ttl?: number; urgency?: "low" | "normal" | "high"; topic?: string } = {},
): Promise<{ url: string; init: RequestInit }> {
  const payload = enc.encode(JSON.stringify(payloadJson));
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error(`push payload too large (${payload.length} > ${MAX_PAYLOAD_BYTES} bytes)`);
  if (opts.topic !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(opts.topic)) throw new Error("invalid push topic");
  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(sub.endpoint, vapid),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(opts.ttl ?? 86400),
    Urgency: opts.urgency ?? "normal",
  };
  if (opts.topic) headers.Topic = opts.topic;
  const body = await encryptPayload(sub, payload);
  return { url: sub.endpoint, init: { method: "POST", headers, body: body as BufferSource } };
}

/** SSRF guard for stored subscriptions: public https hosts only (no credentials, IP literals, localhost, bare names, odd ports). */
export function isPushEndpoint(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  if (host.startsWith("[")) return false; // IPv6 literal
  if (/^[\d.]+$/.test(host)) return false; // IPv4 literal (incl. odd forms the URL parser normalises)
  if (!host.includes(".")) return false; // "localhost", intranet names
  if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  return true;
}
