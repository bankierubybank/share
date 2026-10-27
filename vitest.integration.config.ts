import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

// Runs inside workerd with a local D1. Requires `npm run build` first (assets dir).
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // DEV_IDENTITY: identity from the Access email header (default dev@example.com), see src/lib/identity.ts.
        bindings: { TEST_MIGRATIONS: await readD1Migrations(path.join(__dirname, "migrations")), DEV_IDENTITY: "1" },
      },
    })),
  ],
  test: {
    include: ["test/integration/**/*.test.ts"],
    setupFiles: ["./test/integration/apply-migrations.ts"],
  },
});
