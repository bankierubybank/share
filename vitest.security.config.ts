import { defineConfig } from "vitest/config";

// Black-box HTTP tests. TARGET_URL (default http://localhost:8787) + optional Access service token, see test/helpers/http.ts.
// Prod D1 writes can take seconds (docs/ISSUES.md #28): remote runs get more headroom.
const remote = !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.TARGET_URL ?? "http://localhost:8787");

export default defineConfig({
  test: { include: ["test/security/**/*.test.ts"], environment: "node", testTimeout: remote ? 120_000 : 30_000, hookTimeout: remote ? 300_000 : 10_000, fileParallelism: false },
});
