import { describe, expect, it } from "vitest";
import { BASE_URL, accessHeaders, api, makeGroup, today } from "../helpers/http";

const equal = (members: string[]) => ({ mode: "equal", members });
const GID_RE = /^[A-Za-z0-9_-]{22}$/;

/** Bodies must never leak internals. */
function expectNoLeak(text: string) {
  expect(text).not.toMatch(/D1_ERROR|SQLITE|\bat \S+ \(|\bat async\b|\.ts:\d+|node_modules|stack/i);
}

describe("security headers", () => {
  it.each(["/", "/api/health"])("%s carries hardening headers", async (path) => {
    const r = await api("GET", path);
    expect(r.status).toBe(200);
    const h = r.headers;
    const csp = h.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("referrer-policy")).toBe("no-referrer");
    expect(h.get("strict-transport-security")).toMatch(/max-age=\d{7,}/);
    expect(h.get("permissions-policy")).toBeTruthy();
  });

  it("headers also appear on error responses", async () => {
    const r = await api("GET", "/api/nope");
    expect(r.status).toBe(404);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("api responses are no-store", async () => {
    const { gid } = await makeGroup();
    for (const path of ["/api/health", `/api/groups/${gid}`, `/api/groups/${gid}/summary`, "/api/nope"]) {
      const r = await api("GET", path);
      expect(r.headers.get("cache-control"), path).toBe("no-store");
    }
    const post = await api("POST", "/api/groups", { name: "x", currency: "USD", members: ["a"] });
    expect(post.headers.get("cache-control")).toBe("no-store");
  });

  it("api responses are JSON", async () => {
    const r = await api("GET", "/api/health");
    expect(r.headers.get("content-type")).toMatch(/^application\/json/);
  });
});

describe("request hardening", () => {
  const good = { name: "x", currency: "USD", members: ["a"] };

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"])(
    "415 for POST with content-type %j",
    async (ct) => {
      const r = await api("POST", "/api/groups", JSON.stringify(good), { "Content-Type": ct });
      expect(r.status).toBe(415);
      expect(r.json.error.code).toBe("unsupported_media_type");
    },
  );

  it("415 for a form-style POST with no explicit content type", async () => {
    // fetch labels string bodies text/plain;charset=UTF-8 (a CORS-safelisted type used in CSRF attempts).
    const res = await fetch(`${BASE_URL}/api/groups`, {
      method: "POST",
      redirect: "manual",
      headers: accessHeaders(),
      body: JSON.stringify(good),
    });
    expect(res.status).toBe(415);
  });

  it("415 applies to PUT and PATCH too, and nothing changes", async () => {
    const { gid } = await makeGroup();
    const body = JSON.stringify({ name: "hax" });
    const patch = await api("PATCH", `/api/groups/${gid}`, body, { "Content-Type": "text/plain" });
    expect(patch.status).toBe(415);
    const put = await api("PUT", `/api/groups/${gid}/bills/${"A".repeat(16)}`, body, { "Content-Type": "text/plain" });
    expect(put.status).toBe(415);
    const g = await api("GET", `/api/groups/${gid}`);
    expect(g.json.group.name).not.toBe("hax");
  });

  it("accepts application/json with charset", async () => {
    const r = await api("POST", "/api/groups", good, { "Content-Type": "application/json; charset=utf-8" });
    expect(r.status).toBe(201);
  });

  it("413 for body over 32 KiB", async () => {
    const big = { name: "x", currency: "USD", members: ["a"], pad: "x".repeat(33 * 1024) };
    const r = await api("POST", "/api/groups", big);
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe("payload_too_large");
  });

  it("a body just under the limit is not rejected as too large", async () => {
    const r = await api("POST", "/api/groups", { ...good, pad: "x".repeat(30 * 1024) });
    expect(r.status).not.toBe(413);
    expect(r.status).toBeLessThan(500);
  });

  it.each(["{", '{"name":', "not json", "null", "[]", '"str"', "12", '{"name":"x",}'])(
    "malformed or non-object JSON %j gives 400, not 500",
    async (raw) => {
      const r = await api("POST", "/api/groups", raw);
      expect(r.status).toBe(400);
      expect(r.json.error.code).toMatch(/^(bad_request|validation)$/);
      expectNoLeak(r.text);
    },
  );

  it("empty body with JSON content type is 400", async () => {
    const r = await api("POST", "/api/groups", "");
    expect(r.status).toBe(400);
  });

  it("malformed JSON on bill, member and patch endpoints is 400", async () => {
    const { gid } = await makeGroup();
    for (const path of [`/api/groups/${gid}/members`, `/api/groups/${gid}/bills`]) {
      const r = await api("POST", path, "{oops");
      expect(r.status, path).toBe(400);
    }
    expect((await api("PATCH", `/api/groups/${gid}`, "{oops")).status).toBe(400);
  });
});

describe("routing", () => {
  it("unknown api path is a JSON 404", async () => {
    for (const path of ["/api/nope", "/api/groups/x/y/z/w", "/api/", "/api/health/extra"]) {
      const r = await api("GET", path);
      expect(r.status, path).toBe(404);
      expect(r.json?.error?.code, path).toBe("not_found");
    }
  });

  it("unsupported method on a non-api path is 405", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const r = await api(method, "/", method === "DELETE" ? undefined : {});
      expect(r.status, method).toBe(405);
    }
  });

  it("unsupported method on a known api path is 404 or 405", async () => {
    const r = await api("DELETE", "/api/health");
    expect([404, 405]).toContain(r.status);
  });

  it("no source or config disclosure through the SPA fallback", async () => {
    const r = await api("GET", "/..%2f..%2fpackage.json");
    expect(r.text).not.toContain("devDependencies");
    const r2 = await api("GET", "/src/index.ts");
    expect(r2.text).not.toContain("verifyAccessJwt");
    const r3 = await api("GET", "/wrangler.jsonc");
    expect(r3.text).not.toContain("account_id");
  });
});

describe("injection", () => {
  const sqli = [
    "'; DR" + "OP TABLE groups; --",
    "' OR '1'='1",
    '" OR 1=1 --',
    "Robert'); DR" + "OP TABLE members;--",
    "1; DELETE FROM bills",
    "' UNION SELECT id,name,currency,created_at FROM groups --",
    "%' ; --",
  ];

  it("SQL injection in group, member and bill text is stored verbatim and tables survive", async () => {
    for (const payload of sqli) {
      const created = await api("POST", "/api/groups", { name: payload, currency: "USD", members: [payload, "Other"] });
      expect(created.status, payload).toBe(201);
      expect(created.json.group.name).toBe(payload);
      const gid = created.json.group.id;
      const evil = created.json.members.find((m: any) => m.name === payload);
      const other = created.json.members.find((m: any) => m.name === "Other");
      expect(evil).toBeTruthy();

      const b = await api("POST", `/api/groups/${gid}/bills`, {
        description: payload.slice(0, 120),
        amount: 500,
        paidBy: evil.id,
        date: today(),
        split: equal([evil.id, other.id]),
      });
      expect(b.status, payload).toBe(201);
      expect(b.json.bill.description).toBe(payload.slice(0, 120));

      const add = await api("POST", `/api/groups/${gid}/members`, { name: payload + "2" });
      expect(add.status).toBe(201);

      const g = await api("GET", `/api/groups/${gid}`);
      expect(g.status).toBe(200);
      expect(g.json.group.name).toBe(payload);
      expect(g.json.members).toHaveLength(3);
      expect(g.json.bills[0].description).toBe(payload.slice(0, 120));
    }
    // Tables still intact: a fresh group round-trips and summary works.
    const { gid } = await makeGroup();
    expect((await api("GET", `/api/groups/${gid}/summary`)).status).toBe(200);
  });

  it("SQL injection in ids never yields 500 or data", async () => {
    const { gid } = await makeGroup();
    const ids = ["' OR 1=1 --", "1; DELETE FROM groups", "%27%20OR%201%3D1", "A".repeat(21) + "'", '" OR ""="'];
    for (const id of ids) {
      const enc = encodeURIComponent(id);
      for (const path of [
        `/api/groups/${enc}`,
        `/api/groups/${enc}/summary`,
        `/api/groups/${gid}/members/${enc}`,
        `/api/groups/${gid}/bills/${enc}`,
      ]) {
        const r = await api(path.includes("/members/") || path.includes("/bills/") ? "DELETE" : "GET", path);
        expect(r.status, path).toBe(404);
        expectNoLeak(r.text);
      }
    }
    expect((await api("GET", `/api/groups/${gid}`)).status).toBe(200);
  });

  it("SQL injection in paidBy / split ids is rejected with 400", async () => {
    const { gid, ids } = await makeGroup();
    const base = { description: "x", amount: 100, date: today() };
    const r1 = await api("POST", `/api/groups/${gid}/bills`, { ...base, paidBy: "' OR 1=1 --", split: equal([ids.Alice]) });
    expect(r1.status).toBe(400);
    const r2 = await api("POST", `/api/groups/${gid}/bills`, { ...base, paidBy: ids.Alice, split: equal(["x' OR '1'='1"]) });
    expect(r2.status).toBe(400);
  });

  it("XSS payload is stored and returned verbatim as JSON", async () => {
    const xss = "<img src=x onerror=alert(1)>";
    const script = "<script>alert('x')</script>";
    const created = await api("POST", "/api/groups", { name: xss, currency: "USD", members: [xss, script] });
    expect(created.status).toBe(201);
    expect(created.headers.get("content-type")).toMatch(/^application\/json/);
    expect(created.headers.get("x-content-type-options")).toBe("nosniff");
    expect(created.json.group.name).toBe(xss);
    const gid = created.json.group.id;
    const g = await api("GET", `/api/groups/${gid}`);
    expect(g.headers.get("content-type")).toMatch(/^application\/json/);
    expect(g.json.group.name).toBe(xss);
    expect(g.json.members.map((m: any) => m.name).sort()).toEqual([script, xss].sort());
    // No HTML entity rewriting server-side.
    expect(g.text).toContain("<img src=x onerror=alert(1)>");
    const b = await api("POST", `/api/groups/${gid}/bills`, {
      description: xss,
      amount: 100,
      paidBy: g.json.members[0].id,
      date: today(),
      split: equal([g.json.members[0].id]),
    });
    expect(b.status).toBe(201);
    expect(b.json.bill.description).toBe(xss);
  });

  it("control characters in names are stripped, not 500", async () => {
    const r = await api("POST", "/api/groups", { name: "a\u0000b\u0007c\nd", currency: "USD", members: ["x\u0000"] });
    expect(r.status).toBe(201);
    expect(r.json.group.name).not.toMatch(/[\u0000-\u001f]/);
  });

  it("unicode and emoji names round-trip", async () => {
    const name = "ทริป 🌴 日本語";
    const r = await api("POST", "/api/groups", { name, currency: "THB", members: [name] });
    expect(r.status).toBe(201);
    expect(r.json.group.name).toBe(name);
  });
});

describe("identifiers", () => {
  it("group ids are 22-char base64url and unique", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { gid } = await makeGroup(["A"]);
      expect(gid).toMatch(GID_RE);
      ids.add(gid);
    }
    expect(ids.size).toBe(5);
  });

  it("member and bill ids are 16-char base64url", async () => {
    const { gid, ids } = await makeGroup(["A", "B"]);
    for (const id of Object.values(ids)) expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const b = await api("POST", `/api/groups/${gid}/bills`, {
      description: "x",
      amount: 100,
      paidBy: ids.A,
      date: today(),
      split: equal([ids.A]),
    });
    expect(b.json.bill.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it("guessing random group ids gives 404", async () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    for (let i = 0; i < 15; i++) {
      let id = "";
      for (let j = 0; j < 22; j++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
      const r = await api("GET", `/api/groups/${id}`);
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe("not_found");
    }
  });

  it("there is no endpoint to enumerate groups", async () => {
    await makeGroup();
    for (const path of ["/api/groups", "/api/groups/"]) {
      const r = await api("GET", path);
      expect([404, 405]).toContain(r.status);
      expect(r.text).not.toMatch(/"groups"\s*:\s*\[/);
    }
  });
});

describe("cross-group access (IDOR)", () => {
  it("bill of group A is not readable, editable or deletable via group B", async () => {
    const a = await makeGroup();
    const b = await makeGroup();
    const bill = await api("POST", `/api/groups/${a.gid}/bills`, {
      description: "secret",
      amount: 100,
      paidBy: a.ids.Alice,
      date: today(),
      split: equal([a.ids.Alice]),
    });
    const bid = bill.json.bill.id;
    const viaB = await api("GET", `/api/groups/${b.gid}`);
    expect(viaB.text).not.toContain(bid);
    const put = await api("PUT", `/api/groups/${b.gid}/bills/${bid}`, {
      description: "pwn",
      amount: 1,
      paidBy: b.ids.Alice,
      date: today(),
      split: equal([b.ids.Alice]),
    });
    expect(put.status).toBe(404);
    expect((await api("DELETE", `/api/groups/${b.gid}/bills/${bid}`)).status).toBe(404);
    const still = await api("GET", `/api/groups/${a.gid}`);
    expect(still.json.bills[0]).toMatchObject({ id: bid, description: "secret", amount: 100 });
  });

  it("members of group B cannot be used as payer or in splits of group A", async () => {
    const a = await makeGroup();
    const b = await makeGroup();
    const mk = (extra: Record<string, unknown>) =>
      api("POST", `/api/groups/${a.gid}/bills`, { description: "x", amount: 100, date: today(), ...extra });
    expect((await mk({ paidBy: b.ids.Alice, split: equal([a.ids.Alice]) })).status).toBe(400);
    expect((await mk({ paidBy: a.ids.Alice, split: equal([b.ids.Alice]) })).status).toBe(400);
    expect(
      (await mk({ paidBy: a.ids.Alice, split: { mode: "exact", shares: [{ memberId: b.ids.Bob, amount: 100 }] } })).status,
    ).toBe(400);
    expect((await api("GET", `/api/groups/${a.gid}`)).json.bills).toEqual([]);
  });

  it("members of group B cannot be renamed or deleted via group A", async () => {
    const a = await makeGroup();
    const b = await makeGroup();
    expect((await api("PATCH", `/api/groups/${a.gid}/members/${b.ids.Alice}`, { name: "Hax" })).status).toBe(404);
    expect((await api("DELETE", `/api/groups/${a.gid}/members/${b.ids.Alice}`)).status).toBe(404);
    const g = await api("GET", `/api/groups/${b.gid}`);
    expect(g.json.members.map((m: any) => m.name)).toContain("Alice");
  });

  it("a bill in A cannot be repointed to a member of B via PUT", async () => {
    const a = await makeGroup();
    const b = await makeGroup();
    const bill = await api("POST", `/api/groups/${a.gid}/bills`, {
      description: "x",
      amount: 100,
      paidBy: a.ids.Alice,
      date: today(),
      split: equal([a.ids.Alice]),
    });
    const put = await api("PUT", `/api/groups/${a.gid}/bills/${bill.json.bill.id}`, {
      description: "x",
      amount: 100,
      paidBy: b.ids.Alice,
      date: today(),
      split: equal([a.ids.Alice]),
    });
    expect(put.status).toBe(400);
  });
});

describe("amount validation", () => {
  it("rejects oversized, negative, float, string and other bad amounts with 400", async () => {
    const { gid, ids } = await makeGroup();
    const amounts: unknown[] = [
      100_000_000_001,
      Number.MAX_SAFE_INTEGER,
      -1,
      -100,
      0,
      1.5,
      0.1,
      "100",
      "1e3",
      "",
      null,
      true,
      [100],
      { v: 1 },
    ];
    for (const amount of amounts) {
      const r = await api("POST", `/api/groups/${gid}/bills`, {
        description: "x",
        amount,
        paidBy: ids.Alice,
        date: today(),
        split: equal([ids.Alice]),
      });
      expect(r.status, JSON.stringify(amount)).toBe(400);
      expectNoLeak(r.text);
    }
    // 2^53 + 1 written as a raw JSON literal (not safe-integer representable)
    const raw = `{"description":"x","amount":9007199254740993,"paidBy":"${ids.Alice}","date":"${today()}","split":{"mode":"equal","members":["${ids.Alice}"]}}`;
    expect((await api("POST", `/api/groups/${gid}/bills`, raw)).status).toBe(400);
    const missing = await api("POST", `/api/groups/${gid}/bills`, {
      description: "x",
      paidBy: ids.Alice,
      date: today(),
      split: equal([ids.Alice]),
    });
    expect(missing.status).toBe(400);
  });

  it("rejects bad exact-share amounts", async () => {
    const { gid, ids } = await makeGroup();
    for (const bad of [-1, 0.5, "5", 100_000_000_001]) {
      const r = await api("POST", `/api/groups/${gid}/bills`, {
        description: "x",
        amount: 100,
        paidBy: ids.Alice,
        date: today(),
        split: { mode: "exact", shares: [{ memberId: ids.Alice, amount: bad }, { memberId: ids.Bob, amount: 100 }] },
      });
      expect(r.status, String(bad)).toBe(400);
    }
  });

  it("accepts the maximum amount exactly", async () => {
    const { gid, ids } = await makeGroup();
    const r = await api("POST", `/api/groups/${gid}/bills`, {
      description: "max",
      amount: 100_000_000_000,
      paidBy: ids.Alice,
      date: today(),
      split: equal([ids.Alice, ids.Bob, ids.Carol]),
    });
    expect(r.status).toBe(201);
    const sum = r.json.bill.shares.reduce((a: number, s: any) => a + s.amount, 0);
    expect(sum).toBe(100_000_000_000);
  });

  it("summing several max-size bills stays exact in the summary", async () => {
    const { gid, ids } = await makeGroup(["A", "B"]);
    for (let i = 0; i < 3; i++) {
      const r = await api("POST", `/api/groups/${gid}/bills`, {
        description: "max",
        amount: 100_000_000_000,
        paidBy: ids.A,
        date: today(),
        split: equal([ids.B]),
      });
      expect(r.status).toBe(201);
    }
    const s = await api("GET", `/api/groups/${gid}/summary`);
    expect(s.json.total).toBe(300_000_000_000);
    expect(s.json.settlements).toEqual([{ from: ids.B, to: ids.A, amount: 300_000_000_000 }]);
  });

  it("rejects structurally bad bill fields", async () => {
    const { gid, ids } = await makeGroup();
    const ok = { description: "x", amount: 100, paidBy: ids.Alice, date: today(), split: equal([ids.Alice]) };
    const variants: Record<string, unknown>[] = [
      { description: "" },
      { description: "x".repeat(121) },
      { description: 5 },
      { date: "2026-13-01" },
      { date: "tomorrow" },
      { kind: "refund" },
      { split: null },
      { split: { mode: "weird" } },
      { split: { mode: "equal", members: [] } },
      { split: { mode: "equal", members: [ids.Alice, ids.Alice] } },
      { split: { mode: "equal", members: "all" } },
      { paidBy: 5 },
    ];
    for (const v of variants) {
      const r = await api("POST", `/api/groups/${gid}/bills`, { ...ok, ...v });
      expect(r.status, JSON.stringify(v)).toBe(400);
      expectNoLeak(r.text);
    }
  });

  it("rejects bad group bodies and limits", async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `m${i}`);
    for (const body of [
      { name: "x".repeat(61), currency: "USD", members: ["a"] },
      { name: "x", currency: "US", members: ["a"] },
      { name: "x", currency: "USDD", members: ["a"] },
      { name: "x", currency: 5, members: ["a"] },
      { name: "x", currency: "USD", members: tooMany },
      { name: "x", currency: "USD", members: "a" },
      { name: "x", currency: "USD", members: [1] },
      { name: "   ", currency: "USD", members: ["a"] },
    ]) {
      const r = await api("POST", "/api/groups", body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
  });
});

describe("error bodies", () => {
  it("never leak stack traces or database internals", async () => {
    const { gid, ids } = await makeGroup();
    const requests: [string, string, unknown?][] = [
      ["GET", "/api/groups/bad"],
      ["GET", `/api/groups/${"A".repeat(22)}`],
      ["POST", "/api/groups", "{"],
      ["POST", "/api/groups", { name: "x" }],
      ["POST", `/api/groups/${gid}/members`, { name: "Alice" }],
      ["POST", `/api/groups/${gid}/bills`, { amount: "x" }],
      ["DELETE", `/api/groups/${gid}/members/${"A".repeat(16)}`],
      ["PUT", `/api/groups/${gid}/bills/${"A".repeat(16)}`, {}],
      ["GET", "/api/nope"],
      ["POST", "/", {}],
      ["PATCH", `/api/groups/${gid}/members/${ids.Alice}`, { name: "bob" }],
    ];
    for (const [m, p, b] of requests) {
      const r = await api(m, p, b);
      expect(r.status, `${m} ${p}`).toBeLessThan(500);
      expectNoLeak(r.text);
      if (r.status >= 400 && p.startsWith("/api")) {
        expect(r.json.error).toEqual({ code: expect.any(String), message: expect.any(String) });
      }
    }
  });
});

describe("cloudflare access", () => {
  const expected = process.env.CF_ACCESS_EXPECTED === "1";

  it.skipIf(!expected)("rejects requests without access headers", async () => {
    const res = await fetch(BASE_URL + "/", { redirect: "manual" });
    expect([302, 401, 403]).toContain(res.status);
    const apiRes = await fetch(BASE_URL + "/api/health", { redirect: "manual" });
    expect([302, 401, 403]).toContain(apiRes.status);
  });
});
