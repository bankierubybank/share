import { exports } from "cloudflare:workers";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BACKUP_TABLES, runBackup } from "../../src/backup";

// v3 features: bill comments, saved subgroups, read-only view links, move bill between groups, merge groups.

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await exports.default.fetch(
    new Request(`http://example.com${path}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, headers: res.headers, json, text };
}

async function raw(method: string, path: string, body?: Uint8Array, contentType?: string) {
  const res = await exports.default.fetch(
    new Request(`http://example.com${path}`, { method, headers: contentType ? { "Content-Type": contentType } : {}, body: body as BodyInit | undefined }),
  );
  return { status: res.status, text: await res.text() };
}

const DATE = "2026-01-15";
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const RAND_GID = "Zz9_-Zz9_-Zz9_-Zz9_-Zz"; // valid 22-char format, never exists
const RAND_EID = "Zz9_-Zz9_-Zz9_-Z"; // valid 16-char format, never exists

type Ids = Record<string, string>;

async function makeGroup(names = ["Alice", "Bob", "Carol"], currency = "USD", name = "Trip") {
  const r = await call("POST", "/api/groups", { name, currency, members: names });
  expect(r.status, r.text).toBe(201);
  const ids: Ids = {};
  for (const m of r.json.members) ids[m.name] = m.id;
  return { gid: r.json.group.id as string, ids };
}

const equal = (members: string[]) => ({ mode: "equal", members });

async function addBill(gid: string, body: Record<string, unknown>) {
  return call("POST", `/api/groups/${gid}/bills`, { description: "Thing", date: DATE, ...body });
}

async function simpleBill(gid: string, ids: Ids, extra: Record<string, unknown> = {}) {
  const r = await addBill(gid, { amount: 900, paidBy: ids.Alice, split: equal([ids.Alice, ids.Bob, ids.Carol]), ...extra });
  expect(r.status, r.text).toBe(201);
  return r.json.bill.id as string;
}

const cPath = (gid: string, bid: string) => `/api/groups/${gid}/bills/${bid}/comments`;
const postComment = (gid: string, bid: string, body: unknown, memberId?: string) =>
  call("POST", cPath(gid, bid), memberId === undefined ? { body } : { body, memberId });

async function getBills(gid: string) {
  const r = await call("GET", `/api/groups/${gid}`);
  expect(r.status, r.text).toBe(200);
  return r.json.bills as any[];
}

async function activity(gid: string) {
  const r = await call("GET", `/api/groups/${gid}/activity?limit=100`);
  expect(r.status, r.text).toBe(200);
  return r.json.activity as { actor: string | null; action: string; entityId: string | null; detail: any }[];
}

const summaryOf = async (gid: string) => (await call("GET", `/api/groups/${gid}/summary`)).json;
const invert = (ids: Ids) => Object.fromEntries(Object.entries(ids).map(([n, i]) => [i, n]));

/** Net per lowercased member name. */
async function netsByName(gid: string, ids: Ids) {
  const s = await summaryOf(gid);
  const byId = invert(ids);
  const out: Record<string, number> = {};
  for (const b of s.balances) out[byId[b.memberId].toLowerCase()] = b.net;
  expect(s.balances.reduce((a: number, b: any) => a + b.net, 0), "balances must sum to 0").toBe(0);
  return out;
}

/** Replaces member ids with lowercased names everywhere so bills from different groups can be compared. */
function named(v: unknown, byId: Ids): any {
  if (typeof v === "string") return byId[v] ? byId[v].toLowerCase() : v;
  if (Array.isArray(v)) return v.map((x) => named(x, byId));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, named(x, byId)]));
  return v;
}
function comparable(bill: any, ids: Ids) {
  const b = named(bill, invert(ids));
  const key = (x: any) => x.memberId;
  b.payers = [...b.payers].sort((x: any, y: any) => key(x).localeCompare(key(y)));
  b.shares = [...b.shares].sort((x: any, y: any) => key(x).localeCompare(key(y)));
  delete b.recurrenceId;
  return b;
}

// ============================================================================

describe("comments", () => {
  it("empty list, then create -> 201 with the documented shape, listed oldest first", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    const empty = await call("GET", cPath(gid, bid));
    expect(empty.status).toBe(200);
    expect(empty.json).toEqual({ comments: [] });

    const a = await postComment(gid, bid, "first", ids.Alice);
    expect(a.status, a.text).toBe(201);
    expect(a.json.comment).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/),
      billId: bid,
      authorMemberId: ids.Alice,
      actor: "dev@example.com",
      body: "first",
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
    });
    const b = await postComment(gid, bid, "second");
    const c = await postComment(gid, bid, "third", ids.Bob);
    // v0.10: always the signed-in person (dev@example.com = Alice), whatever memberId says.
    expect(b.json.comment.authorMemberId).toBe(ids.Alice);
    expect(c.json.comment.authorMemberId).toBe(ids.Alice);
    // Force distinct, known timestamps (same-millisecond inserts would tie-break on random ids).
    const stamp = (id: string, t: string) => env.DB.prepare("UPDATE bill_comments SET created_at = ? WHERE id = ?").bind(t, id).run();
    await stamp(c.json.comment.id, "2030-01-01T00:00:01.000Z");
    await stamp(a.json.comment.id, "2030-01-01T00:00:02.000Z");
    await stamp(b.json.comment.id, "2030-01-01T00:00:03.000Z");
    const list = await call("GET", cPath(gid, bid));
    expect(list.json.comments.map((x: any) => x.body)).toEqual(["third", "first", "second"]);
  });

  it("records the Access actor (lowercased) on the comment and in activity; excerpt is capped at 80 chars", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids, { description: "Dinner" });
    await call("PATCH", `/api/groups/${gid}/members/${ids.Bob}`, { email: "zed@example.com" }); // Zed may open the trip
    const long = "z".repeat(300);
    const r = await call("POST", cPath(gid, bid), { body: long }, { "Cf-Access-Authenticated-User-Email": "Zed@Example.COM" });
    expect(r.status).toBe(201);
    expect(r.json.comment.actor).toBe("zed@example.com");
    const entry = (await activity(gid)).find((a) => a.action === "comment.add")!;
    expect(entry).toMatchObject({ actor: "zed@example.com", entityId: bid });
    expect(entry.detail.description).toBe("Dinner");
    expect(entry.detail.excerpt).toBe("z".repeat(80));
  });

  it("commentCount on bills tracks adds/deletes and survives bill edits", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    const other = await simpleBill(gid, ids);
    expect((await getBills(gid)).every((b) => b.commentCount === 0)).toBe(true);
    const c1 = await postComment(gid, bid, "one");
    await postComment(gid, bid, "two");
    const count = async (id: string) => (await getBills(gid)).find((b) => b.id === id).commentCount;
    expect(await count(bid)).toBe(2);
    expect(await count(other)).toBe(0);
    const put = await call("PUT", `/api/groups/${gid}/bills/${bid}`, {
      description: "Edited", date: DATE, amount: 600, paidBy: ids.Bob, split: equal([ids.Alice, ids.Bob]),
    });
    expect(put.status, put.text).toBe(200);
    expect(put.json.bill.commentCount).toBe(2);
    expect((await call("DELETE", `${cPath(gid, bid)}/${c1.json.comment.id}`)).status).toBe(204);
    expect(await count(bid)).toBe(1);
  });

  it("activity records comment.add per comment", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    await postComment(gid, bid, "a");
    await postComment(gid, bid, "b");
    expect((await activity(gid)).filter((a) => a.action === "comment.add")).toHaveLength(2);
  });

  it("body validation: trim, newlines kept, control chars stripped, empty / too long / mistyped -> 400", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    expect((await postComment(gid, bid, "  hi  ")).json.comment.body).toBe("hi");
    expect((await postComment(gid, bid, "line1\nline2\n\n\n\nline3")).json.comment.body).toBe("line1\nline2\n\nline3");
    expect((await postComment(gid, bid, "a\u0000b\u001bc\td\r\ne")).json.comment.body).toBe("abcd\ne");
    expect((await postComment(gid, bid, "x".repeat(500))).status).toBe(201);
    for (const bad of ["", "   ", "\n\n", "\u0000\u0001", "x".repeat(501), undefined, null, 5, true, ["a"], { a: 1 }]) {
      const r = await postComment(gid, bid, bad);
      expect(r.status, JSON.stringify(bad)?.slice(0, 40)).toBe(400);
      expect(r.json.error.code).toBe("validation");
    }
    for (const body of ["not json", "[]", "null", '"str"', "5"]) expect((await call("POST", cPath(gid, bid), body)).status, body).toBe(400);
  });

  it("memberId: unknown / foreign-group / mistyped -> 400; null is allowed", async () => {
    const { gid, ids } = await makeGroup();
    const other = await makeGroup();
    const bid = await simpleBill(gid, ids);
    for (const memberId of ["nope", RAND_EID, other.ids.Alice, 5, ["x"], {}, ""]) {
      expect((await call("POST", cPath(gid, bid), { body: "x", memberId })).status, JSON.stringify(memberId)).toBe(400);
    }
    expect((await call("POST", cPath(gid, bid), { body: "x", memberId: null })).status).toBe(201);
  });

  it("caps at 200 comments per bill (409), other bills unaffected, deleting one frees a slot", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    const other = await simpleBill(gid, ids);
    const rows = Array.from({ length: 200 }, (_, i) =>
      env.DB.prepare("INSERT INTO bill_comments (id, bill_id, group_id, body) VALUES (?, ?, ?, ?)").bind(`fill${String(i).padStart(12, "0")}`, bid, gid, `c${i}`),
    );
    await env.DB.batch(rows);
    expect((await getBills(gid)).find((b) => b.id === bid).commentCount).toBe(200);
    const full = await postComment(gid, bid, "one too many");
    expect(full.status).toBe(409);
    expect(full.json.error.code).toBe("conflict");
    expect((await call("GET", cPath(gid, bid))).json.comments).toHaveLength(200);
    expect((await postComment(gid, other, "still fine")).status).toBe(201);
    expect((await call("DELETE", `${cPath(gid, bid)}/fill${String(0).padStart(12, "0")}`)).status).toBe(204);
    expect((await postComment(gid, bid, "now fits")).status).toBe(201);
    expect((await postComment(gid, bid, "full again")).status).toBe(409);
  });

  it("delete: 204 once, then 404; bad ids 404", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    const c = (await postComment(gid, bid, "bye")).json.comment.id;
    expect((await call("DELETE", `${cPath(gid, bid)}/${c}`)).status).toBe(204);
    expect((await call("DELETE", `${cPath(gid, bid)}/${c}`)).status).toBe(404);
    expect((await call("DELETE", `${cPath(gid, bid)}/${RAND_EID}`)).status).toBe(404);
    expect((await call("DELETE", `${cPath(gid, bid)}/short`)).status).toBe(404);
    expect((await call("GET", cPath(gid, "short"))).status).toBe(404);
    expect((await call("GET", cPath(gid, RAND_EID))).status).toBe(404);
    expect((await postComment(gid, RAND_EID, "x")).status).toBe(404);
  });

  it("IDOR: another group's bill/comment is unreachable through this group's path", async () => {
    const A = await makeGroup();
    const B = await makeGroup();
    const billA = await simpleBill(A.gid, A.ids);
    const billB = await simpleBill(B.gid, B.ids);
    const cB = (await postComment(B.gid, billB, "secret B")).json.comment.id;
    // B's bill through A's path
    expect((await call("GET", cPath(A.gid, billB))).status).toBe(404);
    expect((await postComment(A.gid, billB, "intrude")).status).toBe(404);
    expect((await call("DELETE", `${cPath(A.gid, billB)}/${cB}`)).status).toBe(404);
    // B's comment through A's own bill
    expect((await call("DELETE", `${cPath(A.gid, billA)}/${cB}`)).status).toBe(404);
    // A's comment via the right group but wrong bill
    const billA2 = await simpleBill(A.gid, A.ids);
    const cA = (await postComment(A.gid, billA, "mine")).json.comment.id;
    expect((await call("DELETE", `${cPath(A.gid, billA2)}/${cA}`)).status).toBe(404);
    expect((await call("GET", cPath(B.gid, billB))).json.comments.map((c: any) => c.body)).toEqual(["secret B"]);
    expect((await call("GET", cPath(A.gid, billA))).json.comments.map((c: any) => c.body)).toEqual(["mine"]);
  });

  it("soft-deleted bill: comments are 404 (GET/POST/DELETE); restore brings them (and the count) back", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    const c = (await postComment(gid, bid, "keep me")).json.comment.id;
    await postComment(gid, bid, "and me");
    expect((await call("DELETE", `/api/groups/${gid}/bills/${bid}`)).status).toBe(204);
    expect((await call("GET", cPath(gid, bid))).status).toBe(404);
    expect((await postComment(gid, bid, "x")).status).toBe(404);
    expect((await call("DELETE", `${cPath(gid, bid)}/${c}`)).status).toBe(404);
    const n = await env.DB.prepare("SELECT COUNT(*) n FROM bill_comments WHERE bill_id = ?").bind(bid).first<{ n: number }>();
    expect(n!.n).toBe(2);
    expect((await call("POST", `/api/groups/${gid}/bills/${bid}/restore`, {})).status).toBe(200);
    expect((await call("GET", cPath(gid, bid))).json.comments.map((x: any) => x.body)).toEqual(expect.arrayContaining(["keep me", "and me"]));
    expect((await getBills(gid)).find((b) => b.id === bid).commentCount).toBe(2);
  });

  it("archived group: reads work, comment writes are 409", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    const c = (await postComment(gid, bid, "before")).json.comment.id;
    await call("PATCH", `/api/groups/${gid}`, { archived: true });
    expect((await call("GET", cPath(gid, bid))).status).toBe(200);
    expect((await postComment(gid, bid, "after")).status).toBe(409);
    expect((await call("DELETE", `${cPath(gid, bid)}/${c}`)).status).toBe(409);
  });

  it("deleting the author member (not on any bill) keeps the comment with authorMemberId null; members on bills cannot be removed", async () => {
    const { gid, ids } = await makeGroup(["Alice", "Bob", "Carol", "Dave"]);
    const bid = await simpleBill(gid, ids);
    // Dave posts as himself (his own sign-in), then is removed.
    expect((await call("PATCH", `/api/groups/${gid}/members/${ids.Dave}`, { email: "dave@x.io" })).status).toBe(200);
    const byDave = (await call("POST", cPath(gid, bid), { body: "from dave" }, { "Cf-Access-Authenticated-User-Email": "dave@x.io" })).json.comment.id;
    const byAlice = (await postComment(gid, bid, "from alice")).json.comment.id;
    expect((await call("DELETE", `/api/groups/${gid}/members/${ids.Alice}`)).status).toBe(409);
    expect((await call("DELETE", `/api/groups/${gid}/members/${ids.Dave}`)).status).toBe(204);
    const list = (await call("GET", cPath(gid, bid))).json.comments as any[];
    expect(list).toHaveLength(2);
    expect(list.find((c) => c.id === byDave)).toMatchObject({ body: "from dave", authorMemberId: null });
    expect(list.find((c) => c.id === byAlice).authorMemberId).toBe(ids.Alice);
  });

  it("deleting the group removes its comments and subgroups", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    await postComment(gid, bid, "x");
    await call("POST", `/api/groups/${gid}/subgroups`, { name: "S", memberIds: [ids.Alice] });
    expect((await call("DELETE", `/api/groups/${gid}?forever=1`)).status).toBe(204);
    for (const t of ["bill_comments", "subgroups"]) {
      const n = await env.DB.prepare(`SELECT COUNT(*) n FROM ${t} WHERE group_id = ?`).bind(gid).first<{ n: number }>();
      expect(n!.n, t).toBe(0);
    }
  });
});

// ============================================================================

describe("subgroups", () => {
  const sgPath = (gid: string, sid = "") => `/api/groups/${gid}/subgroups${sid ? `/${sid}` : ""}`;

  it("create / list / update / delete round trip", async () => {
    const { gid, ids } = await makeGroup();
    expect((await call("GET", sgPath(gid))).json).toEqual({ subgroups: [] });
    const c = await call("POST", sgPath(gid), { name: "  The   Couple ", memberIds: [ids.Alice, ids.Bob] });
    expect(c.status, c.text).toBe(201);
    expect(c.json.subgroup).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/), name: "The Couple", memberIds: [ids.Alice, ids.Bob] });
    const sid = c.json.subgroup.id;
    expect((await call("GET", sgPath(gid))).json.subgroups).toEqual([c.json.subgroup]);
    const u = await call("PUT", sgPath(gid, sid), { name: "Renamed", memberIds: [ids.Carol] });
    expect(u.status, u.text).toBe(200);
    expect(u.json.subgroup).toEqual({ id: sid, name: "Renamed", memberIds: [ids.Carol] });
    expect((await call("GET", sgPath(gid))).json.subgroups).toEqual([u.json.subgroup]);
    expect((await call("DELETE", sgPath(gid, sid))).status).toBe(204);
    expect((await call("GET", sgPath(gid))).json.subgroups).toEqual([]);
    expect((await call("DELETE", sgPath(gid, sid))).status).toBe(404);
    expect((await call("PUT", sgPath(gid, sid), { name: "x", memberIds: [ids.Alice] })).status).toBe(404);
  });

  it("validation: name 1-40, memberIds non-empty/unique/known -> 400", async () => {
    const { gid, ids } = await makeGroup();
    const other = await makeGroup();
    expect((await call("POST", sgPath(gid), { name: "x".repeat(40), memberIds: [ids.Alice] })).status).toBe(201);
    const bad: unknown[] = [
      { name: "", memberIds: [ids.Alice] },
      { name: "x".repeat(41), memberIds: [ids.Alice] },
      { name: 5, memberIds: [ids.Alice] },
      { memberIds: [ids.Alice] },
      { name: "ok" },
      { name: "ok", memberIds: [] },
      { name: "ok", memberIds: "alice" },
      { name: "ok", memberIds: [ids.Alice, ids.Alice] },
      { name: "ok", memberIds: ["ghost"] },
      { name: "ok", memberIds: [other.ids.Alice] },
      { name: "ok", memberIds: [ids.Alice, other.ids.Bob] },
      { name: "ok", memberIds: [7] },
      [],
      "str",
    ];
    for (const b of bad) {
      const r = await call("POST", sgPath(gid), b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.json.error.code).toBe("validation");
    }
    expect((await call("GET", sgPath(gid))).json.subgroups).toHaveLength(1);
  });

  it("an unknown member on update -> 400 and the subgroup is unchanged", async () => {
    const { gid, ids } = await makeGroup();
    const sid = (await call("POST", sgPath(gid), { name: "S", memberIds: [ids.Alice] })).json.subgroup.id;
    expect((await call("PUT", sgPath(gid, sid), { name: "S2", memberIds: ["ghost"] })).status).toBe(400);
    expect((await call("GET", sgPath(gid))).json.subgroups[0]).toMatchObject({ name: "S", memberIds: [ids.Alice] });
  });

  it("at most 20 subgroups per group (409); deleting one frees a slot; other groups are independent", async () => {
    const { gid, ids } = await makeGroup();
    const made: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await call("POST", sgPath(gid), { name: `S${i}`, memberIds: [ids.Alice] });
      expect(r.status, `#${i}`).toBe(201);
      made.push(r.json.subgroup.id);
    }
    const over = await call("POST", sgPath(gid), { name: "S20", memberIds: [ids.Alice] });
    expect(over.status).toBe(409);
    expect(over.json.error.code).toBe("conflict");
    const other = await makeGroup();
    expect((await call("POST", sgPath(other.gid), { name: "ok", memberIds: [other.ids.Alice] })).status).toBe(201);
    expect((await call("DELETE", sgPath(gid, made[3]))).status).toBe(204);
    expect((await call("POST", sgPath(gid), { name: "S20", memberIds: [ids.Alice] })).status).toBe(201);
    expect((await call("POST", sgPath(gid), { name: "S21", memberIds: [ids.Alice] })).status).toBe(409);
    expect((await call("GET", sgPath(gid))).json.subgroups).toHaveLength(20);
  });

  it("removing a member strips them from subgroups; subgroups left empty are deleted", async () => {
    const { gid, ids } = await makeGroup(["Alice", "Bob", "Carol", "Dave"]);
    await simpleBill(gid, ids); // Alice, Bob, Carol on a bill; Dave free to remove
    const mk = async (name: string, memberIds: string[]) => (await call("POST", sgPath(gid), { name, memberIds })).json.subgroup.id as string;
    const s1 = await mk("with-dave-and-alice", [ids.Dave, ids.Alice]);
    const s2 = await mk("only-dave", [ids.Dave]);
    const s3 = await mk("alice-bob", [ids.Alice, ids.Bob]);
    expect((await call("DELETE", `/api/groups/${gid}/members/${ids.Dave}`)).status).toBe(204);
    const list = (await call("GET", sgPath(gid))).json.subgroups as any[];
    expect(list.map((s) => s.id)).toEqual([s1, s3]);
    expect(list.find((s) => s.id === s1).memberIds).toEqual([ids.Alice]);
    expect(list.find((s) => s.id === s3).memberIds).toEqual([ids.Alice, ids.Bob]);
    expect(list.some((s) => s.id === s2)).toBe(false);
  });

  it("IDOR: another group's subgroup cannot be read, changed or deleted through this group's path", async () => {
    const A = await makeGroup();
    const B = await makeGroup();
    const sidB = (await call("POST", sgPath(B.gid), { name: "B-only", memberIds: [B.ids.Alice] })).json.subgroup.id;
    expect((await call("PUT", sgPath(A.gid, sidB), { name: "hijack", memberIds: [A.ids.Alice] })).status).toBe(404);
    expect((await call("DELETE", sgPath(A.gid, sidB))).status).toBe(404);
    expect((await call("GET", sgPath(A.gid))).json.subgroups).toEqual([]);
    expect((await call("GET", sgPath(B.gid))).json.subgroups[0]).toMatchObject({ id: sidB, name: "B-only", memberIds: [B.ids.Alice] });
  });

  it("bad ids and archived groups", async () => {
    const { gid, ids } = await makeGroup();
    expect((await call("PUT", sgPath(gid, "short"), { name: "x", memberIds: [ids.Alice] })).status).toBe(404);
    expect((await call("DELETE", sgPath(gid, "short"))).status).toBe(404);
    expect((await call("DELETE", sgPath(gid, RAND_EID))).status).toBe(404);
    const sid = (await call("POST", sgPath(gid), { name: "S", memberIds: [ids.Alice] })).json.subgroup.id;
    await call("PATCH", `/api/groups/${gid}`, { archived: true });
    expect((await call("GET", sgPath(gid))).status).toBe(200);
    expect((await call("POST", sgPath(gid), { name: "T", memberIds: [ids.Alice] })).status).toBe(409);
    expect((await call("PUT", sgPath(gid, sid), { name: "T", memberIds: [ids.Alice] })).status).toBe(409);
    expect((await call("DELETE", sgPath(gid, sid))).status).toBe(409);
  });
});

// ============================================================================

describe("read-only view links", () => {
  const vlPath = (gid: string) => `/api/groups/${gid}/view-link`;
  const view = (vid: string) => call("GET", `/api/view/${vid}`);

  it("none by default; create -> 201 with a 22-char id distinct from the group id; GET returns it", async () => {
    const { gid } = await makeGroup();
    expect((await call("GET", vlPath(gid))).json).toEqual({ viewId: null });
    const c = await call("POST", vlPath(gid), {});
    expect(c.status, c.text).toBe(201);
    expect(c.json.viewId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(c.json.viewId).not.toBe(gid);
    expect((await call("GET", vlPath(gid))).json).toEqual({ viewId: c.json.viewId });
    expect((await call("GET", vlPath(gid))).json.viewId).toBe(c.json.viewId);
  });

  it("rotating gives a new id and the old one stops working (404); revoke -> 204 and the link is dead", async () => {
    const { gid } = await makeGroup();
    const v1 = (await call("POST", vlPath(gid), {})).json.viewId;
    expect((await view(v1)).status).toBe(200);
    const v2 = (await call("POST", vlPath(gid), {})).json.viewId;
    expect(v2).not.toBe(v1);
    expect((await view(v1)).status).toBe(404);
    expect((await view(v2)).status).toBe(200);
    expect((await call("DELETE", vlPath(gid))).status).toBe(204);
    expect((await view(v2)).status).toBe(404);
    expect((await call("GET", vlPath(gid))).json).toEqual({ viewId: null });
    expect((await call("DELETE", vlPath(gid))).status).toBe(204); // idempotent
    const v3 = (await call("POST", vlPath(gid), {})).json.viewId;
    expect((await view(v3)).status).toBe(200);
    expect((await view(v2)).status).toBe(404);
  });

  it("activity: viewlink.create on create/rotate, viewlink.revoke on revoke", async () => {
    const { gid } = await makeGroup();
    await call("POST", vlPath(gid), {});
    await call("POST", vlPath(gid), {});
    await call("DELETE", vlPath(gid));
    const acts = (await activity(gid)).map((a) => a.action);
    expect(acts.filter((a) => a === "viewlink.create")).toHaveLength(2);
    expect(acts.filter((a) => a === "viewlink.revoke")).toHaveLength(1);
  });

  it("the shared snapshot hides group id, promptpay, createdBy, hasReceipt, recurrenceId; summary matches; readOnly", async () => {
    const { gid, ids } = await makeGroup(["Alice", "Bob", "Carol"], "USD", "Hidden Trip");
    const who = { "Cf-Access-Authenticated-User-Email": "creator@example.com" };
    await call("PATCH", `/api/groups/${gid}/members/${ids.Bob}`, { email: "creator@example.com" });
    await call("PATCH", `/api/groups/${gid}/members/${ids.Alice}`, { promptpay: "0812345678" });
    const bid = (await call("POST", `/api/groups/${gid}/bills`, {
      description: "Dinner", date: DATE, amount: 900, paidBy: ids.Alice, split: equal([ids.Alice, ids.Bob, ids.Carol]),
    }, who)).json.bill.id;
    await call("POST", `/api/groups/${gid}/bills`, {
      description: "Cab", date: DATE, amount: 301, paidBy: ids.Bob, split: equal([ids.Alice, ids.Bob]),
    }, who);
    await call("POST", cPath(gid, bid), { body: "nice one" }, who);
    const png = new Uint8Array(40);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    expect((await raw("PUT", `/api/groups/${gid}/bills/${bid}/receipt`, png, "image/png")).status).toBe(201);
    const rec = await call("POST", `/api/groups/${gid}/recurring`, {
      frequency: "weekly", startDate: daysAgo(1), bill: { description: "Rent", amount: 300, paidBy: ids.Carol, split: equal([ids.Alice, ids.Carol]) },
    }, who);
    expect(rec.json.created).toBeGreaterThanOrEqual(1);
    const full = (await call("GET", `/api/groups/${gid}`)).json;
    expect(full.bills.some((b: any) => b.hasReceipt === true && b.createdBy === "creator@example.com")).toBe(true);
    expect(full.bills.some((b: any) => b.recurrenceId)).toBe(true);
    expect(full.members.find((m: any) => m.name === "Alice").promptpay).toBe("0812345678");

    const vid = (await call("POST", vlPath(gid), {})).json.viewId;
    const v = await view(vid);
    expect(v.status).toBe(200);
    expect(v.headers.get("cache-control")).toBe("no-store");
    expect(v.json.readOnly).toBe(true);
    expect(Object.keys(v.json).sort()).toEqual(["bills", "group", "members", "readOnly", "summary"]);

    expect(v.json.group).toEqual({ name: "Hidden Trip", currency: "USD", archived: false, createdAt: full.group.createdAt, budget: null });
    expect(v.json.group).not.toHaveProperty("id");
    expect(v.text).not.toContain(gid);
    expect(v.text).not.toContain("812345678");
    expect(v.text).not.toContain("creator@example.com");
    for (const m of v.json.members) expect(m).not.toHaveProperty("promptpay");
    expect(v.json.members.map((m: any) => m.name).sort()).toEqual(["Alice", "Bob", "Carol"]);
    expect(v.json.bills).toHaveLength(full.bills.length);
    for (const b of v.json.bills) {
      for (const k of ["createdBy", "hasReceipt", "recurrenceId"]) expect(b, k).not.toHaveProperty(k);
      for (const k of ["id", "description", "amount", "payers", "shares", "split", "date", "category", "kind", "commentCount"]) expect(b, k).toHaveProperty(k);
    }
    expect(v.json.bills.find((b: any) => b.id === bid).commentCount).toBe(1);
    expect(v.json.summary).toEqual(await summaryOf(gid));
  });

  it("summary is correct (hand-computed) and tracks later changes; soft-deleted bills are not shown", async () => {
    const { gid, ids } = await makeGroup();
    const vid = (await call("POST", vlPath(gid), {})).json.viewId;
    expect((await view(vid)).json.bills).toEqual([]);
    const b1 = await simpleBill(gid, ids); // Alice paid 900, 300 each
    const live = (await view(vid)).json;
    expect(live.summary.total).toBe(900);
    const net = Object.fromEntries(live.summary.balances.map((b: any) => [b.memberId, b.net]));
    expect(net).toEqual({ [ids.Alice]: 600, [ids.Bob]: -300, [ids.Carol]: -300 });
    expect(live.summary.settlements.reduce((a: number, s: any) => a + s.amount, 0)).toBe(600);
    await call("DELETE", `/api/groups/${gid}/bills/${b1}`);
    const after = (await view(vid)).json;
    expect(after.bills).toEqual([]);
    expect(after.summary.total).toBe(0);
  });

  it("unknown / malformed / mistyped view ids -> 404", async () => {
    const { gid } = await makeGroup();
    await call("POST", vlPath(gid), {});
    for (const vid of [RAND_GID, "short", "A".repeat(21), "A".repeat(23), "A".repeat(22), encodeURIComponent("' OR 1=1 --"), "%00", gid]) {
      const r = await view(vid);
      expect(r.status, vid).toBe(404);
      expect(r.json.error.code).toBe("not_found");
    }
    expect((await call("GET", "/api/view/")).status).toBe(404);
    // a group id is not a view id, and a view id is not a group id
    const vid = (await call("GET", vlPath(gid))).json.viewId;
    expect((await call("GET", `/api/groups/${vid}`)).status).toBe(404);
    expect((await call("POST", `/api/groups/${vid}/bills`, { description: "x", date: DATE, amount: 1, paidBy: "x", split: equal(["x"]) })).status).toBe(404);
  });

  it("deleting the group kills its view link", async () => {
    const { gid } = await makeGroup();
    const vid = (await call("POST", vlPath(gid), {})).json.viewId;
    await call("DELETE", `/api/groups/${gid}`); // to the bin: the link stops working there too (v0.10)
    expect((await view(vid)).status).toBe(404);
    expect((await call("POST", `/api/groups/${gid}/restore`, {})).status).toBe(200);
    expect((await view(vid)).status).toBe(200);
  });

  it("archived group: view still works, revoke is allowed (204), create/rotate and other writes are 409", async () => {
    const { gid, ids } = await makeGroup();
    const vid = (await call("POST", vlPath(gid), {})).json.viewId;
    const bid = await simpleBill(gid, ids);
    await call("PATCH", `/api/groups/${gid}`, { archived: true });
    const v = await view(vid);
    expect(v.status).toBe(200);
    expect(v.json.group.archived).toBe(true);
    expect((await call("GET", vlPath(gid))).json.viewId).toBe(vid);
    expect((await call("POST", vlPath(gid), {})).status).toBe(409);
    expect((await postComment(gid, bid, "x")).status).toBe(409);
    expect((await addBill(gid, { amount: 1, paidBy: ids.Alice, split: equal([ids.Alice]) })).status).toBe(409);
    expect((await call("DELETE", vlPath(gid))).status).toBe(204);
    expect((await view(vid)).status).toBe(404);
    expect((await call("GET", vlPath(gid))).json.viewId).toBeNull();
  });
});

// ============================================================================

describe("move a bill to another group", () => {
  const mvPath = (gid: string, bid: string) => `/api/groups/${gid}/bills/${bid}/move`;
  const move = (gid: string, bid: string, targetGroupId: string, addMissingMembers?: boolean) =>
    call("POST", mvPath(gid, bid), addMissingMembers === undefined ? { targetGroupId } : { targetGroupId, addMissingMembers });

  /** Bills of every split mode / payer shape (group currency USD, members Alice/Bob/Carol). */
  const variants = (ids: Ids): [string, Record<string, unknown>][] => [
    ["equal", { description: "equal", amount: 1000, paidBy: ids.Alice, split: equal([ids.Alice, ids.Bob, ids.Carol]) }],
    ["exact", {
      description: "exact", amount: 1000, paidBy: ids.Bob,
      split: { mode: "exact", shares: [{ memberId: ids.Alice, amount: 400 }, { memberId: ids.Bob, amount: 350 }, { memberId: ids.Carol, amount: 250 }] },
    }],
    ["shares", {
      description: "shares", amount: 1000, paidBy: ids.Carol,
      split: { mode: "shares", weights: [{ memberId: ids.Alice, weight: 1 }, { memberId: ids.Bob, weight: 2 }, { memberId: ids.Carol, weight: 0 }] },
    }],
    ["percent", {
      description: "percent", amount: 1001, paidBy: ids.Alice,
      split: { mode: "percent", percents: [{ memberId: ids.Alice, bp: 5000 }, { memberId: ids.Bob, bp: 3000 }, { memberId: ids.Carol, bp: 2000 }] },
    }],
    ["itemized", {
      description: "itemized", paidBy: ids.Bob,
      split: {
        mode: "itemized", serviceBp: 1000, taxBp: 700,
        items: [
          { description: "Steak", amount: 3000, members: [ids.Alice] },
          { description: "Pasta", amount: 2000, members: [ids.Bob] },
          { description: "Wine", amount: 3500, members: [ids.Alice, ids.Bob, ids.Carol] },
        ],
      },
    }],
    ["multi-payer", {
      description: "multi-payer", amount: 1000, payers: [{ memberId: ids.Alice, amount: 600 }, { memberId: ids.Bob, amount: 400 }],
      split: equal([ids.Alice, ids.Bob, ids.Carol]),
    }],
    ["fx", {
      description: "fx", paidBy: ids.Carol, fx: { currency: "EUR", amount: 1000, rate: "1.50000000" }, split: equal([ids.Alice, ids.Carol]),
    }],
    ["payment", { description: "payment", kind: "payment", amount: 700, paidBy: ids.Bob, split: equal([ids.Alice]) }],
  ];

  it("moves every split mode / payer shape: ids remapped by name, everything else identical, nets conserved, balances sum to 0", async () => {
    const A = await makeGroup(["Alice", "Bob", "Carol"], "USD", "Source");
    const B = await makeGroup(["alice", "BOB", "carol", "Dave"], "USD", "Target"); // case differs, extra member
    const bids: Record<string, string> = {};
    for (const [label, body] of variants(A.ids)) {
      const r = await addBill(A.gid, body);
      expect(r.status, `${label}: ${r.text}`).toBe(201);
      bids[label] = r.json.bill.id;
    }
    const before = Object.fromEntries((await getBills(A.gid)).map((b) => [b.id, comparable(b, A.ids)]));
    const netBefore = await netsByName(A.gid, A.ids);
    expect(Object.values(netBefore).some((n) => n !== 0)).toBe(true);

    for (const [label, bid] of Object.entries(bids)) {
      const r = await move(A.gid, bid, B.gid);
      expect(r.status, `${label}: ${r.text}`).toBe(200);
      expect(r.json.targetGroupId).toBe(B.gid);
      expect(r.json.addedMembers).toEqual([]);
      expect(r.json.bill.id).toBe(bid);
      const text = JSON.stringify(r.json.bill);
      for (const id of Object.values(A.ids)) expect(text, `${label} still references a source member`).not.toContain(id);
    }

    const moved = await getBills(B.gid);
    expect(moved).toHaveLength(Object.keys(bids).length);
    for (const b of moved) {
      expect(comparable(b, B.ids), b.description).toEqual(before[b.id]);
      expect(b.recurrenceId).toBeNull();
      for (const p of b.payers) expect(Object.values(B.ids)).toContain(p.memberId);
      for (const s of b.shares) expect(Object.values(B.ids)).toContain(s.memberId);
    }
    // fx and itemized details survived
    expect(moved.find((b) => b.description === "fx")).toMatchObject({ amount: 1500, fx: { currency: "EUR", amount: 1000, rate: "1.50000000" } });
    expect(moved.find((b) => b.description === "itemized").split.items).toHaveLength(3);

    expect(await getBills(A.gid)).toEqual([]);
    const netA = await netsByName(A.gid, A.ids);
    expect(Object.values(netA).every((n) => n === 0)).toBe(true);
    const netB = await netsByName(B.gid, B.ids);
    for (const [name, net] of Object.entries(netBefore)) expect(netB[name], name).toBe(net);
    expect(netB.dave).toBe(0);
  });

  it("partial move keeps value: net(A after) + net(B after) == net(A before)", async () => {
    const A = await makeGroup();
    const B = await makeGroup(["Alice", "Bob", "Carol"]);
    const keep = await simpleBill(A.gid, A.ids, { amount: 1200, paidBy: A.ids.Bob });
    const go = await simpleBill(A.gid, A.ids, { amount: 3001, paidBy: A.ids.Carol });
    const before = await netsByName(A.gid, A.ids);
    expect((await move(A.gid, go, B.gid)).status).toBe(200);
    const a = await netsByName(A.gid, A.ids);
    const b = await netsByName(B.gid, B.ids);
    for (const n of Object.keys(before)) expect(a[n] + b[n], n).toBe(before[n]);
    expect((await getBills(A.gid)).map((x) => x.id)).toEqual([keep]);
    expect((await getBills(B.gid)).map((x) => x.id)).toEqual([go]);
  });

  it("the bill is gone from the source (404 on edit/delete/comments) and fully usable in the target", async () => {
    const A = await makeGroup();
    const B = await makeGroup(["Alice", "Bob", "Carol"]);
    const bid = await simpleBill(A.gid, A.ids);
    expect((await move(A.gid, bid, B.gid)).status).toBe(200);
    expect((await call("DELETE", `/api/groups/${A.gid}/bills/${bid}`)).status).toBe(404);
    expect((await call("GET", cPath(A.gid, bid))).status).toBe(404);
    expect((await move(A.gid, bid, B.gid)).status).toBe(404); // cannot move twice
    const put = await call("PUT", `/api/groups/${B.gid}/bills/${bid}`, {
      description: "Edited in B", date: DATE, amount: 300, paidBy: B.ids.Alice, split: equal([B.ids.Alice, B.ids.Bob]),
    });
    expect(put.status, put.text).toBe(200);
    expect((await call("DELETE", `/api/groups/${B.gid}/bills/${bid}`)).status).toBe(204);
  });

  it("missing members -> 409 missing_members with the names, nothing moved; addMissingMembers adds them (case-insensitive match for the rest)", async () => {
    const A = await makeGroup(["Alice", "Bob", "Carol"], "USD", "Src");
    const B = await makeGroup(["ALICE"], "USD", "Dst");
    const bid = await simpleBill(A.gid, A.ids);
    const r = await move(A.gid, bid, B.gid);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("missing_members");
    expect([...r.json.error.missing].sort()).toEqual(["Bob", "Carol"]);
    expect((await getBills(A.gid)).map((b) => b.id)).toEqual([bid]);
    expect(await getBills(B.gid)).toEqual([]);
    expect((await call("GET", `/api/groups/${B.gid}`)).json.members).toHaveLength(1);

    const ok = await move(A.gid, bid, B.gid, true);
    expect(ok.status, ok.text).toBe(200);
    expect([...ok.json.addedMembers].sort()).toEqual(["Bob", "Carol"]);
    const members = (await call("GET", `/api/groups/${B.gid}`)).json.members as { id: string; name: string }[];
    expect(members.map((m) => m.name)).toEqual(["ALICE", "Bob", "Carol"]); // existing kept as-is, new appended in order
    const ids = Object.fromEntries(members.map((m) => [m.name, m.id]));
    const b = ok.json.bill;
    expect(b.payers).toEqual([{ memberId: ids.ALICE, amount: 900 }]);
    expect(b.shares.map((s: any) => s.memberId).sort()).toEqual([ids.ALICE, ids.Bob, ids.Carol].sort());
    expect(b.split.members.sort()).toEqual([ids.ALICE, ids.Bob, ids.Carol].sort());
    // source members are untouched
    expect((await call("GET", `/api/groups/${A.gid}`)).json.members).toHaveLength(3);
    // member.add activity was written in the target
    expect((await activity(B.gid)).filter((a) => a.action === "member.add")).toHaveLength(2);
  });

  it("only members the bill actually uses are required / added", async () => {
    const A = await makeGroup(["Alice", "Bob", "Carol"]);
    const B = await makeGroup(["Alice", "Bob"]);
    const bid = await simpleBill(A.gid, A.ids, { amount: 500, paidBy: A.ids.Alice, split: equal([A.ids.Alice, A.ids.Bob]) });
    const r = await move(A.gid, bid, B.gid); // Carol unused -> nothing missing
    expect(r.status, r.text).toBe(200);
    expect(r.json.addedMembers).toEqual([]);
    expect((await call("GET", `/api/groups/${B.gid}`)).json.members).toHaveLength(2);
  });

  it("target would exceed 50 members -> 409 conflict", async () => {
    const A = await makeGroup(["Zed", "Alice"]);
    const names = Array.from({ length: 50 }, (_, i) => `M${i}`);
    const B = await makeGroup(names);
    const bid = await simpleBill(A.gid, A.ids, { amount: 100, paidBy: A.ids.Zed, split: equal([A.ids.Zed, A.ids.Alice]) });
    const r = await move(A.gid, bid, B.gid, true);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("conflict");
    expect((await getBills(A.gid)).map((b) => b.id)).toEqual([bid]);
  });

  it("validation: currency mismatch / same group / bad & unknown target / non-boolean flag", async () => {
    const A = await makeGroup(["Alice", "Bob", "Carol"], "USD");
    const THB = await makeGroup(["Alice", "Bob", "Carol"], "THB");
    const bid = await simpleBill(A.gid, A.ids);
    const cur = await move(A.gid, bid, THB.gid, true);
    expect(cur.status).toBe(400);
    expect(cur.json.error.message).toMatch(/USD.*THB/);
    const same = await move(A.gid, bid, A.gid);
    expect(same.status).toBe(400);
    expect(same.json.error.code).toBe("validation");
    expect((await move(A.gid, bid, RAND_GID)).status).toBe(404);
    for (const t of ["short", "A".repeat(23), 5, null, undefined, [A.gid]]) {
      expect((await call("POST", mvPath(A.gid, bid), { targetGroupId: t })).status, String(t)).toBe(400);
    }
    for (const flag of ["true", 1, null]) expect((await call("POST", mvPath(A.gid, bid), { targetGroupId: THB.gid, addMissingMembers: flag })).status, String(flag)).toBe(400);
    expect((await call("POST", mvPath(A.gid, bid), "nope")).status).toBe(400);
    expect((await getBills(A.gid)).map((b) => b.id)).toEqual([bid]);
  });

  it("bad / unknown / soft-deleted bill -> 404", async () => {
    const A = await makeGroup();
    const B = await makeGroup(["Alice", "Bob", "Carol"]);
    const bid = await simpleBill(A.gid, A.ids);
    expect((await move(A.gid, "short", B.gid)).status).toBe(404);
    expect((await move(A.gid, RAND_EID, B.gid)).status).toBe(404);
    await call("DELETE", `/api/groups/${A.gid}/bills/${bid}`);
    expect((await move(A.gid, bid, B.gid)).status).toBe(404);
    // a bill of B cannot be moved through A's path
    const billB = await simpleBill(B.gid, B.ids);
    expect((await move(A.gid, billB, B.gid)).status).toBe(404);
  });

  it("archived target -> 409 archived; archived source -> 409 archived", async () => {
    const A = await makeGroup();
    const B = await makeGroup(["Alice", "Bob", "Carol"]);
    const bid = await simpleBill(A.gid, A.ids);
    await call("PATCH", `/api/groups/${B.gid}`, { archived: true });
    const t = await move(A.gid, bid, B.gid);
    expect(t.status).toBe(409);
    expect(t.json.error.code).toBe("archived");
    await call("PATCH", `/api/groups/${B.gid}`, { archived: false });
    await call("PATCH", `/api/groups/${A.gid}`, { archived: true });
    const s = await move(A.gid, bid, B.gid);
    expect(s.status).toBe(409);
    expect(s.json.error.code).toBe("archived");
    expect(await getBills(B.gid)).toEqual([]);
  });

  it("comments follow the bill (author link dropped, count kept); recurrenceId is cleared", async () => {
    const A = await makeGroup();
    const B = await makeGroup(["Alice", "Bob", "Carol"]);
    const bid = await simpleBill(A.gid, A.ids);
    await postComment(A.gid, bid, "first");
    await postComment(A.gid, bid, "second");
    await postComment(A.gid, bid, "third");
    expect((await move(A.gid, bid, B.gid)).status).toBe(200);
    const list = (await call("GET", cPath(B.gid, bid))).json.comments as any[];
    expect(list.map((c) => c.body).sort()).toEqual(["first", "second", "third"]);
    for (const c of list) {
      expect(c.authorMemberId).toBeNull();
      expect(c.billId).toBe(bid);
    }
    expect((await getBills(B.gid))[0].commentCount).toBe(3);
    const rows = await env.DB.prepare("SELECT group_id FROM bill_comments WHERE bill_id = ?").bind(bid).all<{ group_id: string }>();
    expect(rows.results.every((r) => r.group_id === B.gid)).toBe(true);
    // new comments in the new home work, with the new group's members
    expect((await postComment(B.gid, bid, "fourth", B.ids.Carol)).status).toBe(201);
    // ...and the source can no longer see them
    expect((await call("GET", cPath(A.gid, bid))).status).toBe(404);

    // recurrence link
    const rec = await call("POST", `/api/groups/${A.gid}/recurring`, {
      frequency: "weekly", startDate: daysAgo(1), bill: { description: "Rent", amount: 600, paidBy: A.ids.Alice, split: equal([A.ids.Alice, A.ids.Bob]) },
    });
    expect(rec.json.created).toBe(1);
    const recBill = (await getBills(A.gid)).find((b) => b.recurrenceId)!;
    expect(recBill).toBeTruthy();
    const mv = await move(A.gid, recBill.id, B.gid);
    expect(mv.status, mv.text).toBe(200);
    expect(mv.json.bill.recurrenceId).toBeNull();
    expect((await getBills(B.gid)).find((b) => b.id === recBill.id).recurrenceId).toBeNull();
  });

  it("activity: bill.moveOut in the source and bill.moveIn in the target, with names and amounts", async () => {
    const A = await makeGroup(["Alice", "Bob", "Carol"], "USD", "From Trip");
    const B = await makeGroup(["Alice", "Bob", "Carol"], "USD", "To Trip");
    const bid = await simpleBill(A.gid, A.ids, { description: "Taxi", amount: 1234 });
    const who = { "Cf-Access-Authenticated-User-Email": "mover@example.com" };
    for (const g of [A, B]) await call("PATCH", `/api/groups/${g.gid}/members/${g.ids.Bob}`, { email: "mover@example.com" }); // in both trips
    expect((await call("POST", mvPath(A.gid, bid), { targetGroupId: B.gid }, who)).status).toBe(200);
    const out = (await activity(A.gid)).find((a) => a.action === "bill.moveOut")!;
    const inn = (await activity(B.gid)).find((a) => a.action === "bill.moveIn")!;
    expect(out).toMatchObject({ entityId: bid, actor: "mover@example.com", detail: { description: "Taxi", amount: 1234, to: "To Trip" } });
    expect(inn).toMatchObject({ entityId: bid, actor: "mover@example.com", detail: { description: "Taxi", amount: 1234, from: "From Trip" } });
    expect((await activity(A.gid)).some((a) => a.action === "bill.moveIn")).toBe(false);
    expect((await activity(B.gid)).some((a) => a.action === "bill.moveOut")).toBe(false);
  });

  it("the receipt moves with the bill and survives deleting the source group", async () => {
    const A = await makeGroup();
    const B = await makeGroup(["Alice", "Bob", "Carol"]);
    const bid = await simpleBill(A.gid, A.ids);
    const png = new Uint8Array(40);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    expect((await raw("PUT", `/api/groups/${A.gid}/bills/${bid}/receipt`, png, "image/png")).status).toBe(201);
    expect((await move(A.gid, bid, B.gid)).json.bill.hasReceipt).toBe(true);
    expect((await call("GET", `/api/groups/${A.gid}/bills/${bid}/receipt`)).status).toBe(404);
    const res = await exports.default.fetch(new Request(`http://example.com/api/groups/${B.gid}/bills/${bid}/receipt`));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
    expect((await call("DELETE", `/api/groups/${A.gid}`)).status).toBe(204);
    expect((await exports.default.fetch(new Request(`http://example.com/api/groups/${B.gid}/bills/${bid}/receipt`))).status).toBe(200);
  });

  it("subgroups of the source are untouched by a move; none are created in the target", async () => {
    const A = await makeGroup();
    const B = await makeGroup(["Alice", "Bob", "Carol"]);
    const sid = (await call("POST", `/api/groups/${A.gid}/subgroups`, { name: "S", memberIds: [A.ids.Alice, A.ids.Bob] })).json.subgroup.id;
    const bid = await simpleBill(A.gid, A.ids);
    expect((await move(A.gid, bid, B.gid)).status).toBe(200);
    expect((await call("GET", `/api/groups/${A.gid}/subgroups`)).json.subgroups).toEqual([{ id: sid, name: "S", memberIds: [A.ids.Alice, A.ids.Bob] }]);
    expect((await call("GET", `/api/groups/${B.gid}/subgroups`)).json.subgroups).toEqual([]);
  });
});

// ============================================================================

describe("merge groups", () => {
  const mergePath = (gid: string) => `/api/groups/${gid}/merge`;
  const merge = (into: string, sourceGroupId: string, addMissingMembers?: boolean) =>
    call("POST", mergePath(into), addMissingMembers === undefined ? { sourceGroupId } : { sourceGroupId, addMissingMembers });
  const dbGroupOfBill = async (bid: string) => (await env.DB.prepare("SELECT group_id g, deleted_at d FROM bills WHERE id = ?").bind(bid).first<{ g: string; d: string | null }>())!;

  it("moves all live bills into the target, leaves soft-deleted ones in the source, archives the source, adds missing members", async () => {
    const S = await makeGroup(["Alice", "Bob", "Carol"], "USD", "Source Trip");
    const T = await makeGroup(["alice", "Bob"], "USD", "Target Trip");
    const s1 = await simpleBill(S.gid, S.ids, { description: "s1" });
    const s2 = await simpleBill(S.gid, S.ids, { description: "s2", amount: 501, paidBy: S.ids.Carol });
    const s3 = await simpleBill(S.gid, S.ids, { description: "s3", amount: 77, paidBy: S.ids.Bob, split: equal([S.ids.Bob, S.ids.Carol]) });
    const deleted = await simpleBill(S.gid, S.ids, { description: "gone" });
    await call("DELETE", `/api/groups/${S.gid}/bills/${deleted}`);
    const t1 = await simpleBill(T.gid, { Alice: T.ids.alice, Bob: T.ids.Bob, Carol: T.ids.Bob }, { description: "t1", amount: 400, paidBy: T.ids.alice, split: equal([T.ids.alice, T.ids.Bob]) });
    await postComment(S.gid, s1, "carried over", S.ids.Alice);

    const netS = await netsByName(S.gid, S.ids);
    const netT = await netsByName(T.gid, T.ids);

    // Carol is on the bills but missing in the target
    const refused = await merge(T.gid, S.gid);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatchObject({ code: "missing_members", missing: ["Carol"] });
    expect((await call("GET", `/api/groups/${S.gid}`)).json.group.archived).toBe(false);
    expect(await getBills(T.gid)).toHaveLength(1);

    const r = await merge(T.gid, S.gid, true);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toEqual({ moved: 3, addedMembers: ["Carol"], sourceArchived: true });

    const tBills = await getBills(T.gid);
    expect(tBills.map((b) => b.id).sort()).toEqual([s1, s2, s3, t1].sort());
    const tMembers = (await call("GET", `/api/groups/${T.gid}`)).json.members as { id: string; name: string }[];
    expect(tMembers.map((m) => m.name)).toEqual(["alice", "Bob", "Carol"]);
    const tIds = Object.fromEntries(tMembers.map((m) => [m.name, m.id]));
    // every payer/share points at a target member
    for (const b of tBills) for (const x of [...b.payers, ...b.shares]) expect(Object.values(tIds)).toContain(x.memberId);

    // value conserved per person
    const netAfter = await netsByName(T.gid, tIds);
    for (const n of ["alice", "bob", "carol"]) expect(netAfter[n], n).toBe((netS[n] ?? 0) + (netT[n] ?? 0));

    // source: archived, empty, soft-deleted bill still there
    const src = (await call("GET", `/api/groups/${S.gid}`)).json;
    expect(src.group.archived).toBe(true);
    expect(src.bills).toEqual([]);
    expect(await dbGroupOfBill(deleted)).toMatchObject({ g: S.gid });
    expect((await dbGroupOfBill(deleted)).d).toEqual(expect.any(String));
    for (const id of [s1, s2, s3]) expect((await dbGroupOfBill(id)).g, id).toBe(T.gid);
    // source can't be written to, but can be unarchived and the deleted bill restored in place
    expect((await addBill(S.gid, { amount: 1, paidBy: S.ids.Alice, split: equal([S.ids.Alice]) })).status).toBe(409);
    expect((await call("PATCH", `/api/groups/${S.gid}`, { archived: false })).status).toBe(200);
    const restored = await call("POST", `/api/groups/${S.gid}/bills/${deleted}/restore`, {});
    expect(restored.status).toBe(200);
    expect((await getBills(S.gid)).map((b) => b.id)).toEqual([deleted]);

    // comments travelled
    expect((await call("GET", cPath(T.gid, s1))).json.comments.map((c: any) => c.body)).toEqual(["carried over"]);
  });

  it("stops the source's recurring bills (active=0, lastError 'group merged') and clears recurrenceId on moved bills", async () => {
    const S = await makeGroup(["Alice", "Bob", "Carol"]);
    const T = await makeGroup(["Alice", "Bob", "Carol"]);
    const rec = await call("POST", `/api/groups/${S.gid}/recurring`, {
      frequency: "weekly", startDate: daysAgo(1), bill: { description: "Rent", amount: 600, paidBy: S.ids.Alice, split: equal([S.ids.Alice, S.ids.Bob]) },
    });
    expect(rec.status, rec.text).toBe(201);
    expect(rec.json.created).toBe(1);
    const rec2 = await call("POST", `/api/groups/${S.gid}/recurring`, {
      frequency: "monthly", startDate: daysAgo(1), bill: { description: "Net", amount: 100, paidBy: S.ids.Bob, split: equal([S.ids.Bob]) },
    });
    expect(rec2.status).toBe(201);
    // a recurrence that was already stopped keeps its own state
    const stopped = rec2.json.recurring.id as string;
    expect((await call("DELETE", `/api/groups/${S.gid}/recurring/${stopped}`)).status).toBe(204);
    const stoppedBefore = await env.DB.prepare("SELECT active, last_error FROM recurrences WHERE id = ?").bind(stopped).first<any>();

    const r = await merge(T.gid, S.gid);
    expect(r.status, r.text).toBe(200);
    expect(r.json.moved).toBe(2);
    const rows = (await env.DB.prepare("SELECT id, active, last_error FROM recurrences WHERE group_id = ?").bind(S.gid).all<any>()).results;
    expect(rows).toHaveLength(2);
    const live = rows.find((x) => x.id === rec.json.recurring.id);
    expect(live).toMatchObject({ active: 0, last_error: "group merged" });
    expect(rows.find((x) => x.id === stopped)).toMatchObject({ active: stoppedBefore.active, last_error: stoppedBefore.last_error });
    for (const b of await getBills(T.gid)) expect(b.recurrenceId, b.description).toBeNull();
    // the source no longer produces bills (even if made due and unarchived)
    await env.DB.prepare("UPDATE recurrences SET next_date = ? WHERE group_id = ?").bind(daysAgo(30), S.gid).run();
    await call("PATCH", `/api/groups/${S.gid}`, { archived: false });
    expect(await getBills(S.gid)).toEqual([]);
    const r2 = await call("GET", `/api/groups/${S.gid}/recurring`);
    expect(r2.json.recurring.every((x: any) => x.active === false)).toBe(true);
  });

  it("activity: bill.moveOut/moveIn per bill, group.merge in the target, group.archive in the source", async () => {
    const S = await makeGroup(["Alice", "Bob", "Carol"], "USD", "Old Trip");
    const T = await makeGroup(["Alice", "Bob", "Carol"], "USD", "New Trip");
    await simpleBill(S.gid, S.ids);
    await simpleBill(S.gid, S.ids);
    expect((await merge(T.gid, S.gid)).status).toBe(200);
    const sa = (await activity(S.gid)).map((a) => a.action);
    const ta = await activity(T.gid);
    expect(sa.filter((a) => a === "bill.moveOut")).toHaveLength(2);
    expect(sa).toContain("group.archive");
    expect(ta.filter((a) => a.action === "bill.moveIn")).toHaveLength(2);
    expect(ta.find((a) => a.action === "group.merge")).toMatchObject({ detail: { from: "Old Trip", bills: 2 } });
  });

  it("empty source, already-archived source: merge works (moved 0 / still archived)", async () => {
    const S = await makeGroup();
    const T = await makeGroup();
    const r = await merge(T.gid, S.gid);
    expect(r.json).toEqual({ moved: 0, addedMembers: [], sourceArchived: true });
    const S2 = await makeGroup(["Alice", "Bob", "Carol"]);
    await simpleBill(S2.gid, S2.ids);
    await call("PATCH", `/api/groups/${S2.gid}`, { archived: true });
    const r2 = await merge(T.gid, S2.gid);
    expect(r2.status, r2.text).toBe(200);
    expect(r2.json.moved).toBe(1);
    expect((await call("GET", `/api/groups/${S2.gid}`)).json.group.archived).toBe(true);
  });

  it("validation: same group / currency mismatch / unknown or malformed source / archived target / member cap", async () => {
    const T = await makeGroup(["Alice", "Bob", "Carol"], "USD");
    const THB = await makeGroup(["Alice"], "THB");
    expect((await merge(T.gid, T.gid)).status).toBe(400);
    expect((await merge(T.gid, THB.gid)).status).toBe(400);
    expect((await merge(T.gid, RAND_GID)).status).toBe(404);
    for (const s of ["x", "A".repeat(23), 3, null, undefined]) expect((await call("POST", mergePath(T.gid), { sourceGroupId: s })).status, String(s)).toBe(400);
    expect((await call("POST", mergePath(T.gid), { sourceGroupId: THB.gid, addMissingMembers: "yes" })).status).toBe(400);
    expect((await call("POST", mergePath(RAND_GID), { sourceGroupId: T.gid })).status).toBe(404);
    // an archived target refuses
    const S = await makeGroup(["Alice", "Bob", "Carol"]);
    await simpleBill(S.gid, S.ids);
    await call("PATCH", `/api/groups/${T.gid}`, { archived: true });
    const a = await merge(T.gid, S.gid);
    expect(a.status).toBe(409);
    expect(a.json.error.code).toBe("archived");
    expect((await getBills(S.gid))).toHaveLength(1);
    // member cap
    const Full = await makeGroup(Array.from({ length: 50 }, (_, i) => `F${i}`));
    const r = await merge(Full.gid, S.gid, true);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("conflict");
    expect((await call("GET", `/api/groups/${S.gid}`)).json.group.archived).toBe(false);
  });

  it("subgroups and view links of the source stay with the source", async () => {
    const S = await makeGroup();
    const T = await makeGroup();
    await simpleBill(S.gid, S.ids);
    await call("POST", `/api/groups/${S.gid}/subgroups`, { name: "S", memberIds: [S.ids.Alice] });
    const vid = (await call("POST", `/api/groups/${S.gid}/view-link`, {})).json.viewId;
    expect((await merge(T.gid, S.gid)).status).toBe(200);
    expect((await call("GET", `/api/groups/${S.gid}/subgroups`)).json.subgroups).toHaveLength(1);
    expect((await call("GET", `/api/groups/${T.gid}/subgroups`)).json.subgroups).toHaveLength(0);
    const v = await call("GET", `/api/view/${vid}`);
    expect(v.status).toBe(200);
    expect(v.json.group.archived).toBe(true);
    expect(v.json.bills).toEqual([]);
  });
});

// ============================================================================

describe("backup covers v3 tables", () => {
  async function gunzipJson(key: string) {
    const obj = await env.BACKUPS.get(key);
    expect(obj, key).not.toBeNull();
    const buf = await obj!.arrayBuffer();
    const text = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    return JSON.parse(text);
  }

  it("lists bill_comments and subgroups after their parents, and dumps their rows (and view_id)", async () => {
    expect(BACKUP_TABLES).toContain("bill_comments");
    expect(BACKUP_TABLES).toContain("subgroups");
    expect(BACKUP_TABLES.indexOf("bill_comments")).toBeGreaterThan(BACKUP_TABLES.indexOf("bills"));
    expect(BACKUP_TABLES.indexOf("bill_comments")).toBeGreaterThan(BACKUP_TABLES.indexOf("members"));
    expect(BACKUP_TABLES.indexOf("subgroups")).toBeGreaterThan(BACKUP_TABLES.indexOf("groups"));

    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    const cid = (await postComment(gid, bid, "backed up", ids.Bob)).json.comment.id;
    const sid = (await call("POST", `/api/groups/${gid}/subgroups`, { name: "Duo", memberIds: [ids.Alice, ids.Bob] })).json.subgroup.id;
    const vid = (await call("POST", `/api/groups/${gid}/view-link`, {})).json.viewId;

    const { key, rows } = await runBackup(env, new Date());
    const file = await gunzipJson(key);
    expect(Object.keys(file.tables)).toEqual([...BACKUP_TABLES]);
    const total = Object.values<any[]>(file.tables).reduce((a, l) => a + l.length, 0);
    expect(rows).toBe(total);

    const comment = file.tables.bill_comments.find((c: any) => c.id === cid);
    expect(comment).toMatchObject({ bill_id: bid, group_id: gid, author_member_id: ids.Alice, body: "backed up" });
    const sg = file.tables.subgroups.find((s: any) => s.id === sid);
    expect(sg).toMatchObject({ group_id: gid, name: "Duo" });
    expect(JSON.parse(sg.member_ids)).toEqual([ids.Alice, ids.Bob]);
    expect(file.tables.groups.find((g: any) => g.id === gid).view_id).toBe(vid);
    for (const t of ["bill_comments", "subgroups"]) {
      const n = await env.DB.prepare(`SELECT COUNT(*) n FROM ${t}`).first<{ n: number }>();
      expect(file.tables[t].length, t).toBe(n!.n);
    }
  });
});
