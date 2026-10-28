import { describe, expect, it } from "vitest";
import { api, BASE_URL } from "../helpers/http";

// Runs LAST in both gates. Service tokens and dev mode skip the link limit unless a test opts in with
// X-Test-Rate-Key (src/lib/ratelimit.ts), so we send it. Prod: the counter is still the service token's identity
// (the header only opts in). Local: the header value is the counter. Prod limits are approximate (per location).

const remote = !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE_URL);
const key: Record<string, string> = { "X-Test-Rate-Key": `gate-${crypto.randomUUID()}` };

describe("rate limits", () => {
  it("guessing invite tokens gets 429 (Retry-After: 60) after ~30 tries a minute", async () => {
    const seen: number[] = [];
    let limited: Awaited<ReturnType<typeof api>> | null = null;
    for (let i = 0; i < 100 && !limited; i++) {
      const r = await api("GET", `/api/join/${"A".repeat(21)}${"ABCDEFGHIJKLMNOPQRSTUVWXYZ"[i % 26]}`, undefined, key);
      seen.push(r.status);
      if (r.status === 429) limited = r;
    }
    expect(limited, `statuses: ${seen.join(",")}`).not.toBeNull();
    expect(seen.indexOf(429)).toBeGreaterThanOrEqual(remote ? 5 : 30); // the first ~30 are real answers (prod: approximate)
    expect(seen.slice(0, seen.indexOf(429)).every((s) => s === 404)).toBe(true);
    expect(limited!.headers.get("Retry-After")).toBe("60");
    expect(limited!.json.error.code).toBe("rate_limited");
    // The rest of the API is on its own, larger budget.
    expect((await api("GET", "/api/health", undefined, key)).status).toBe(200);
  });
});
