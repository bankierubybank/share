import { exports } from "cloudflare:workers";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BACKUP_TABLES, runBackup } from "../../src/backup";
import { scheduledMaintenance, VERSION } from "../../src/routes";

// v2 features: archive, delete group, PromptPay, soft delete/restore, activity, split modes, multi-payer, fx,
// categories, receipts, recurring bills, nightly backup and maintenance.

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

const restore = (gid: string, bid: string) => call("POST", `/api/groups/${gid}/bills/${bid}/restore`, {});

/** Raw-bytes request (receipts). */
async function raw(method: string, path: string, body?: Uint8Array, contentType?: string) {
  const res = await exports.default.fetch(
    new Request(`http://example.com${path}`, {
      method,
      headers: contentType ? { "Content-Type": contentType } : {},
      body: body as BodyInit | undefined,
    }),
  );
  const bytes = new Uint8Array(await res.arrayBuffer());
  let json: any;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    /* binary */
  }
  return { status: res.status, headers: res.headers, bytes, json };
}

const DATE = "2026-01-15";
const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => isoDay(new Date(Date.now() - n * DAY));

async function makeGroup(names = ["Alice", "Bob", "Carol"], currency = "USD") {
  const r = await call("POST", "/api/groups", { name: "Trip", currency, members: names });
  expect(r.status).toBe(201);
  const ids: Record<string, string> = {};
  for (const m of r.json.members) ids[m.name] = m.id;
  return { gid: r.json.group.id as string, ids };
}

const equal = (members: string[]) => ({ mode: "equal", members });

async function addBill(gid: string, body: Record<string, unknown>) {
  return call("POST", `/api/groups/${gid}/bills`, { description: "Thing", date: DATE, ...body });
}

/** Creates an equal bill and returns its id. */
async function simpleBill(gid: string, ids: Record<string, string>, extra: Record<string, unknown> = {}) {
  const r = await addBill(gid, { amount: 900, paidBy: ids.Alice, split: equal([ids.Alice, ids.Bob, ids.Carol]), ...extra });
  expect(r.status, r.text).toBe(201);
  return r.json.bill.id as string;
}

const shareMap = (b: { shares: { memberId: string; amount: number }[] }) => Object.fromEntries(b.shares.map((s) => [s.memberId, s.amount]));

async function activity(gid: string, query = "") {
  const r = await call("GET", `/api/groups/${gid}/activity${query}`);
  expect(r.status, r.text).toBe(200);
  return r.json.activity as { id: string; at: string; actor: string | null; action: string; entityId: string | null; detail: any; restorable: boolean }[];
}

// ---- tiny image buffers with correct magic bytes ----
const pad = (head: number[], total: number) => {
  const b = new Uint8Array(total);
  b.set(head);
  return b;
};
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...ascii("JFIF")], 32);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii("IHDR")], 40);
const WEBP = pad([...ascii("RIFF"), 24, 0, 0, 0, ...ascii("WEBP"), ...ascii("VP8 ")], 32);

const receiptPath = (gid: string, bid: string) => `/api/groups/${gid}/bills/${bid}/receipt`;
const receiptCount = async (gid: string) => (await env.RECEIPTS.list({ prefix: `${gid}/` })).objects.length;

// ============================================================================

describe("health and identity", () => {
  it("reports the app version", async () => {
    const r = await call("GET", "/api/health");
    expect(r.json).toEqual({ ok: true, version: VERSION });
  });

  it("/api/me (dev identity): default without header, email (lowercased) from header, null for junk; unverified JWTs ignored", async () => {
    expect((await call("GET", "/api/me")).json).toEqual({ actor: "dev@example.com" });
    expect((await call("GET", "/api/me", undefined, { "Cf-Access-Authenticated-User-Email": "Alice@Example.COM" })).json).toEqual({
      actor: "alice@example.com",
    });
    expect((await call("GET", "/api/me", undefined, { "Cf-Access-Authenticated-User-Email": "<b>x</b>" })).json).toEqual({ actor: null });
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const jwt = (payload: unknown) => `${b64({ alg: "none" })}.${b64(payload)}.sig`;
    expect((await call("GET", "/api/me", undefined, { "Cf-Access-Jwt-Assertion": jwt({ email: "Bob@X.io" }) })).json).toEqual({ actor: "dev@example.com" });
  });
});

describe("archive / unarchive", () => {
  it("archived flag defaults false, PATCH archived:true then false round-trips", async () => {
    const { gid } = await makeGroup();
    expect((await call("GET", `/api/groups/${gid}`)).json.group.archived).toBe(false);
    const a = await call("PATCH", `/api/groups/${gid}`, { archived: true });
    expect(a.status).toBe(200);
    expect(a.json.group.archived).toBe(true);
    expect((await call("GET", `/api/groups/${gid}`)).json.group.archived).toBe(true);
    const u = await call("PATCH", `/api/groups/${gid}`, { archived: false });
    expect(u.status).toBe(200);
    expect(u.json.group.archived).toBe(false);
  });

  it("rejects non-boolean archived", async () => {
    const { gid } = await makeGroup();
    for (const archived of ["true", 1, null, {}]) expect((await call("PATCH", `/api/groups/${gid}`, { archived })).status, String(archived)).toBe(400);
  });

  it("all writes are 409 archived while archived; reads still work; unarchive restores writes", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    expect((await raw("PUT", receiptPath(gid, bid), JPEG, "image/jpeg")).status).toBe(201);
    const rec = await call("POST", `/api/groups/${gid}/recurring`, {
      frequency: "monthly",
      startDate: isoDay(new Date(Date.now() + 10 * DAY)),
      bill: { description: "Rent", amount: 100, paidBy: ids.Alice, split: equal([ids.Alice]) },
    });
    expect(rec.status).toBe(201);
    const rid = rec.json.recurring.id;
    const dead = await simpleBill(gid, ids);
    expect((await call("DELETE", `/api/groups/${gid}/bills/${dead}`)).status).toBe(204);

    expect((await call("PATCH", `/api/groups/${gid}`, { archived: true })).status).toBe(200);

    const body = { description: "X", date: DATE, amount: 100, paidBy: ids.Alice, split: equal([ids.Alice]) };
    const writes: [string, string, unknown?][] = [
      ["POST", `/api/groups/${gid}/members`, { name: "Dave" }],
      ["PATCH", `/api/groups/${gid}/members/${ids.Bob}`, { name: "Robert" }],
      ["PATCH", `/api/groups/${gid}/members/${ids.Bob}`, { promptpay: "0812345678" }],
      ["DELETE", `/api/groups/${gid}/members/${ids.Carol}`],
      ["POST", `/api/groups/${gid}/bills`, body],
      ["PUT", `/api/groups/${gid}/bills/${bid}`, body],
      ["DELETE", `/api/groups/${gid}/bills/${bid}`],
      ["POST", `/api/groups/${gid}/bills/${dead}/restore`, {}],
      ["DELETE", receiptPath(gid, bid)],
      ["POST", `/api/groups/${gid}/recurring`, { frequency: "weekly", startDate: DATE, bill: body }],
      ["DELETE", `/api/groups/${gid}/recurring/${rid}`],
      ["PATCH", `/api/groups/${gid}`, { name: "Renamed" }],
      ["PATCH", `/api/groups/${gid}`, { currency: "EUR" }],
      ["PATCH", `/api/groups/${gid}`, { name: "Renamed", archived: true }],
    ];
    for (const [m, p, b] of writes) {
      const r = await call(m, p, b);
      expect(r.status, `${m} ${p}`).toBe(409);
      expect(r.json.error.code).toBe("archived");
    }
    const put = await raw("PUT", receiptPath(gid, bid), PNG, "image/png");
    expect(put.status).toBe(409);
    expect(put.json.error.code).toBe("archived");

    // reads unaffected
    for (const p of ["", "/summary", "/activity", "/recurring"]) expect((await call("GET", `/api/groups/${gid}${p}`)).status, p).toBe(200);
    expect((await raw("GET", receiptPath(gid, bid))).status).toBe(200);
    // nothing changed
    const g = await call("GET", `/api/groups/${gid}`);
    expect(g.json.group.name).toBe("Trip");
    expect(g.json.members).toHaveLength(3);
    expect(g.json.bills).toHaveLength(1);

    // unarchive + rename in one PATCH is allowed
    const un = await call("PATCH", `/api/groups/${gid}`, { archived: false, name: "Back" });
    expect(un.status).toBe(200);
    expect(un.json.group).toMatchObject({ archived: false, name: "Back" });
    expect((await call("POST", `/api/groups/${gid}/members`, { name: "Dave" })).status).toBe(201);
  });

  it("archive and unarchive are logged; repeating archive is a no-op log-wise", async () => {
    const { gid } = await makeGroup();
    await call("PATCH", `/api/groups/${gid}`, { archived: true });
    await call("PATCH", `/api/groups/${gid}`, { archived: true });
    await call("PATCH", `/api/groups/${gid}`, { archived: false });
    const acts = (await activity(gid)).map((a) => a.action);
    expect(acts.filter((a) => a === "group.archive")).toHaveLength(1);
    expect(acts.filter((a) => a === "group.unarchive")).toHaveLength(1);
  });

  it("archived groups do not materialize recurring bills until unarchived", async () => {
    const { gid, ids } = await makeGroup();
    const rec = await call("POST", `/api/groups/${gid}/recurring`, {
      frequency: "weekly",
      startDate: isoDay(new Date(Date.now() + 3 * DAY)),
      bill: { description: "Rent", amount: 100, paidBy: ids.Alice, split: equal([ids.Alice]) },
    });
    expect(rec.json.created).toBe(0);
    await call("PATCH", `/api/groups/${gid}`, { archived: true });
    await env.DB.prepare("UPDATE recurrences SET next_date = ? WHERE id = ?").bind(daysAgo(0), rec.json.recurring.id).run();
    expect((await call("GET", `/api/groups/${gid}`)).json.bills).toHaveLength(0);
    expect((await call("GET", `/api/groups/${gid}/summary`)).json.total).toBe(0);
    await scheduledMaintenance(env);
    expect((await call("GET", `/api/groups/${gid}`)).json.bills).toHaveLength(0);
    await call("PATCH", `/api/groups/${gid}`, { archived: false });
    expect((await call("GET", `/api/groups/${gid}`)).json.bills).toHaveLength(1);
  });
});

describe("delete group", () => {
  it("forever: 204 then 404 everywhere; second delete 404", async () => {
    const { gid } = await makeGroup();
    expect((await call("DELETE", `/api/groups/${gid}?forever=1`)).status).toBe(204);
    for (const p of ["", "/summary", "/activity", "/recurring"]) expect((await call("GET", `/api/groups/${gid}${p}`)).status, p).toBe(404);
    expect((await call("DELETE", `/api/groups/${gid}?forever=1`)).status).toBe(404);
  });

  it("removes receipts from R2 and cascades every child row", async () => {
    const { gid, ids } = await makeGroup();
    const b1 = await simpleBill(gid, ids);
    const b2 = await simpleBill(gid, ids);
    const b3 = await simpleBill(gid, ids);
    await raw("PUT", receiptPath(gid, b1), JPEG, "image/jpeg");
    await raw("PUT", receiptPath(gid, b2), PNG, "image/png");
    await raw("PUT", receiptPath(gid, b3), WEBP, "image/webp");
    await call("DELETE", `/api/groups/${gid}/bills/${b3}`); // soft-deleted bill's receipt must go too
    await call("POST", `/api/groups/${gid}/recurring`, {
      frequency: "weekly",
      startDate: daysAgo(8),
      bill: { description: "R", amount: 100, paidBy: ids.Alice, split: equal([ids.Alice]) },
    });
    expect(await receiptCount(gid)).toBe(3);

    expect((await call("DELETE", `/api/groups/${gid}?forever=1`)).status).toBe(204);
    expect(await receiptCount(gid)).toBe(0);
    for (const t of ["members", "bills", "activity", "recurrences"]) {
      const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE group_id = ?`).bind(gid).first<{ n: number }>();
      expect(r!.n, t).toBe(0);
    }
    const orphans = await env.DB.prepare("SELECT COUNT(*) AS n FROM bill_shares WHERE bill_id IN (?, ?, ?)").bind(b1, b2, b3).first<{ n: number }>();
    expect(orphans!.n).toBe(0);
    const payers = await env.DB.prepare("SELECT COUNT(*) AS n FROM bill_payers WHERE bill_id IN (?, ?, ?)").bind(b1, b2, b3).first<{ n: number }>();
    expect(payers!.n).toBe(0);
  });

  it("does not touch other groups", async () => {
    const a = await makeGroup();
    const b = await makeGroup();
    const bid = await simpleBill(b.gid, b.ids);
    await raw("PUT", receiptPath(b.gid, bid), JPEG, "image/jpeg");
    await call("DELETE", `/api/groups/${a.gid}`);
    expect((await call("GET", `/api/groups/${b.gid}`)).json.bills).toHaveLength(1);
    expect(await receiptCount(b.gid)).toBe(1);
  });

  it("an archived group can be deleted", async () => {
    const { gid } = await makeGroup();
    await call("PATCH", `/api/groups/${gid}`, { archived: true });
    expect((await call("DELETE", `/api/groups/${gid}`)).status).toBe(204);
  });
});

describe("members: PromptPay", () => {
  it("sets and normalizes on create and patch", async () => {
    const { gid } = await makeGroup();
    const cases: [string, string][] = [
      ["081-234-5678", "0812345678"],
      ["081 234 5678", "0812345678"],
      ["+66812345678", "0812345678"],
      ["66812345678", "0812345678"],
      ["1234567890123", "1234567890123"],
      ["123456789012345", "123456789012345"],
    ];
    for (const [i, [input, out]] of cases.entries()) {
      const add = await call("POST", `/api/groups/${gid}/members`, { name: `member${i}`, promptpay: input });
      expect(add.status, input).toBe(201);
      expect(add.json.member.promptpay, input).toBe(out);
    }
    const { json } = await call("GET", `/api/groups/${gid}`);
    expect(json.members.filter((m: any) => m.promptpay)).toHaveLength(cases.length);
    const mid = json.members.find((m: any) => m.name === "Alice").id;
    const p = await call("PATCH", `/api/groups/${gid}/members/${mid}`, { promptpay: "0899999999" });
    expect(p.json.member).toEqual({ id: mid, name: "Alice", promptpay: "0899999999", email: "dev@example.com" }); // Alice = creator
  });

  it("clears with null or empty string; omitting leaves it alone", async () => {
    const { gid, ids } = await makeGroup();
    const url = `/api/groups/${gid}/members/${ids.Alice}`;
    await call("PATCH", url, { promptpay: "0812345678" });
    expect((await call("PATCH", url, { name: "Alice2" })).json.member.promptpay).toBe("0812345678");
    expect((await call("PATCH", url, { promptpay: null })).json.member.promptpay).toBeNull();
    await call("PATCH", url, { promptpay: "0812345678" });
    expect((await call("PATCH", url, { promptpay: "" })).json.member.promptpay).toBeNull();
    expect((await call("GET", `/api/groups/${gid}`)).json.members.find((m: any) => m.id === ids.Alice).promptpay).toBeNull();
  });

  it("400 for letters, wrong lengths, non-strings; nothing changes", async () => {
    const { gid, ids } = await makeGroup();
    const url = `/api/groups/${gid}/members/${ids.Alice}`;
    for (const promptpay of ["08123abcd9", "abc", "081234567", "08123456789", "1234567890", "081234567890", "12345678901234", 812345678, true, {}, ["0812345678"]]) {
      const r = await call("PATCH", url, { promptpay });
      expect(r.status, JSON.stringify(promptpay)).toBe(400);
      expect(r.json.error.code).toBe("validation");
    }
    const bad = await call("POST", `/api/groups/${gid}/members`, { name: "Dave", promptpay: "nope" });
    expect(bad.status).toBe(400);
    expect((await call("GET", `/api/groups/${gid}`)).json.members).toHaveLength(3);
  });

  it("PATCH needs at least one field; logs member.promptpay only on change", async () => {
    const { gid, ids } = await makeGroup();
    const url = `/api/groups/${gid}/members/${ids.Alice}`;
    expect((await call("PATCH", url, {})).status).toBe(400);
    await call("PATCH", url, { promptpay: "0812345678" });
    await call("PATCH", url, { promptpay: "081-234-5678" }); // same after normalizing
    await call("PATCH", url, { promptpay: null });
    const pp = (await activity(gid)).filter((a) => a.action === "member.promptpay");
    expect(pp.map((a) => a.detail.set).sort()).toEqual([false, true]);
    // the PromptPay number itself must not be written to the log
    expect(JSON.stringify(pp)).not.toContain("0812345678");
  });
});

describe("soft delete, restore, restorable flag", () => {
  it("delete hides the bill from group + summary; restore brings it back identically", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids, { amount: 900, category: "food" });
    const before = (await call("GET", `/api/groups/${gid}`)).json.bills[0];

    expect((await call("DELETE", `/api/groups/${gid}/bills/${bid}`)).status).toBe(204);
    expect((await call("GET", `/api/groups/${gid}`)).json.bills).toEqual([]);
    const s = (await call("GET", `/api/groups/${gid}/summary`)).json;
    expect(s.total).toBe(0);
    expect(s.settlements).toEqual([]);
    expect(s.byCategory).toEqual({});

    const r = await restore(gid, bid);
    expect(r.status).toBe(200);
    expect(r.json.bill).toEqual(before);
    expect((await call("GET", `/api/groups/${gid}`)).json.bills).toEqual([before]);
    expect((await call("GET", `/api/groups/${gid}/summary`)).json.total).toBe(900);
  });

  it("restore needs a JSON POST (CSRF guard); bodyless/form POST is rejected with 415", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    await call("DELETE", `/api/groups/${gid}/bills/${bid}`);
    expect((await raw("POST", `/api/groups/${gid}/bills/${bid}/restore`)).status).toBe(415);
    const r = await call("POST", `/api/groups/${gid}/bills/${bid}/restore`, {}); // what web/src/api.ts sends
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.bill.id).toBe(bid);
  });

  it("restorable is true only while the bill is in the bin", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    await call("DELETE", `/api/groups/${gid}/bills/${bid}`);
    let del = (await activity(gid)).find((a) => a.action === "bill.delete")!;
    expect(del).toMatchObject({ entityId: bid, restorable: true });
    expect(del.detail).toMatchObject({ description: "Thing", amount: 900, kind: "expense" });
    for (const a of await activity(gid)) if (a.action !== "bill.delete") expect(a.restorable, a.action).toBe(false);

    await restore(gid, bid);
    const acts = await activity(gid);
    del = acts.find((a) => a.action === "bill.delete")!;
    expect(del.restorable).toBe(false);
    expect(acts.some((a) => a.action === "bill.restore" && a.entityId === bid)).toBe(true);
  });

  it("restore 404s: live bill, already restored, unknown, malformed, other group", async () => {
    const a = await makeGroup();
    const b = await makeGroup();
    const bid = await simpleBill(a.gid, a.ids);
    expect((await restore(a.gid, bid)).status).toBe(404); // not deleted
    await call("DELETE", `/api/groups/${a.gid}/bills/${bid}`);
    expect((await restore(b.gid, bid)).status).toBe(404); // IDOR
    expect((await restore(a.gid, "AAAAAAAAAAAAAAAA")).status).toBe(404);
    expect((await restore(a.gid, "x")).status).toBe(404);
    expect((await restore(a.gid, bid)).status).toBe(200);
    expect((await restore(a.gid, bid)).status).toBe(404);
  });

  it("deleted bills cannot be edited, re-deleted or receive receipts; second delete 404", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    await call("DELETE", `/api/groups/${gid}/bills/${bid}`);
    expect((await call("DELETE", `/api/groups/${gid}/bills/${bid}`)).status).toBe(404);
    const put = await call("PUT", `/api/groups/${gid}/bills/${bid}`, { description: "x", date: DATE, amount: 1, paidBy: ids.Alice, split: equal([ids.Alice]) });
    expect(put.status).toBe(404);
    expect((await raw("PUT", receiptPath(gid, bid), JPEG, "image/jpeg")).status).toBe(404);
  });

  it("a soft-deleted bill no longer blocks member removal; restored bill does again", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    await call("DELETE", `/api/groups/${gid}/bills/${bid}`);
    expect((await call("DELETE", `/api/groups/${gid}/members/${ids.Bob}`)).status).toBe(204);
    // the bin entry that referenced Bob is purged with him -> cannot be restored any more
    expect((await restore(gid, bid)).status).toBe(404);
    expect((await activity(gid)).find((a) => a.action === "bill.delete")!.restorable).toBe(false);
  });

  it("removing a member purges their binned bills and those receipts", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    await raw("PUT", receiptPath(gid, bid), JPEG, "image/jpeg");
    expect(await receiptCount(gid)).toBe(1);
    await call("DELETE", `/api/groups/${gid}/bills/${bid}`);
    expect(await receiptCount(gid)).toBe(1); // still restorable
    expect((await call("DELETE", `/api/groups/${gid}/members/${ids.Carol}`)).status).toBe(204);
    expect(await receiptCount(gid)).toBe(0);
  });
});

describe("activity log", () => {
  it("records every action with actor from the Access email header", async () => {
    const who = { "Cf-Access-Authenticated-User-Email": "Ann@Corp.example" };
    const created = await call("POST", "/api/groups", { name: "Log", currency: "USD", members: ["A", "B"] }, who);
    const gid = created.json.group.id as string;
    const [A, B] = created.json.members.map((m: any) => m.id);
    const g = (m: string, p: string, b?: unknown) => call(m, `/api/groups/${gid}${p}`, b, who);
    // Header-less calls below (receipt upload, activity reads) act as the default dev identity: link it as B.
    await g("PATCH", `/members/${B}`, { email: "dev@example.com" });

    await g("PATCH", "", { name: "Log2", currency: "EUR" });
    const extra = (await g("POST", "/members", { name: "C" })).json.member.id;
    await g("PATCH", `/members/${extra}`, { name: "C2" });
    await g("PATCH", `/members/${extra}`, { promptpay: "0812345678" });
    const bill = (await g("POST", "/bills", { description: "D", date: DATE, amount: 500, paidBy: A, split: equal([A, B]) })).json.bill;
    await g("PUT", `/bills/${bill.id}`, { description: "D2", date: DATE, amount: 600, paidBy: A, split: equal([A, B]) });
    await raw("PUT", receiptPath(gid, bill.id), JPEG, "image/jpeg");
    await g("DELETE", `/bills/${bill.id}/receipt`);
    await g("DELETE", `/bills/${bill.id}`);
    await g("POST", `/bills/${bill.id}/restore`, {});
    const rec = (
      await g("POST", "/recurring", { frequency: "weekly", startDate: daysAgo(1), bill: { description: "R", amount: 100, paidBy: A, split: equal([A]) } })
    ).json.recurring;
    await g("DELETE", `/recurring/${rec.id}`);
    await g("DELETE", `/members/${extra}`);
    await g("PATCH", "", { archived: true });
    await g("PATCH", "", { archived: false });

    const acts = await activity(gid);
    const actions = new Set(acts.map((a) => a.action));
    for (const a of [
      "group.create", "group.rename", "group.currency", "group.archive", "group.unarchive",
      "member.add", "member.rename", "member.promptpay", "member.remove",
      "bill.create", "bill.update", "bill.delete", "bill.restore", "bill.recurring",
      "receipt.add", "receipt.remove", "recurring.create", "recurring.stop",
    ])
      expect(actions.has(a), a).toBe(true);
    // actor comes from the header on every entry (the receipt upload went without a header: default dev identity)
    for (const a of acts) {
      if (a.action === "receipt.add") expect(a.actor).toBe("dev@example.com");
      else if (a.action === "bill.recurring") expect(a.actor).toBe("recurring"); // system actor for materialized bills
      else expect(a.actor, a.action).toBe("ann@corp.example");
    }
    expect(acts.find((a) => a.action === "group.rename")!.detail).toEqual({ from: "Log", to: "Log2" });
    expect(acts.find((a) => a.action === "group.currency")!.detail).toEqual({ from: "USD", to: "EUR" });
    expect(acts.find((a) => a.action === "member.rename")!.detail).toEqual({ from: "C", to: "C2" });
    expect(acts.find((a) => a.action === "bill.update")!.detail).toMatchObject({ description: "D2", amount: 600 });
    expect(acts.find((a) => a.action === "bill.create")).toMatchObject({ entityId: bill.id });
    expect(acts.find((a) => a.action === "group.create")!.detail).toEqual({ name: "Log", members: 2 });
    // bills created through the API carry createdBy
    expect(bill.createdBy).toBe("ann@corp.example");
    // newest first
    const ats = acts.map((a) => a.at);
    expect([...ats].sort().reverse()).toEqual(ats);
    // every entry has the documented shape
    for (const a of acts) {
      expect(Object.keys(a).sort()).toEqual(["action", "actor", "at", "detail", "entityId", "id", "restorable"]);
      expect(a.at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      expect(typeof a.id).toBe("string");
      expect(typeof a.restorable).toBe("boolean");
    }
  });

  it("without headers the actor is the default dev identity (DEV_IDENTITY=1); bill.createdBy too", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    for (const a of await activity(gid)) expect(a.actor).toBe("dev@example.com");
    expect((await call("GET", `/api/groups/${gid}`)).json.bills.find((b: any) => b.id === bid).createdBy).toBe("dev@example.com");
  });

  it("limit is clamped to 1..100 and junk falls back to 50; before filters strictly older", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids); // group.create + bill.create so far
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let i = 0; i < 18; i++) await call("PUT", `/api/groups/${gid}/bills/${bid}`, { description: "x", date: DATE, amount: 100, paidBy: ids.Alice, split: equal([ids.Alice]) });
      }),
    ); // 108 updates -> 110 entries
    const n = async (q: string) => (await activity(gid, q)).length;
    expect(await n("")).toBe(50);
    expect(await n("?limit=10")).toBe(10);
    expect(await n("?limit=100")).toBe(100);
    expect(await n("?limit=100000")).toBe(100);
    expect(await n("?limit=-5")).toBe(1);
    expect(await n("?limit=0")).toBe(50);
    expect(await n("?limit=abc")).toBe(50);

    const future = "2999-01-01T00:00:00.000Z";
    const past = "2000-01-01T00:00:00.000Z";
    expect(await n(`?limit=100&before=${future}`)).toBe(100);
    expect(await n(`?before=${past}`)).toBe(0);
    const all = await activity(gid, "?limit=100");
    const oldest = all[all.length - 1].at;
    const older = await activity(gid, `?limit=100&before=${encodeURIComponent(oldest)}`);
    for (const a of older) expect(a.at < oldest).toBe(true);
  });

  it("paging with before=<last.at> visits every entry exactly once", async () => {
    const { gid, ids } = await makeGroup();
    for (let i = 0; i < 7; i++) await simpleBill(gid, ids);
    const all = await activity(gid, "?limit=100");
    expect(all).toHaveLength(8);
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 20; page++) {
      const items = await activity(gid, `?limit=3${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      if (!items.length) break;
      seen.push(...items.map((a) => a.id));
      before = items[items.length - 1].at;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(all.map((a) => a.id).sort());
  });

  it("fractional / exponent limits do not crash (limit=2.7 must not 500)", async () => {
    const { gid } = await makeGroup();
    for (const limit of ["2.7", "0.5", "1e2", "1e400", "%202", "0x10", "Infinity"]) {
      const r = await call("GET", `/api/groups/${gid}/activity?limit=${limit}`);
      expect(r.status, `limit=${limit}`).toBe(200);
      expect(r.json.activity.length).toBeGreaterThanOrEqual(1);
      expect(r.json.activity.length).toBeLessThanOrEqual(100);
    }
  });

  it("before rejects anything that is not an ISO timestamp", async () => {
    const { gid } = await makeGroup();
    for (const before of ["' OR 1=1--", "yesterday", "2026-01-01", "2026-01-01T00:00:00", "1; SELECT 1", "", "%27%20OR%201%3D1--"]) {
      const r = await call("GET", `/api/groups/${gid}/activity?before=${before}`);
      expect(r.status, before).toBe(400);
      expect(r.json.error.code).toBe("validation");
    }
  });

  it("is scoped to its group", async () => {
    const a = await makeGroup();
    const b = await makeGroup();
    await simpleBill(a.gid, a.ids);
    expect((await activity(b.gid)).map((x) => x.action)).toEqual(["group.create"]);
  });
});

describe("split modes", () => {
  it("shares: weights allocate with largest remainder; zero weight dropped; split normalized", async () => {
    const { gid, ids } = await makeGroup();
    const r = await addBill(gid, {
      amount: 1000,
      paidBy: ids.Alice,
      split: { mode: "shares", weights: [{ memberId: ids.Alice, weight: 2 }, { memberId: ids.Bob, weight: 1 }, { memberId: ids.Carol, weight: 0 }] },
    });
    expect(r.status, r.text).toBe(201);
    expect(r.json.bill.splitMode).toBe("shares");
    expect(shareMap(r.json.bill)).toEqual({ [ids.Alice]: 667, [ids.Bob]: 333 });
    expect(r.json.bill.split).toEqual({
      mode: "shares",
      weights: [{ memberId: ids.Alice, weight: 2 }, { memberId: ids.Bob, weight: 1 }, { memberId: ids.Carol, weight: 0 }],
    });
  });

  it("shares: validation", async () => {
    const { gid, ids } = await makeGroup();
    const w = (weights: unknown) => addBill(gid, { amount: 1000, paidBy: ids.Alice, split: { mode: "shares", weights } });
    expect((await w([{ memberId: ids.Alice, weight: 0 }])).status).toBe(400); // all zero
    expect((await w([{ memberId: ids.Alice, weight: -1 }])).status).toBe(400);
    expect((await w([{ memberId: ids.Alice, weight: 10001 }])).status).toBe(400);
    expect((await w([{ memberId: ids.Alice, weight: 1.5 }])).status).toBe(400);
    expect((await w([{ memberId: ids.Alice, weight: "2" }])).status).toBe(400);
    expect((await w([{ memberId: ids.Alice, weight: 1 }, { memberId: ids.Alice, weight: 1 }])).status).toBe(400);
    expect((await w([{ memberId: "nope", weight: 1 }])).status).toBe(400);
    expect((await w([])).status).toBe(400);
    expect((await w("x")).status).toBe(400);
    expect((await w([{ memberId: ids.Alice, weight: 10000 }, { memberId: ids.Bob, weight: 10000 }])).status).toBe(201); // max weight ok
  });

  it("percent: basis points, largest remainder, sum must be 10000", async () => {
    const { gid, ids } = await makeGroup();
    const pct = (percents: [string, number][]) => ({ mode: "percent", percents: percents.map(([memberId, bp]) => ({ memberId, bp })) });
    // 999 x 50% / 30% / 20% -> 499.5, 299.7, 199.8 -> floors 499/299/199, 2 left to the largest remainders (Carol .8, Bob .7)
    const ok = await addBill(gid, { amount: 999, paidBy: ids.Alice, split: pct([[ids.Alice, 5000], [ids.Bob, 3000], [ids.Carol, 2000]]) });
    expect(ok.status, ok.text).toBe(201);
    expect(shareMap(ok.json.bill)).toEqual({ [ids.Alice]: 499, [ids.Bob]: 300, [ids.Carol]: 200 });
    expect(ok.json.bill.splitMode).toBe("percent");
    // 3 x 33.33% on 100: 33/33/33 floors, 1 left, tie on remainder -> earliest entry
    const third = await addBill(gid, { amount: 100, paidBy: ids.Alice, split: pct([[ids.Bob, 3333], [ids.Carol, 3333], [ids.Alice, 3334]]) });
    expect(shareMap(third.json.bill)).toEqual({ [ids.Bob]: 33, [ids.Carol]: 33, [ids.Alice]: 34 });
    // 0% is dropped
    const zero = await addBill(gid, { amount: 100, paidBy: ids.Alice, split: pct([[ids.Alice, 10000], [ids.Bob, 0]]) });
    expect(shareMap(zero.json.bill)).toEqual({ [ids.Alice]: 100 });
    for (const bad of [
      pct([[ids.Alice, 5000]]),
      pct([[ids.Alice, 6000], [ids.Bob, 5000]]),
      pct([[ids.Alice, -1], [ids.Bob, 10001]]),
      pct([[ids.Alice, 10001]]),
      pct([[ids.Alice, 5000.5], [ids.Bob, 5000]]),
      pct([[ids.Alice, 5000], [ids.Alice, 5000]]),
    ]) {
      const r = await addBill(gid, { amount: 100, paidBy: ids.Alice, split: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("exact: zero shares dropped, sum enforced, normalized split kept", async () => {
    const { gid, ids } = await makeGroup();
    const r = await addBill(gid, {
      amount: 1000,
      paidBy: ids.Bob,
      split: { mode: "exact", shares: [{ memberId: ids.Alice, amount: 1000 }, { memberId: ids.Carol, amount: 0 }] },
    });
    expect(r.status, r.text).toBe(201);
    expect(shareMap(r.json.bill)).toEqual({ [ids.Alice]: 1000 });
    expect(r.json.bill.split).toMatchObject({ mode: "exact", shares: expect.arrayContaining([{ memberId: ids.Alice, amount: 1000 }]) });
    const over = await addBill(gid, { amount: 1000, paidBy: ids.Bob, split: { mode: "exact", shares: [{ memberId: ids.Alice, amount: 1001 }] } });
    expect(over.status).toBe(400);
  });

  it("equal: remainder to first in order; unknown mode 400; amount required", async () => {
    const { gid, ids } = await makeGroup();
    const r = await addBill(gid, { amount: 100, paidBy: ids.Alice, split: equal([ids.Carol, ids.Alice, ids.Bob]) });
    expect(shareMap(r.json.bill)).toEqual({ [ids.Carol]: 34, [ids.Alice]: 33, [ids.Bob]: 33 });
    expect(r.json.bill.split).toEqual({ mode: "equal", members: [ids.Carol, ids.Alice, ids.Bob] });
    expect((await addBill(gid, { amount: 100, paidBy: ids.Alice, split: { mode: "weird", members: [ids.Alice] } })).status).toBe(400);
    expect((await addBill(gid, { paidBy: ids.Alice, split: equal([ids.Alice]) })).status).toBe(400);
  });

  it("itemized: computed amount with service then tax; per-member subtotals scaled proportionally", async () => {
    const { gid, ids } = await makeGroup();
    // Pizza 2000 [Alice,Bob] -> 1000 each; Wine 1000 [Alice]. Subtotal 3000, +10% service +7% tax compounding:
    // 3000 * 1.10 * 1.07 = 3531. Alice 2000/3000, Bob 1000/3000 -> 2354 / 1177.
    const split = {
      mode: "itemized",
      serviceBp: 1000,
      taxBp: 700,
      items: [
        { description: "Pizza", amount: 2000, members: [ids.Alice, ids.Bob] },
        { description: "Wine", amount: 1000, members: [ids.Alice] },
      ],
    };
    const r = await addBill(gid, { paidBy: ids.Carol, split });
    expect(r.status, r.text).toBe(201);
    expect(r.json.bill.amount).toBe(3531);
    expect(r.json.bill.splitMode).toBe("itemized");
    expect(shareMap(r.json.bill)).toEqual({ [ids.Alice]: 2354, [ids.Bob]: 1177 });
    expect(r.json.bill.payers).toEqual([{ memberId: ids.Carol, amount: 3531 }]);
    expect(r.json.bill.split).toEqual(split);
    // matching amount accepted, mismatching rejected
    expect((await addBill(gid, { amount: 3531, paidBy: ids.Carol, split })).status).toBe(201);
    const bad = await addBill(gid, { amount: 3530, paidBy: ids.Carol, split });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain("3531");
  });

  it("itemized: service/tax default to 0, rounding half up, odd item split remainder to first", async () => {
    const { gid, ids } = await makeGroup();
    const none = await addBill(gid, {
      paidBy: ids.Alice,
      split: { mode: "itemized", items: [{ description: "Soup", amount: 1001, members: [ids.Alice, ids.Bob] }] },
    });
    expect(none.json.bill.amount).toBe(1001);
    expect(shareMap(none.json.bill)).toEqual({ [ids.Alice]: 501, [ids.Bob]: 500 });
    expect(none.json.bill.split).toMatchObject({ serviceBp: 0, taxBp: 0 });
    // 1005 * 1.07 = 1075.35 -> 1075 ; 1050 * 1.07 = 1123.5 -> 1124 (half up)
    const tax = (amount: number) =>
      addBill(gid, { paidBy: ids.Alice, split: { mode: "itemized", taxBp: 700, items: [{ description: "x", amount, members: [ids.Alice] }] } });
    expect((await tax(1005)).json.bill.amount).toBe(1075);
    expect((await tax(1050)).json.bill.amount).toBe(1124);
    const svc = await addBill(gid, {
      paidBy: ids.Alice,
      split: { mode: "itemized", serviceBp: 1000, items: [{ description: "x", amount: 1000, members: [ids.Bob] }] },
    });
    expect(svc.json.bill.amount).toBe(1100);
    expect(shareMap(svc.json.bill)).toEqual({ [ids.Bob]: 1100 });
  });

  it("itemized: validation (limits, members, bp ranges, fx combo)", async () => {
    const { gid, ids } = await makeGroup();
    const item = (o: Record<string, unknown> = {}) => ({ description: "i", amount: 100, members: [ids.Alice], ...o });
    const it_ = (split: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      addBill(gid, { paidBy: ids.Alice, split: { mode: "itemized", ...split }, ...extra });
    expect((await it_({ items: [] })).status).toBe(400);
    expect((await it_({})).status).toBe(400);
    expect((await it_({ items: [item({ members: [] })] })).status).toBe(400);
    expect((await it_({ items: [item({ members: ["nope"] })] })).status).toBe(400);
    expect((await it_({ items: [item({ members: [ids.Alice, ids.Alice] })] })).status).toBe(400);
    expect((await it_({ items: [item({ amount: 0 })] })).status).toBe(400);
    expect((await it_({ items: [item({ amount: 1.5 })] })).status).toBe(400);
    expect((await it_({ items: [item({ description: "" })] })).status).toBe(400);
    expect((await it_({ items: [item()], serviceBp: 10001 })).status).toBe(400);
    expect((await it_({ items: [item()], taxBp: -1 })).status).toBe(400);
    expect((await it_({ items: [item()], taxBp: 7.5 })).status).toBe(400);
    expect((await it_({ items: [item()], taxBp: "700" })).status).toBe(400);
    expect((await it_({ items: [item()], serviceBp: 10000, taxBp: 10000 })).status).toBe(201); // max
    expect((await it_({ items: Array.from({ length: 100 }, () => item({ amount: 1 })) })).status).toBe(201);
    expect((await it_({ items: Array.from({ length: 101 }, () => item({ amount: 1 })) })).status).toBe(400);
    expect((await it_({ items: [item()] }, { fx: { currency: "EUR", amount: 100, rate: "1.1" } })).status).toBe(400); // itemized + fx
  });

  it("changing the split mode via PUT replaces shares and the normalized split", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    const upd = await call("PUT", `/api/groups/${gid}/bills/${bid}`, {
      description: "Now weighted", date: DATE, amount: 900, paidBy: ids.Alice,
      split: { mode: "shares", weights: [{ memberId: ids.Alice, weight: 1 }, { memberId: ids.Bob, weight: 2 }] },
    });
    expect(upd.status, upd.text).toBe(200);
    expect(upd.json.bill.splitMode).toBe("shares");
    expect(shareMap(upd.json.bill)).toEqual({ [ids.Alice]: 300, [ids.Bob]: 600 });
    expect((await call("GET", `/api/groups/${gid}`)).json.bills[0].split.mode).toBe("shares");
  });
});

describe("multiple payers", () => {
  it("accepts payers summing to amount; paidBy is the first payer; display order", async () => {
    const { gid, ids } = await makeGroup();
    const r = await addBill(gid, {
      amount: 1000,
      payers: [{ memberId: ids.Carol, amount: 400 }, { memberId: ids.Alice, amount: 600 }],
      split: equal([ids.Alice, ids.Bob]),
    });
    expect(r.status, r.text).toBe(201);
    expect(r.json.bill.payers).toEqual([{ memberId: ids.Alice, amount: 600 }, { memberId: ids.Carol, amount: 400 }]);
    expect(r.json.bill.paidBy).toBe(ids.Alice);
    const s = (await call("GET", `/api/groups/${gid}/summary`)).json;
    const by = Object.fromEntries(s.balances.map((b: any) => [b.memberId, b]));
    expect(by[ids.Alice]).toEqual({ memberId: ids.Alice, paid: 600, owed: 500, net: 100 });
    expect(by[ids.Bob]).toEqual({ memberId: ids.Bob, paid: 0, owed: 500, net: -500 });
    expect(by[ids.Carol]).toEqual({ memberId: ids.Carol, paid: 400, owed: 0, net: 400 });
    expect(s.settlements).toEqual([
      { from: ids.Bob, to: expect.stringMatching(/./), amount: expect.any(Number) },
      { from: ids.Bob, to: expect.stringMatching(/./), amount: expect.any(Number) },
    ]);
    expect(s.settlements.reduce((a: number, x: any) => a + x.amount, 0)).toBe(500);
  });

  it("single paidBy yields a one-element payers array", async () => {
    const { gid, ids } = await makeGroup();
    const r = await addBill(gid, { amount: 500, paidBy: ids.Bob, split: equal([ids.Alice]) });
    expect(r.json.bill.payers).toEqual([{ memberId: ids.Bob, amount: 500 }]);
    expect(r.json.bill.paidBy).toBe(ids.Bob);
  });

  it("400: sum mismatch, duplicates, zero/negative, unknown, empty, neither paidBy nor payers", async () => {
    const { gid, ids } = await makeGroup();
    const p = (payers: unknown) => addBill(gid, { amount: 1000, payers, split: equal([ids.Alice]) });
    expect((await p([{ memberId: ids.Alice, amount: 999 }])).status).toBe(400);
    expect((await p([{ memberId: ids.Alice, amount: 1001 }])).status).toBe(400);
    expect((await p([{ memberId: ids.Alice, amount: 500 }, { memberId: ids.Alice, amount: 500 }])).status).toBe(400);
    expect((await p([{ memberId: ids.Alice, amount: 1000 }, { memberId: ids.Bob, amount: 0 }])).status).toBe(400);
    expect((await p([{ memberId: ids.Alice, amount: 1500 }, { memberId: ids.Bob, amount: -500 }])).status).toBe(400);
    expect((await p([{ memberId: "nope", amount: 1000 }])).status).toBe(400);
    expect((await p([])).status).toBe(400);
    expect((await addBill(gid, { amount: 1000, split: equal([ids.Alice]) })).status).toBe(400);
    expect((await addBill(gid, { amount: 1000, paidBy: "nope", split: equal([ids.Alice]) })).status).toBe(400);
  });

  it("PUT can switch single payer to multiple payers and back", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids, { amount: 900 });
    const put = (extra: Record<string, unknown>) =>
      call("PUT", `/api/groups/${gid}/bills/${bid}`, { description: "x", date: DATE, amount: 900, split: equal([ids.Alice, ids.Bob, ids.Carol]), ...extra });
    const multi = await put({ payers: [{ memberId: ids.Alice, amount: 400 }, { memberId: ids.Bob, amount: 500 }] });
    expect(multi.json.bill.payers).toHaveLength(2);
    const single = await put({ paidBy: ids.Carol });
    expect(single.json.bill.payers).toEqual([{ memberId: ids.Carol, amount: 900 }]);
  });

  it("payment must be single payer + equal single receiver, receiver != payer", async () => {
    const { gid, ids } = await makeGroup();
    const pay = (extra: Record<string, unknown>) =>
      addBill(gid, { kind: "payment", amount: 500, paidBy: ids.Alice, split: equal([ids.Bob]), ...extra });
    expect((await pay({})).status).toBe(201);
    expect((await pay({ split: equal([ids.Alice]) })).status).toBe(400);
    expect((await pay({ split: equal([ids.Bob, ids.Carol]) })).status).toBe(400);
    expect((await pay({ payers: [{ memberId: ids.Alice, amount: 250 }, { memberId: ids.Carol, amount: 250 }], paidBy: undefined })).status).toBe(400);
    expect((await pay({ split: { mode: "shares", weights: [{ memberId: ids.Bob, weight: 1 }] } })).status).toBe(400);
  });
});

describe("multi-currency (fx)", () => {
  it("converts fx.amount x rate into the group currency; stores and returns fx", async () => {
    const { gid, ids } = await makeGroup();
    // 10.00 EUR @ 1.10 = 11.00 USD
    const r = await addBill(gid, { paidBy: ids.Alice, fx: { currency: "EUR", amount: 1000, rate: "1.10" }, split: equal([ids.Alice, ids.Bob]) });
    expect(r.status, r.text).toBe(201);
    expect(r.json.bill.amount).toBe(1100);
    expect(r.json.bill.fx).toEqual({ currency: "EUR", amount: 1000, rate: "1.10" });
    expect(shareMap(r.json.bill)).toEqual({ [ids.Alice]: 550, [ids.Bob]: 550 });
    expect((await call("GET", `/api/groups/${gid}`)).json.bills[0].fx).toEqual({ currency: "EUR", amount: 1000, rate: "1.10" });
    const s = (await call("GET", `/api/groups/${gid}/summary`)).json;
    expect(s.total).toBe(1100);
  });

  it("rounds half up; handles zero-decimal currencies on either side", async () => {
    const { gid, ids } = await makeGroup();
    const fx = (f: Record<string, unknown>) => addBill(gid, { paidBy: ids.Alice, split: equal([ids.Alice]), fx: f });
    expect((await fx({ currency: "EUR", amount: 5, rate: "0.5" })).json.bill.amount).toBe(3); // 2.5 -> 3
    expect((await fx({ currency: "EUR", amount: 1001, rate: "1.005" })).json.bill.amount).toBe(1006); // 1006.005 -> 1006
    expect((await fx({ currency: "JPY", amount: 5000, rate: "0.0067" })).json.bill.amount).toBe(3350); // JPY 5000 = 33.50 USD
    const jp = await makeGroup(["A", "B"], "JPY");
    const r = await addBill(jp.gid, { paidBy: jp.ids.A, split: equal([jp.ids.A, jp.ids.B]), fx: { currency: "USD", amount: 1000, rate: "150.5" } });
    expect(r.json.bill.amount).toBe(1505); // USD 10.00 = JPY 1505 (zero-decimal group)
  });

  it("amount, if sent, must match; fx.currency must differ from group; rate/amount validated", async () => {
    const { gid, ids } = await makeGroup();
    const base = { paidBy: ids.Alice, split: equal([ids.Alice]) };
    const fx = { currency: "EUR", amount: 1000, rate: "1.10" };
    expect((await addBill(gid, { ...base, amount: 1100, fx })).status).toBe(201);
    expect((await addBill(gid, { ...base, amount: 1000, fx })).status).toBe(400);
    expect((await addBill(gid, { ...base, fx: { ...fx, currency: "USD" } })).status).toBe(400);
    for (const rate of ["1e9", "NaN", "-1", "0", "0.0", "0.000000001", "1234567890", "abc", "1,5", "", " 1", 1.1, null, 0]) {
      const r = await addBill(gid, { ...base, fx: { ...fx, rate } });
      expect(r.status, JSON.stringify(rate)).toBe(400);
    }
    for (const amount of [0, -1, 1.5, "10", null, 100_000_000_001]) expect((await addBill(gid, { ...base, fx: { ...fx, amount } })).status, String(amount)).toBe(400);
    for (const currency of ["eur", "EU", "EURO", 5, null]) expect((await addBill(gid, { ...base, fx: { ...fx, currency } })).status, String(currency)).toBe(400);
    expect((await addBill(gid, { ...base, fx: "EUR" })).status).toBe(400);
    expect((await addBill(gid, { ...base, amount: 100, fx: null })).status).toBe(201); // null fx = no fx
  });

  it("PUT without fx clears it; PUT with fx adds it", async () => {
    const { gid, ids } = await makeGroup();
    const created = await addBill(gid, { paidBy: ids.Alice, split: equal([ids.Alice]), fx: { currency: "EUR", amount: 1000, rate: "1.10" } });
    const bid = created.json.bill.id;
    const put = (extra: Record<string, unknown>) =>
      call("PUT", `/api/groups/${gid}/bills/${bid}`, { description: "x", date: DATE, paidBy: ids.Alice, split: equal([ids.Alice]), ...extra });
    const cleared = await put({ amount: 700 });
    expect(cleared.json.bill.fx).toBeNull();
    expect(cleared.json.bill.amount).toBe(700);
    const added = await put({ fx: { currency: "GBP", amount: 1000, rate: "1.25" } });
    expect(added.json.bill).toMatchObject({ amount: 1250, fx: { currency: "GBP", amount: 1000, rate: "1.25" } });
  });
});

describe("categories and summary.byCategory", () => {
  it("defaults to other, validates, sums expenses by category, excludes payments", async () => {
    const { gid, ids } = await makeGroup();
    const one = (amount: number, category?: string, extra: Record<string, unknown> = {}) =>
      addBill(gid, { amount, paidBy: ids.Alice, split: equal([ids.Alice, ids.Bob]), ...(category !== undefined ? { category } : {}), ...extra });
    expect((await one(100)).json.bill.category).toBe("other");
    await one(1000, "food");
    await one(250, "food");
    await one(4000, "lodging");
    await one(700, "transport");
    const pay = await addBill(gid, { kind: "payment", amount: 999, category: "food", paidBy: ids.Bob, split: equal([ids.Alice]) });
    expect(pay.status).toBe(201);
    for (const cat of ["Food", "pizza", "", 5, null]) expect((await one(100, cat as string)).status, String(cat)).toBe(400);

    const s = (await call("GET", `/api/groups/${gid}/summary`)).json;
    expect(s.byCategory).toEqual({ other: 100, food: 1250, lodging: 4000, transport: 700 });
    expect(s.total).toBe(6050);
    for (const c of ["food", "groceries", "lodging", "transport", "activities", "shopping", "utilities", "other"])
      expect((await one(1, c)).json.bill.category).toBe(c);
  });

  it("category can be edited via PUT and deleted bills drop out of byCategory", async () => {
    const { gid, ids } = await makeGroup();
    const a = (await addBill(gid, { amount: 500, category: "food", paidBy: ids.Alice, split: equal([ids.Alice]) })).json.bill.id;
    const b = (await addBill(gid, { amount: 300, category: "food", paidBy: ids.Alice, split: equal([ids.Alice]) })).json.bill.id;
    await call("PUT", `/api/groups/${gid}/bills/${a}`, { description: "x", date: DATE, amount: 500, category: "shopping", paidBy: ids.Alice, split: equal([ids.Alice]) });
    await call("DELETE", `/api/groups/${gid}/bills/${b}`);
    expect((await call("GET", `/api/groups/${gid}/summary`)).json.byCategory).toEqual({ shopping: 500 });
  });
});

describe("receipts", () => {
  it.each([
    ["image/jpeg", JPEG],
    ["image/png", PNG],
    ["image/webp", WEBP],
  ] as const)("PUT %s stores bytes, GET returns them with sandbox CSP", async (type, bytes) => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    expect((await call("GET", `/api/groups/${gid}`)).json.bills[0].hasReceipt).toBe(false);
    expect((await raw("GET", receiptPath(gid, bid))).status).toBe(404);

    const put = await raw("PUT", receiptPath(gid, bid), bytes, type);
    expect(put.status).toBe(201);
    expect(put.json).toEqual({ ok: true });
    expect((await call("GET", `/api/groups/${gid}`)).json.bills[0].hasReceipt).toBe(true);

    const got = await raw("GET", receiptPath(gid, bid));
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe(type);
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("content-disposition")).toBe("inline");
    expect(got.bytes).toEqual(bytes);
  });

  it("receipt response keeps its own `default-src 'none'; sandbox` CSP (not replaced by the app-wide one)", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    await raw("PUT", receiptPath(gid, bid), PNG, "image/png");
    const got = await raw("GET", receiptPath(gid, bid));
    expect(got.status).toBe(200);
    expect(got.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });

  it("wrong magic bytes -> 415 even with an image content-type", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    const txt = new TextEncoder().encode("hello, I am not an image at all");
    for (const [name, body] of [
      ["text", txt],
      ["html", new TextEncoder().encode("<html><script>alert(1)</script></html>")],
      ["svg", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ["gif", new TextEncoder().encode("GIF89a\x01\x00\x01\x00")],
      ["truncated jpeg", new Uint8Array([0xff, 0xd8])],
      ["truncated png", new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
      ["riff but not webp", pad([...ascii("RIFF"), 24, 0, 0, 0, ...ascii("WAVE")], 32)],
      ["empty", new Uint8Array(0)],
    ] as const) {
      const r = await raw("PUT", receiptPath(gid, bid), body, "image/png");
      expect(r.status, name).toBe(415);
      expect(r.json.error.code).toBe("unsupported_media_type");
    }
    expect(await receiptCount(gid)).toBe(0);
    expect((await call("GET", `/api/groups/${gid}`)).json.bills[0].hasReceipt).toBe(false);
  });

  it("wrong or missing content-type -> 415", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    for (const ct of ["image/gif", "image/svg+xml", "text/html", "application/json", "application/octet-stream", "text/plain", "image/jpegx", undefined]) {
      const r = await raw("PUT", receiptPath(gid, bid), JPEG, ct);
      expect(r.status, String(ct)).toBe(415);
    }
    expect(await receiptCount(gid)).toBe(0);
  });

  it("> 2 MiB -> 413 (exactly 2 MiB is fine); nothing stored", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set([0xff, 0xd8, 0xff, 0xe0]);
    const r = await raw("PUT", receiptPath(gid, bid), big, "image/jpeg");
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe("payload_too_large");
    expect(await receiptCount(gid)).toBe(0);
    const ok = new Uint8Array(2 * 1024 * 1024);
    ok.set([0xff, 0xd8, 0xff, 0xe0]);
    expect((await raw("PUT", receiptPath(gid, bid), ok, "image/jpeg")).status).toBe(201);
  });

  it("replacing a receipt deletes the previous R2 object; content type follows the bytes", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    await raw("PUT", receiptPath(gid, bid), JPEG, "image/jpeg");
    const first = (await env.RECEIPTS.list({ prefix: `${gid}/` })).objects.map((o) => o.key);
    expect(first).toHaveLength(1);
    await raw("PUT", receiptPath(gid, bid), PNG, "image/png");
    const second = (await env.RECEIPTS.list({ prefix: `${gid}/` })).objects.map((o) => o.key);
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);
    const got = await raw("GET", receiptPath(gid, bid));
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.bytes).toEqual(PNG);
  });

  it("sniffed type wins over the declared one (png bytes sent as image/jpeg are served as png)", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    expect((await raw("PUT", receiptPath(gid, bid), PNG, "image/jpeg")).status).toBe(201);
    expect((await raw("GET", receiptPath(gid, bid))).headers.get("content-type")).toBe("image/png");
  });

  it("DELETE removes R2 object and flag; repeat DELETE 404", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    await raw("PUT", receiptPath(gid, bid), WEBP, "image/webp");
    expect(await receiptCount(gid)).toBe(1);
    expect((await call("DELETE", receiptPath(gid, bid))).status).toBe(204);
    expect(await receiptCount(gid)).toBe(0);
    expect((await raw("GET", receiptPath(gid, bid))).status).toBe(404);
    expect((await call("DELETE", receiptPath(gid, bid))).status).toBe(404);
    expect((await call("GET", `/api/groups/${gid}`)).json.bills[0].hasReceipt).toBe(false);
  });

  it("404 for unknown/malformed bill ids; receipts are scoped to their group", async () => {
    const a = await makeGroup();
    const b = await makeGroup();
    const bid = await simpleBill(a.gid, a.ids);
    await raw("PUT", receiptPath(a.gid, bid), JPEG, "image/jpeg");
    for (const id of ["AAAAAAAAAAAAAAAA", "x", "%20"]) {
      expect((await raw("PUT", receiptPath(a.gid, id), JPEG, "image/jpeg")).status, id).toBe(404);
      expect((await raw("GET", receiptPath(a.gid, id))).status, id).toBe(404);
      expect((await call("DELETE", receiptPath(a.gid, id))).status, id).toBe(404);
    }
    expect((await raw("GET", receiptPath(b.gid, bid))).status).toBe(404);
    expect((await raw("PUT", receiptPath(b.gid, bid), PNG, "image/png")).status).toBe(404);
    expect((await call("DELETE", receiptPath(b.gid, bid))).status).toBe(404);
    expect((await raw("GET", receiptPath(a.gid, bid))).status).toBe(200); // untouched
  });

  it("receipt of a soft-deleted bill is not served until restored", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    await raw("PUT", receiptPath(gid, bid), JPEG, "image/jpeg");
    await call("DELETE", `/api/groups/${gid}/bills/${bid}`);
    expect((await raw("GET", receiptPath(gid, bid))).status).toBe(404);
    await restore(gid, bid);
    expect((await raw("GET", receiptPath(gid, bid))).status).toBe(200);
  });
});

describe("recurring bills", () => {
  const rentBody = (ids: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    description: "Rent",
    amount: 3000,
    category: "lodging",
    paidBy: ids.Alice,
    split: equal([ids.Alice, ids.Bob, ids.Carol]),
    ...extra,
  });

  it("weekly from 21 days ago creates 4 due bills (T-21, T-14, T-7, today); reading again creates no duplicates", async () => {
    const { gid, ids } = await makeGroup();
    const r = await call("POST", `/api/groups/${gid}/recurring`, { frequency: "weekly", startDate: daysAgo(21), bill: rentBody(ids) });
    expect(r.status, r.text).toBe(201);
    expect(r.json.created).toBe(4);
    expect(r.json.recurring).toMatchObject({ frequency: "weekly", active: true, lastError: null, nextDate: isoDay(new Date(Date.now() + 7 * DAY)) });
    expect(r.json.recurring.template).toMatchObject({ description: "Rent", amount: 3000 });
    expect(r.json.recurring.template.date).toBeUndefined();

    const g1 = await call("GET", `/api/groups/${gid}`);
    expect(g1.json.bills).toHaveLength(4);
    expect(g1.json.bills.map((b: any) => b.date)).toEqual([daysAgo(0), daysAgo(7), daysAgo(14), daysAgo(21)]);
    for (const b of g1.json.bills) expect(b).toMatchObject({ recurrenceId: r.json.recurring.id, amount: 3000, category: "lodging", kind: "expense" });

    for (let i = 0; i < 3; i++) {
      expect((await call("GET", `/api/groups/${gid}`)).json.bills).toHaveLength(4);
      expect((await call("GET", `/api/groups/${gid}/summary`)).json.total).toBe(12000);
    }
    const list = await call("GET", `/api/groups/${gid}/recurring`);
    expect(list.json.recurring).toHaveLength(1);
    expect(list.json.recurring[0].id).toBe(r.json.recurring.id);
    const acts = (await activity(gid)).map((a) => a.action);
    expect(acts.filter((a) => a === "bill.recurring")).toHaveLength(4);
    expect(acts.filter((a) => a === "recurring.create")).toHaveLength(1);
  });

  it("concurrent reads never duplicate occurrences", async () => {
    const { gid, ids } = await makeGroup();
    const r = await call("POST", `/api/groups/${gid}/recurring`, {
      frequency: "weekly", startDate: isoDay(new Date(Date.now() + 5 * DAY)), bill: rentBody(ids),
    });
    await env.DB.prepare("UPDATE recurrences SET next_date = ? WHERE id = ?").bind(daysAgo(14), r.json.recurring.id).run(); // 3 due
    await Promise.all(Array.from({ length: 6 }, () => call("GET", `/api/groups/${gid}`)));
    const bills = (await call("GET", `/api/groups/${gid}`)).json.bills as any[];
    expect(bills.map((b) => b.date).sort()).toEqual([daysAgo(14), daysAgo(7), daysAgo(0)].sort());
  });

  it("start today -> 1 bill; start in the future -> 0 bills, materializes when due", async () => {
    const { gid, ids } = await makeGroup();
    const now = await call("POST", `/api/groups/${gid}/recurring`, { frequency: "monthly", startDate: daysAgo(0), bill: rentBody(ids) });
    expect(now.json.created).toBe(1);
    const fut = await call("POST", `/api/groups/${gid}/recurring`, {
      frequency: "weekly", startDate: isoDay(new Date(Date.now() + 2 * DAY)), bill: rentBody(ids, { description: "Later" }),
    });
    expect(fut.json.created).toBe(0);
    expect((await call("GET", `/api/groups/${gid}`)).json.bills).toHaveLength(1);
    await env.DB.prepare("UPDATE recurrences SET next_date = ? WHERE id = ?").bind(daysAgo(0), fut.json.recurring.id).run();
    const g = await call("GET", `/api/groups/${gid}`);
    expect(g.json.bills.map((b: any) => b.description).sort()).toEqual(["Later", "Rent"]);
  });

  it("monthly keeps the anchor day, clamped to month length (31st)", async () => {
    const { gid, ids } = await makeGroup();
    // The API only accepts starts within the last 92 days (ISSUES #25), so start in the future and then move the
    // series back to Jan 31 in the DB to exercise month-end clamping over several months.
    const r = await call("POST", `/api/groups/${gid}/recurring`, { frequency: "monthly", startDate: daysAgo(-30), bill: rentBody(ids) });
    expect(r.status, r.text).toBe(201);
    expect(r.json.created).toBe(0);
    await env.DB.prepare("UPDATE recurrences SET next_date = '2025-01-31', anchor_day = 31 WHERE id = ?").bind(r.json.recurring.id).run();
    const dates = ((await call("GET", `/api/groups/${gid}`)).json.bills as any[]).map((b) => b.date).sort();
    expect(dates.slice(0, 6)).toEqual(["2025-01-31", "2025-02-28", "2025-03-31", "2025-04-30", "2025-05-31", "2025-06-30"]);
    expect(new Set(dates).size).toBe(dates.length);
    for (const d of dates) expect(d <= daysAgo(0)).toBe(true);
    const rec = (await call("GET", `/api/groups/${gid}/recurring`)).json.recurring[0];
    expect(rec.nextDate > daysAgo(0)).toBe(true);
  });

  it("DELETE stops the series; existing bills stay; no new bills; 404 on repeat", async () => {
    const { gid, ids } = await makeGroup();
    const r = await call("POST", `/api/groups/${gid}/recurring`, { frequency: "weekly", startDate: daysAgo(14), bill: rentBody(ids) });
    const rid = r.json.recurring.id;
    expect(r.json.created).toBe(3);
    expect((await call("DELETE", `/api/groups/${gid}/recurring/${rid}`)).status).toBe(204);
    expect((await call("DELETE", `/api/groups/${gid}/recurring/${rid}`)).status).toBe(404);
    expect((await call("GET", `/api/groups/${gid}/recurring`)).json.recurring[0]).toMatchObject({ id: rid, active: false });
    await env.DB.prepare("UPDATE recurrences SET next_date = ? WHERE id = ?").bind(daysAgo(30), rid).run();
    await scheduledMaintenance(env);
    expect((await call("GET", `/api/groups/${gid}`)).json.bills).toHaveLength(3);
    for (const id of ["AAAAAAAAAAAAAAAA", "x"]) expect((await call("DELETE", `/api/groups/${gid}/recurring/${id}`)).status).toBe(404);
  });

  it("recurring ids are group scoped", async () => {
    const a = await makeGroup();
    const b = await makeGroup();
    const r = await call("POST", `/api/groups/${a.gid}/recurring`, { frequency: "weekly", startDate: daysAgo(0), bill: rentBody(a.ids) });
    expect((await call("DELETE", `/api/groups/${b.gid}/recurring/${r.json.recurring.id}`)).status).toBe(404);
    expect((await call("GET", `/api/groups/${b.gid}/recurring`)).json.recurring).toEqual([]);
  });

  it("validation: frequency, dates, payment kind, bad template, missing bill", async () => {
    const { gid, ids } = await makeGroup();
    const post = (body: unknown) => call("POST", `/api/groups/${gid}/recurring`, body);
    const ok = { frequency: "weekly", startDate: daysAgo(0), bill: rentBody(ids) };
    for (const bad of [
      { ...ok, frequency: "daily" },
      { ...ok, frequency: undefined },
      { ...ok, startDate: "2026-02-30" },
      { ...ok, startDate: "yesterday" },
      { ...ok, startDate: undefined },
      { ...ok, bill: undefined },
      { ...ok, bill: "x" },
      { ...ok, bill: rentBody(ids, { kind: "payment", split: equal([ids.Bob]) }) },
      { ...ok, bill: rentBody(ids, { amount: -1 }) },
      { ...ok, bill: rentBody(ids, { paidBy: "nope" }) },
      { ...ok, bill: rentBody(ids, { category: "nope" }) },
      { ...ok, bill: rentBody(ids, { split: { mode: "percent", percents: [{ memberId: ids.Alice, bp: 1 }] } }) },
      [],
    ])
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
    // a date inside the template is ignored (startDate drives the schedule)
    const withDate = await post({ ...ok, bill: rentBody(ids, { date: "1999-01-01" }) });
    expect(withDate.status).toBe(201);
    expect(withDate.json.recurring.template.date).toBeUndefined();
    expect(withDate.json.created).toBe(1);
  });

  it("supports itemized, shares and fx templates; fx re-converts at the stored rate", async () => {
    const { gid, ids } = await makeGroup();
    const sh = await call("POST", `/api/groups/${gid}/recurring`, {
      frequency: "weekly", startDate: daysAgo(0),
      bill: { description: "Share", amount: 900, paidBy: ids.Alice, split: { mode: "shares", weights: [{ memberId: ids.Alice, weight: 1 }, { memberId: ids.Bob, weight: 2 }] } },
    });
    expect(sh.status, sh.text).toBe(201);
    const fx = await call("POST", `/api/groups/${gid}/recurring`, {
      frequency: "weekly", startDate: daysAgo(0),
      bill: { description: "Sub", paidBy: ids.Alice, fx: { currency: "EUR", amount: 1000, rate: "1.10" }, split: equal([ids.Alice]) },
    });
    expect(fx.status, fx.text).toBe(201);
    const bills = (await call("GET", `/api/groups/${gid}`)).json.bills as any[];
    expect(shareMap(bills.find((b) => b.description === "Share"))).toEqual({ [ids.Alice]: 300, [ids.Bob]: 600 });
    expect(bills.find((b) => b.description === "Sub")).toMatchObject({ amount: 1100, fx: { currency: "EUR", amount: 1000, rate: "1.10" } });
  });

  it("at most 20 active recurring bills per group (409), stopped ones free a slot", async () => {
    const { gid, ids } = await makeGroup();
    const future = isoDay(new Date(Date.now() + 5 * DAY));
    let first = "";
    for (let i = 0; i < 20; i++) {
      const r = await call("POST", `/api/groups/${gid}/recurring`, { frequency: "monthly", startDate: future, bill: rentBody(ids, { description: `R${i}` }) });
      expect(r.status, `#${i}`).toBe(201);
      first ||= r.json.recurring.id;
    }
    const over = await call("POST", `/api/groups/${gid}/recurring`, { frequency: "monthly", startDate: future, bill: rentBody(ids) });
    expect(over.status).toBe(409);
    expect(over.json.error.code).toBe("conflict");
    await call("DELETE", `/api/groups/${gid}/recurring/${first}`);
    expect((await call("POST", `/api/groups/${gid}/recurring`, { frequency: "monthly", startDate: future, bill: rentBody(ids) })).status).toBe(201);
  });

  it("template referencing a member blocks removing that member (member-in-use 409) until the series is stopped", async () => {
    const { gid, ids } = await makeGroup();
    const future = isoDay(new Date(Date.now() + 5 * DAY));
    const r = await call("POST", `/api/groups/${gid}/recurring`, {
      frequency: "monthly", startDate: future, bill: { description: "Rent", amount: 3000, paidBy: ids.Alice, split: equal([ids.Alice, ids.Carol]) },
    });
    expect(r.json.created).toBe(0); // no live bills, only the template
    for (const who of [ids.Alice, ids.Carol]) {
      const del = await call("DELETE", `/api/groups/${gid}/members/${who}`);
      expect(del.status).toBe(409);
      expect(del.json.error.code).toBe("conflict");
    }
    expect((await call("DELETE", `/api/groups/${gid}/members/${ids.Bob}`)).status).toBe(204); // Bob unused
    expect((await call("DELETE", `/api/groups/${gid}/recurring/${r.json.recurring.id}`)).status).toBe(204);
    expect((await call("DELETE", `/api/groups/${gid}/members/${ids.Carol}`)).status).toBe(204);
    // inactive series that mentioned Carol is cleaned up with her; the one for Alice only is untouched
    expect((await call("GET", `/api/groups/${gid}/recurring`)).json.recurring).toEqual([]);
  });

  it("bills created by a series keep the member blocked even after stopping (live bills)", async () => {
    const { gid, ids } = await makeGroup();
    const r = await call("POST", `/api/groups/${gid}/recurring`, { frequency: "weekly", startDate: daysAgo(0), bill: rentBody(ids) });
    await call("DELETE", `/api/groups/${gid}/recurring/${r.json.recurring.id}`);
    expect((await call("DELETE", `/api/groups/${gid}/members/${ids.Carol}`)).status).toBe(409);
  });

  it("a template invalidated later is deactivated with lastError instead of looping", async () => {
    const { gid, ids } = await makeGroup();
    const future = isoDay(new Date(Date.now() + 5 * DAY));
    const r = await call("POST", `/api/groups/${gid}/recurring`, { frequency: "weekly", startDate: future, bill: rentBody(ids) });
    const rid = r.json.recurring.id;
    const tpl = JSON.stringify({ description: "Broken", amount: 100, paidBy: "gone-member", split: equal(["gone-member"]) });
    await env.DB.prepare("UPDATE recurrences SET template = ?, next_date = ? WHERE id = ?").bind(tpl, daysAgo(7), rid).run();
    const g = await call("GET", `/api/groups/${gid}`);
    expect(g.status).toBe(200);
    expect(g.json.bills).toEqual([]);
    const rec = (await call("GET", `/api/groups/${gid}/recurring`)).json.recurring[0];
    expect(rec.active).toBe(false);
    expect(rec.lastError).toEqual(expect.any(String));
    expect(rec.lastError.length).toBeGreaterThan(0);
  });
});

describe("backup", () => {
  async function gunzipJson(key: string) {
    const obj = await env.BACKUPS.get(key);
    expect(obj, key).not.toBeNull();
    const buf = await obj!.arrayBuffer();
    const text = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    return { file: JSON.parse(text), meta: obj!.customMetadata, httpMetadata: obj!.httpMetadata };
  }
  const count = async (t: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;

  it("writes backups/<date>.json.gz with every table and matching row counts", async () => {
    const { gid, ids } = await makeGroup(["Backup A", "Backup B"]);
    const bid = await simpleBill(gid, { Alice: ids["Backup A"], Bob: ids["Backup B"], Carol: ids["Backup B"] }, { split: equal([ids["Backup A"], ids["Backup B"]]), paidBy: ids["Backup A"] });
    const now = new Date("2031-03-05T10:20:30.000Z");
    const { key, rows } = await runBackup(env, now);
    expect(key).toBe("backups/2031-03-05.json.gz");
    const { file, meta, httpMetadata } = await gunzipJson(key);
    expect(file.version).toBe(1);
    expect(file.createdAt).toBe("2031-03-05T10:20:30.000Z");
    expect(Object.keys(file.tables)).toEqual([...BACKUP_TABLES]);
    let total = 0;
    for (const [t, list] of Object.entries<any[]>(file.tables)) {
      expect(list.length, t).toBe(await count(t));
      total += list.length;
    }
    expect(rows).toBe(total);
    expect(meta).toEqual({ rows: String(total) });
    expect(httpMetadata?.contentType).toBe("application/json");
    expect(file.tables.groups.some((g: any) => g.id === gid)).toBe(true);
    expect(file.tables.members.filter((m: any) => m.group_id === gid)).toHaveLength(2);
    expect(file.tables.bills.some((b: any) => b.id === bid && b.group_id === gid)).toBe(true);
    expect(file.tables.bill_shares.filter((s: any) => s.bill_id === bid)).toHaveLength(2);
    expect(file.tables.bill_payers.filter((s: any) => s.bill_id === bid)).toHaveLength(1);
    expect(file.tables.activity.filter((a: any) => a.group_id === gid).length).toBeGreaterThanOrEqual(2); // group.create + bill.create
  });

  it("includes soft-deleted bills and archived groups; runs idempotently (same key overwritten)", async () => {
    const { gid, ids } = await makeGroup();
    const bid = await simpleBill(gid, ids);
    await call("DELETE", `/api/groups/${gid}/bills/${bid}`);
    await call("PATCH", `/api/groups/${gid}`, { archived: true });
    const now = new Date("2031-04-01T00:17:00.000Z");
    await runBackup(env, now);
    const again = await runBackup(env, now);
    const { file } = await gunzipJson(again.key);
    expect(file.tables.bills.find((b: any) => b.id === bid).deleted_at).toEqual(expect.any(String));
    expect(file.tables.groups.find((g: any) => g.id === gid).archived_at).toEqual(expect.any(String));
    const listed = (await env.BACKUPS.list({ prefix: "backups/2031-04-01" })).objects;
    expect(listed).toHaveLength(1);
  });

  it("prunes backups older than 30 days (and only under backups/)", async () => {
    const now = new Date("2031-06-15T00:17:00.000Z");
    const day = (n: number) => `backups/${isoDay(new Date(now.getTime() - n * DAY))}.json.gz`;
    const body = new Uint8Array([1, 2, 3]);
    const old = ["backups/2000-01-01.json.gz", day(31), day(45), day(365)];
    const keep = [day(30), day(29), day(1)];
    for (const k of [...old, ...keep, "other/2000-01-01.json.gz"]) await env.BACKUPS.put(k, body);
    await runBackup(env, now);
    const keys = new Set((await env.BACKUPS.list()).objects.map((o) => o.key));
    for (const k of old) expect(keys.has(k), `${k} should be pruned`).toBe(false);
    for (const k of keep) expect(keys.has(k), `${k} should stay`).toBe(true);
    expect(keys.has("other/2000-01-01.json.gz")).toBe(true);
    expect(keys.has("backups/2031-06-15.json.gz")).toBe(true);
  });

  it("the backup file is restorable SQL-wise: every row has its columns and FK parents come first", async () => {
    const { gid, ids } = await makeGroup();
    await simpleBill(gid, ids);
    const { key } = await runBackup(env, new Date("2031-07-01T00:00:00.000Z"));
    const { file } = await gunzipJson(key);
    const groupIds = new Set(file.tables.groups.map((g: any) => g.id));
    const memberIds = new Set(file.tables.members.map((m: any) => m.id));
    const billIds = new Set(file.tables.bills.map((b: any) => b.id));
    for (const m of file.tables.members) expect(groupIds.has(m.group_id)).toBe(true);
    for (const b of file.tables.bills) {
      expect(groupIds.has(b.group_id)).toBe(true);
      expect(memberIds.has(b.paid_by)).toBe(true);
    }
    for (const s of [...file.tables.bill_shares, ...file.tables.bill_payers]) {
      expect(billIds.has(s.bill_id)).toBe(true);
      expect(memberIds.has(s.member_id)).toBe(true);
    }
  });
});

describe("scheduledMaintenance", () => {
  const agoSql = (days: number) => `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${days} days')`;

  it("purges bills soft-deleted > 30 days ago (and their receipts + children); keeps recent ones and live ones", async () => {
    const { gid, ids } = await makeGroup();
    const old = await simpleBill(gid, ids, { description: "old" });
    const recent = await simpleBill(gid, ids, { description: "recent" });
    const live = await simpleBill(gid, ids, { description: "live" });
    const edge = await simpleBill(gid, ids, { description: "edge" });
    await raw("PUT", receiptPath(gid, old), JPEG, "image/jpeg");
    await raw("PUT", receiptPath(gid, recent), PNG, "image/png");
    for (const b of [old, recent, edge]) await call("DELETE", `/api/groups/${gid}/bills/${b}`);
    await env.DB.prepare(`UPDATE bills SET deleted_at = ${agoSql(31)} WHERE id = ?`).bind(old).run();
    await env.DB.prepare(`UPDATE bills SET deleted_at = ${agoSql(1)} WHERE id = ?`).bind(recent).run();
    await env.DB.prepare(`UPDATE bills SET deleted_at = ${agoSql(29)} WHERE id = ?`).bind(edge).run();
    expect(await receiptCount(gid)).toBe(2);

    await scheduledMaintenance(env);

    const rows = await env.DB.prepare("SELECT id FROM bills WHERE group_id = ?").bind(gid).all<{ id: string }>();
    const left = new Set(rows.results.map((r) => r.id));
    expect(left.has(old)).toBe(false);
    expect(left.has(recent)).toBe(true);
    expect(left.has(live)).toBe(true);
    expect(left.has(edge)).toBe(true);
    // receipt of the purged bill is gone from R2, the other stays
    const keys = (await env.RECEIPTS.list({ prefix: `${gid}/` })).objects.map((o) => o.key);
    expect(keys).toHaveLength(1);
    expect(keys[0].startsWith(`${gid}/${recent}/`)).toBe(true);
    // children cascade
    for (const t of ["bill_shares", "bill_payers"]) {
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE bill_id = ?`).bind(old).first<{ n: number }>();
      expect(n!.n, t).toBe(0);
    }
    // the recent one is still restorable, the purged one is not
    expect((await restore(gid, recent)).status).toBe(200);
    expect((await restore(gid, old)).status).toBe(404);
    expect((await call("GET", `/api/groups/${gid}`)).json.bills).toHaveLength(2); // live + recent (edge is still binned)
  });

  it("also takes a backup first (snapshot still contains the bill about to be purged) and materializes due recurring bills", async () => {
    const { gid, ids } = await makeGroup();
    const doomed = await simpleBill(gid, ids, { description: "doomed" });
    await call("DELETE", `/api/groups/${gid}/bills/${doomed}`);
    await env.DB.prepare(`UPDATE bills SET deleted_at = ${agoSql(40)} WHERE id = ?`).bind(doomed).run();
    const rec = await call("POST", `/api/groups/${gid}/recurring`, {
      frequency: "weekly", startDate: isoDay(new Date(Date.now() + 3 * DAY)),
      bill: { description: "R", amount: 100, paidBy: ids.Alice, split: equal([ids.Alice]) },
    });
    await env.DB.prepare("UPDATE recurrences SET next_date = ? WHERE id = ?").bind(daysAgo(7), rec.json.recurring.id).run();

    await scheduledMaintenance(env);

    const key = `backups/${daysAgo(0)}.json.gz`;
    const obj = await env.BACKUPS.get(key);
    expect(obj).not.toBeNull();
    const text = await new Response(new Blob([await obj!.arrayBuffer()]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    expect(JSON.parse(text).tables.bills.some((b: any) => b.id === doomed)).toBe(true);
    const gone = await env.DB.prepare("SELECT 1 AS x FROM bills WHERE id = ?").bind(doomed).first();
    expect(gone).toBeNull();
    // maintenance materialized the 2 due occurrences (T-7 and today) without anyone reading the group
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM bills WHERE group_id = ? AND recurrence_id = ?").bind(gid, rec.json.recurring.id).first<{ n: number }>();
    expect(n!.n).toBe(2);
    await scheduledMaintenance(env); // idempotent
    const n2 = await env.DB.prepare("SELECT COUNT(*) AS n FROM bills WHERE group_id = ? AND recurrence_id = ?").bind(gid, rec.json.recurring.id).first<{ n: number }>();
    expect(n2!.n).toBe(2);
  });
});
