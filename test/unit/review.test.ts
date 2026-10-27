import { describe, expect, it } from "vitest";
import { readLimited } from "../../src/lib/body";
import { parseRecurrence, RECURRENCE_BACKFILL_DAYS } from "../../src/lib/validate";

// Regressions from the 2026-10-27 code review (docs/ISSUES.md #24–#27).

const chunked = (chunks: number[], size: number) =>
  new Request("https://x/", {
    method: "POST",
    body: new ReadableStream({
      start(c) {
        for (const n of chunks) c.enqueue(new Uint8Array(n).fill(size));
        c.close();
      },
    }),
    // @ts-expect-error Node's fetch needs duplex for streaming bodies
    duplex: "half",
  });

describe("readLimited", () => {
  it("returns the whole body when under the cap", async () => {
    const b = await readLimited(chunked([10, 20, 30], 1), 100);
    expect(b?.byteLength).toBe(60);
  });
  it("returns null as soon as the cap is exceeded (no full buffering)", async () => {
    let pulled = 0;
    const req = new Request("https://x/", {
      method: "POST",
      body: new ReadableStream({
        pull(c) {
          pulled++;
          if (pulled > 1000) return c.close();
          c.enqueue(new Uint8Array(1024));
        },
      }),
      // @ts-expect-error see above
      duplex: "half",
    });
    expect(await readLimited(req, 4096)).toBeNull();
    expect(pulled).toBeLessThan(20); // stopped early, didn't read ~1 MB
  });
  it("exactly the cap is allowed; empty body ok", async () => {
    expect((await readLimited(chunked([50, 50], 2), 100))?.byteLength).toBe(100);
    expect((await readLimited(new Request("https://x/"), 10))?.byteLength).toBe(0);
  });
});

describe("parseRecurrence start-date window", () => {
  const members = new Set(["a"]);
  const bill = { description: "Rent", amount: 100, paidBy: "a", split: { mode: "equal", members: ["a"] } };
  const at = (startDate: string) => () => parseRecurrence({ frequency: "weekly", startDate, bill }, members, "THB", "2026-10-27");
  it(`accepts up to ${RECURRENCE_BACKFILL_DAYS} days back and a year ahead`, () => {
    expect(at("2026-07-27")).not.toThrow(); // 92 days
    expect(at("2027-10-27")).not.toThrow(); // 365 days
  });
  it("rejects far past (runaway backfill) and far future", () => {
    expect(at("2026-07-26")).toThrow(/within the last/);
    expect(at("1990-01-01")).toThrow(/within the last/);
    expect(at("2027-10-30")).toThrow(/within the last/);
  });
});
