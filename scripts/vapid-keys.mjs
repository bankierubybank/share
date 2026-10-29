// Generates a VAPID (P-256) key pair for Web Push. Prints two lines; writes nothing to disk.
// Put the private key in with `npx wrangler secret put VAPID_PRIVATE_KEY` (never commit it);
// the public key goes in wrangler.jsonc vars as VAPID_PUBLIC_KEY.
const b64u = (bytes) => Buffer.from(bytes).toString("base64url");

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);

console.log(`VAPID_PUBLIC_KEY=${b64u(pub)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`); // JWK d is already base64url of the 32-byte scalar
