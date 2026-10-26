import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

config({ path: ".env.test", quiet: true });

const BASE_URL = process.env.TARGET_URL ?? "http://localhost:8787";
// Access service token is attached per-origin in test/e2e/fixtures.ts — NOT via extraHTTPHeaders,
// which would leak it to third-party hosts (Google Fonts).

export default defineConfig({
  testDir: "test/e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  // Compatibility matrix: desktop engines + phone emulation. `npm run test:e2e` runs chromium only.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
    { name: "mobile-safari", use: { ...devices["iPhone 14"] } },
  ],
});
