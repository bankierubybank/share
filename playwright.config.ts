import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

config({ path: ".env.test", quiet: true });

const BASE_URL = process.env.TARGET_URL ?? "http://localhost:8787";
const id = process.env.CF_ACCESS_CLIENT_ID;
const secret = process.env.CF_ACCESS_CLIENT_SECRET;
// Cloudflare Access service token headers (prod). Harmless locally.
const extraHTTPHeaders = id && secret ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : undefined;

export default defineConfig({
  testDir: "test/e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: { baseURL: BASE_URL, extraHTTPHeaders, trace: "retain-on-failure" },
  // Compatibility matrix: desktop engines + phone emulation. `npm run test:e2e` runs chromium only.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
    { name: "mobile-safari", use: { ...devices["iPhone 14"] } },
  ],
});
