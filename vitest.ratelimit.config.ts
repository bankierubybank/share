import { defineConfig } from "vitest/config";

// Rate-limit check (black-box HTTP). Run LAST in test-local.sh / test-prod.sh: it spends the caller's link budget.
const remote = !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.TARGET_URL ?? "http://localhost:8787");

export default defineConfig({
  test: { include: ["test/ratelimit/**/*.test.ts"], environment: "node", testTimeout: remote ? 180_000 : 30_000 },
});
