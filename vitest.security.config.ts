import { defineConfig } from "vitest/config";

// Black-box HTTP tests. TARGET_URL (default http://localhost:8787) + optional Access service token, see test/helpers/http.ts.
export default defineConfig({
  test: { include: ["test/security/**/*.test.ts"], environment: "node", testTimeout: 30_000, fileParallelism: false },
});
