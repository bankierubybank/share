import path from "node:path";
import { webcrypto } from "node:crypto";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

/** Throwaway VAPID key pair for push tests (v0.11): made fresh on every run, never stored. */
async function testVapidKeys() {
  const b64u = (b: ArrayBuffer) => Buffer.from(b).toString("base64url");
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  return { VAPID_PUBLIC_KEY: b64u(await webcrypto.subtle.exportKey("raw", pair.publicKey)), VAPID_PRIVATE_KEY: jwk.d! };
}

// Runs inside workerd with a local D1. Requires `npm run build` first (assets dir).
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      // No remote bindings (Workers AI): receipt scans are canned (SCAN_FAKE), push uses the keys above.
      remoteBindings: false,
      miniflare: {
        // DEV_IDENTITY: identity from the Access email header (default dev@example.com), see src/lib/identity.ts.
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(__dirname, "migrations")), DEV_IDENTITY: "1", SCAN_FAKE: "1",
          ...(await testVapidKeys()),
        },
      },
    })),
  ],
  test: {
    include: ["test/integration/**/*.test.ts"],
    setupFiles: ["./test/integration/apply-migrations.ts"],
  },
});
