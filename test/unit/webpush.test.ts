import { describe, expect, it } from "vitest";
import {
  b64uDecode,
  b64uEncode,
  buildPushRequest,
  encryptPayload,
  isPushEndpoint,
  vapidAuthorization,
  type PushSubscriptionJson,
  type VapidKeys,
} from "../../src/lib/webpush";

const enc = new TextEncoder();
const dec = new TextDecoder();
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource }, key, len * 8),
  );
}

/** Receiver side (what the browser does): parse the aes128gcm body and decrypt with the subscription's private key. */
async function decryptBody(body: Uint8Array, uaPrivate: CryptoKey, uaPublic: Uint8Array, auth: Uint8Array) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16, false);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  expect(rs).toBe(4096);
  expect(idlen).toBe(65);

  const asKey = await crypto.subtle.importKey("raw", asPublic as BufferSource, ECDH, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, uaPrivate, 256));
  const ikm = await hkdf(auth, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["decrypt"]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce as BufferSource }, aes, ct as BufferSource));
  // strip padding: trailing zeros then the 0x02 delimiter
  let end = pt.length - 1;
  while (end >= 0 && pt[end] === 0) end--;
  expect(pt[end]).toBe(2);
  return pt.slice(0, end);
}

async function newBrowserSubscription(endpoint = "https://fcm.googleapis.com/fcm/send/abc") {
  const pair = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub: PushSubscriptionJson = { endpoint, keys: { p256dh: b64uEncode(uaPublic), auth: b64uEncode(auth) } };
  return { sub, uaPrivate: pair.privateKey, uaPublic, auth };
}

async function newVapid(): Promise<{ vapid: VapidKeys; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { vapid: { publicKey: b64uEncode(raw), privateKey: jwk.d!, subject: "mailto:test@example.com" }, publicKey: pair.publicKey };
}

describe("encryptPayload (RFC 8291)", () => {
  it("matches the Appendix A test vector", async () => {
    const sub: PushSubscriptionJson = {
      endpoint: "https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV",
      keys: {
        p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        auth: "BTBZMqHH6r4Tts7J_aSIgg",
      },
    };
    const body = await encryptPayload(sub, enc.encode("When I grow up, I want to be a watermelon"), {
      salt: b64uDecode("DGv6ra1nlYgDCS1FRnbzlw"),
      serverKeys: {
        privateKey: b64uDecode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
        publicKey: b64uDecode("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"),
      },
    });
    expect(b64uEncode(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("round-trips: a receiver can decrypt what we encrypt", async () => {
    const { sub, uaPrivate, uaPublic, auth } = await newBrowserSubscription();
    const msg = enc.encode(JSON.stringify({ title: "Dinner", body: "Somchai added a bill ฿420" }));
    const body = await encryptPayload(sub, msg);
    expect(dec.decode(await decryptBody(body, uaPrivate, uaPublic, auth))).toBe(dec.decode(msg));
  });

  it("uses a fresh salt and server key each time", async () => {
    const { sub } = await newBrowserSubscription();
    const a = await encryptPayload(sub, enc.encode("x"));
    const b = await encryptPayload(sub, enc.encode("x"));
    expect(b64uEncode(a)).not.toBe(b64uEncode(b));
  });

  it("rejects a malformed p256dh", async () => {
    const { sub } = await newBrowserSubscription();
    await expect(encryptPayload({ ...sub, keys: { ...sub.keys, p256dh: "AAAA" } }, enc.encode("x"))).rejects.toThrow();
  });
});

describe("vapidAuthorization (RFC 8292)", () => {
  it("builds a verifiable ES256 JWT for the endpoint origin", async () => {
    const { vapid, publicKey } = await newVapid();
    const now = 1_700_000_000;
    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc?x=1", vapid, now);

    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, s, k] = m!;
    expect(k).toBe(vapid.publicKey);
    expect(JSON.parse(dec.decode(b64uDecode(h)))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(dec.decode(b64uDecode(c)));
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("mailto:test@example.com");
    expect(claims.exp).toBeGreaterThan(now);
    expect(claims.exp - now).toBeLessThanOrEqual(24 * 3600);

    const sig = b64uDecode(s);
    expect(sig.length).toBe(64);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, sig as BufferSource, enc.encode(`${h}.${c}`));
    expect(ok).toBe(true);
    // tampered claims must not verify
    const bad = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, sig as BufferSource, enc.encode(`${h}.${c}x`));
    expect(bad).toBe(false);
  });
});

describe("buildPushRequest", () => {
  it("sets the push headers and an encrypted body", async () => {
    const { sub, uaPrivate, uaPublic, auth } = await newBrowserSubscription();
    const { vapid } = await newVapid();
    const { url, init } = await buildPushRequest(sub, { title: "Hi", n: 1 }, vapid);
    expect(url).toBe(sub.endpoint);
    expect(init.method).toBe("POST");
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(h["Content-Encoding"]).toBe("aes128gcm");
    expect(h["Content-Type"]).toBe("application/octet-stream");
    expect(h.TTL).toBe("86400");
    expect(h.Urgency).toBe("normal");
    expect(h.Topic).toBeUndefined();
    const plain = await decryptBody(init.body as Uint8Array, uaPrivate, uaPublic, auth);
    expect(JSON.parse(dec.decode(plain))).toEqual({ title: "Hi", n: 1 });
  });

  it("honours ttl, urgency and topic", async () => {
    const { sub } = await newBrowserSubscription();
    const { vapid } = await newVapid();
    const { init } = await buildPushRequest(sub, {}, vapid, { ttl: 60, urgency: "high", topic: "group-1" });
    const h = init.headers as Record<string, string>;
    expect(h.TTL).toBe("60");
    expect(h.Urgency).toBe("high");
    expect(h.Topic).toBe("group-1");
  });

  it("rejects an invalid topic", async () => {
    const { sub } = await newBrowserSubscription();
    const { vapid } = await newVapid();
    await expect(buildPushRequest(sub, {}, vapid, { topic: "x".repeat(33) })).rejects.toThrow();
  });

  it("rejects oversize payloads but accepts the maximum", async () => {
    const { sub } = await newBrowserSubscription();
    const { vapid } = await newVapid();
    // JSON string adds 2 quote bytes
    await expect(buildPushRequest(sub, "a".repeat(3992), vapid)).rejects.toThrow(/too large/);
    const { init } = await buildPushRequest(sub, "a".repeat(3991), vapid);
    expect((init.body as Uint8Array).length).toBeLessThanOrEqual(4096);
  });
});

describe("isPushEndpoint", () => {
  it("accepts real push services", () => {
    expect(isPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isPushEndpoint("https://web.push.apple.com/Qx")).toBe(true);
  });

  it.each([
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://10.0.0.1/x",
    "https://2130706433/x",
    "https://user:pw@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "https://intranet/x",
    "https://foo.localhost/x",
    "javascript:alert(1)",
    "not a url",
    "",
  ])("rejects %s", (u) => {
    expect(isPushEndpoint(u)).toBe(false);
  });
});
