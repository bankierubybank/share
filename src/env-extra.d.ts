// Bindings `wrangler types` can't see: a secret set with `wrangler secret put`, and test/dev-only vars passed with
// `--var` or the integration config. All optional — the code works (with that feature off) without them.
interface Env {
  /** Web Push private key (v0.11), base64url 32-byte scalar. Secret: never in wrangler.jsonc. */
  VAPID_PRIVATE_KEY?: string;
  /** "1" = canned receipt scans (local dev / tests). Never set on prod. */
  SCAN_FAKE?: string;
}
