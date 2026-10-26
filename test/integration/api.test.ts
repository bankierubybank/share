import { exports } from "cloudflare:workers";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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

const DATE = "2026-01-15";

async function makeGroup(names = ["Alice", "Bob", "Carol"]) {
  const r = await call("POST", "/api/groups", { name: "Trip", currency: "USD", members: names });
  expect(r.status).toBe(201);
  const ids: Record<string, string> = {};
  for (const m of r.json.members) ids[m.name] = m.id;
  return { gid: r.json.group.id as string, ids };
}

const equal = (members: string[]) => ({ mode: "equal", members });

async function addBill(gid: string, body: Record<string, unknown>) {
  return call("POST", `/api/groups/${gid}/bills`, { description: "Thing", date: DATE, ...body });
}

describe("groups", () => {
  it("creates a group", async () => {
    const r = await call("POST", "/api/groups", { name: "  Trip  ", currency: "EUR", members: ["A", "B"] });
    expect(r.status).toBe(201);
    expect(r.json.group).toMatchObject({ name: "Trip", currency: "EUR" });
    expect(r.json.group.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(r.json.members.map((m: any) => m.name)).toEqual(["A", "B"]);
  });

  it("rejects invalid group bodies", async () => {
    for (const body of [
      {},
      { name: "x", currency: "usd", members: ["A"] },
      { name: "x", currency: "USD", members: [] },
      { name: "x", currency: "USD", members: ["A", "a"] },
      { name: "", currency: "USD", members: ["A"] },
    ]) {
      const r = await call("POST", "/api/groups", body);
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("validation");
    }
  });

  it("gets a group", async () => {
    const { gid } = await makeGroup();
    const r = await call("GET", `/api/groups/${gid}`);
    expect(r.status).toBe(200);
    expect(r.json.group.id).toBe(gid);
    expect(r.json.members).toHaveLength(3);
    expect(r.json.bills).toEqual([]);
  });

  it("patches a group", async () => {
    const { gid } = await makeGroup();
    const r = await call("PATCH", `/api/groups/${gid}`, { name: "Renamed", currency: "THB" });
    expect(r.status).toBe(200);
    expect(r.json.group).toMatchObject({ id: gid, name: "Renamed", currency: "THB" });
    expect((await call("PATCH", `/api/groups/${gid}`, {})).status).toBe(400);
    expect((await call("PATCH", `/api/groups/${gid}`, { currency: "thb" })).status).toBe(400);
  });

  it("lists bills newest date first", async () => {
    const { gid, ids } = await makeGroup();
    for (const date of ["2026-01-01", "2026-03-01", "2026-02-01"])
      await addBill(gid, { amount: 100, paidBy: ids.Alice, date, split: equal([ids.Alice]) });
    const r = await call("GET", `/api/groups/${gid}`);
    expect(r.json.bills.map((b: any) => b.date)).toEqual(["2026-03-01", "2026-02-01", "2026-01-01"]);
  });
});

describe("members", () => {
  it("adds, renames and deletes a member", async () => {
    const { gid } = await makeGroup();
    const add = await call("POST", `/api/groups/${gid}/members`, { name: "Dave" });
    expect(add.status).toBe(201);
    const mid = add.json.member.id;
    expect(add.json.member.name).toBe("Dave");

    const ren = await call("PATCH", `/api/groups/${gid}/members/${mid}`, { name: "David" });
    expect(ren.status).toBe(200);
    expect(ren.json.member).toEqual({ id: mid, name: "David", promptpay: null });

    expect((await call("DELETE", `/api/groups/${gid}/members/${mid}`)).status).toBe(204);
    const g = await call("GET", `/api/groups/${gid}`);
    expect(g.json.members.map((m: any) => m.name)).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("409 on duplicate name (case-insensitive) for add and rename", async () => {
    const { gid, ids } = await makeGroup();
    const add = await call("POST", `/api/groups/${gid}/members`, { name: "alice" });
    expect(add.status).toBe(409);
    expect(add.json.error.code).toBe("conflict");
    const ren = await call("PATCH", `/api/groups/${gid}/members/${ids.Bob}`, { name: "CAROL" });
    expect(ren.status).toBe(409);
  });

  it("same name allowed in a different group", async () => {
    const a = await makeGroup(["Zed"]);
    const b = await makeGroup(["Zed"]);
    expect(a.gid).not.toBe(b.gid);
  });

  it("409 deleting a member used as payer or in shares; ok after bill removal", async () => {
    const { gid, ids } = await makeGroup();
    const bill = await addBill(gid, { amount: 900, paidBy: ids.Alice, split: equal([ids.Alice, ids.Bob]) });
    expect(bill.status).toBe(201);
    expect((await call("DELETE", `/api/groups/${gid}/members/${ids.Alice}`)).status).toBe(409);
    expect((await call("DELETE", `/api/groups/${gid}/members/${ids.Bob}`)).status).toBe(409);
    expect((await call("DELETE", `/api/groups/${gid}/members/${ids.Carol}`)).status).toBe(204);
    await call("DELETE", `/api/groups/${gid}/bills/${bill.json.bill.id}`);
    expect((await call("DELETE", `/api/groups/${gid}/members/${ids.Alice}`)).status).toBe(204);
  });

  it("404 for unknown or malformed member id", async () => {
    const { gid } = await makeGroup();
    for (const mid of ["AAAAAAAAAAAAAAAA", "short", "%20%20"]) {
      expect((await call("PATCH", `/api/groups/${gid}/members/${mid}`, { name: "X" })).status).toBe(404);
      expect((await call("DELETE", `/api/groups/${gid}/members/${mid}`)).status).toBe(404);
    }
  });
});

describe("bills", () => {
  it("creates an equal bill with remainder cents in order", async () => {
    const { gid, ids } = await makeGroup();
    const r = await addBill(gid, {
      description: "Dinner",
      amount: 1000,
      paidBy: ids.Alice,
      split: equal([ids.Bob, ids.Carol, ids.Alice]),
    });
    expect(r.status).toBe(201);
    expect(r.json.bill).toMatchObject({ kind: "expense", description: "Dinner", amount: 1000, paidBy: ids.Alice, splitMode: "equal" });
    // Row order is not part of the contract; compare as a map.
    expect(Object.fromEntries(r.json.bill.shares.map((s: any) => [s.memberId, s.amount]))).toEqual({
      [ids.Bob]: 334,
      [ids.Carol]: 333,
      [ids.Alice]: 333,
    });
  });

  it("creates an exact bill and validates sum", async () => {
    const { gid, ids } = await makeGroup();
    const ok = await addBill(gid, {
      amount: 1000,
      paidBy: ids.Bob,
      split: { mode: "exact", shares: [{ memberId: ids.Alice, amount: 700 }, { memberId: ids.Carol, amount: 300 }] },
    });
    expect(ok.status).toBe(201);
    expect(ok.json.bill.splitMode).toBe("exact");
    const bad = await addBill(gid, {
      amount: 1000,
      paidBy: ids.Bob,
      split: { mode: "exact", shares: [{ memberId: ids.Alice, amount: 700 }] },
    });
    expect(bad.status).toBe(400);
  });

  it("rejects bad amounts, dates and kinds", async () => {
    const { gid, ids } = await makeGroup();
    const base = { paidBy: ids.Alice, split: equal([ids.Alice]) };
    for (const extra of [
      { amount: 0 },
      { amount: -5 },
      { amount: 1.5 },
      { amount: "100" },
      { amount: 100_000_000_001 },
      { amount: 100, date: "2026-02-30" },
      { amount: 100, date: "15/01/2026" },
      { amount: 100, kind: "gift" },
    ]) {
      const r = await addBill(gid, { ...base, ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it("PUT replaces shares and fields", async () => {
    const { gid, ids } = await makeGroup();
    const created = await addBill(gid, { amount: 900, paidBy: ids.Alice, split: equal([ids.Alice, ids.Bob, ids.Carol]) });
    const bid = created.json.bill.id;
    const upd = await call("PUT", `/api/groups/${gid}/bills/${bid}`, {
      description: "Edited",
      amount: 500,
      paidBy: ids.Bob,
      date: "2026-02-02",
      split: { mode: "exact", shares: [{ memberId: ids.Carol, amount: 500 }] },
    });
    expect(upd.status).toBe(200);
    expect(upd.json.bill).toMatchObject({ id: bid, description: "Edited", amount: 500, paidBy: ids.Bob, splitMode: "exact" });
    expect(upd.json.bill.shares).toEqual([{ memberId: ids.Carol, amount: 500 }]);

    const rows = await env.DB.prepare("SELECT member_id, amount FROM bill_shares WHERE bill_id = ?").bind(bid).all();
    expect(rows.results).toEqual([{ member_id: ids.Carol, amount: 500 }]);

    const g = await call("GET", `/api/groups/${gid}`);
    expect(g.json.bills).toHaveLength(1);
    expect(g.json.bills[0].shares).toEqual([{ memberId: ids.Carol, amount: 500 }]);
  });

  it("DELETE soft-deletes (restorable); purge cascades bill_shares", async () => {
    const { gid, ids } = await makeGroup();
    const created = await addBill(gid, { amount: 900, paidBy: ids.Alice, split: equal([ids.Alice, ids.Bob, ids.Carol]) });
    const bid = created.json.bill.id;
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM bill_shares WHERE bill_id = ?").bind(bid).first<{ n: number }>();
    expect(before?.n).toBe(3);
    expect((await call("DELETE", `/api/groups/${gid}/bills/${bid}`)).status).toBe(204);
    // Soft delete: hidden from lists, shares kept for restore.
    expect((await call("GET", `/api/groups/${gid}`)).json.bills).toEqual([]);
    const kept = await env.DB.prepare("SELECT COUNT(*) AS n FROM bill_shares WHERE bill_id = ?").bind(bid).first<{ n: number }>();
    expect(kept?.n).toBe(3);
    // Hard delete (what the 30-day purge does) cascades.
    await env.DB.prepare("DELETE FROM bills WHERE id = ?").bind(bid).run();
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM bill_shares WHERE bill_id = ?").bind(bid).first<{ n: number }>();
    expect(after?.n).toBe(0);
    expect((await call("DELETE", `/api/groups/${gid}/bills/${bid}`)).status).toBe(404);
    expect((await call("PUT", `/api/groups/${gid}/bills/${bid}`, {})).status).toBe(404);
  });

  it("enforces payment rules", async () => {
    const { gid, ids } = await makeGroup();
    const pay = (split: unknown, paidBy = ids.Bob) => addBill(gid, { kind: "payment", amount: 100, paidBy, split });
    expect((await pay(equal([ids.Alice]))).status).toBe(201);
    expect((await pay(equal([ids.Alice, ids.Carol]))).status).toBe(400);
    expect((await pay(equal([ids.Bob]))).status).toBe(400);
  });
});

describe("summary", () => {
  it("computes balances, total and settlements", async () => {
    const { gid, ids } = await makeGroup();
    await addBill(gid, { amount: 900, paidBy: ids.Alice, split: equal([ids.Alice, ids.Bob, ids.Carol]) });
    const r = await call("GET", `/api/groups/${gid}/summary`);
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(900);
    expect(r.json.balances).toEqual(
      expect.arrayContaining([
        { memberId: ids.Alice, paid: 900, owed: 300, net: 600 },
        { memberId: ids.Bob, paid: 0, owed: 300, net: -300 },
        { memberId: ids.Carol, paid: 0, owed: 300, net: -300 },
      ]),
    );
    expect(r.json.settlements).toHaveLength(2);
    for (const s of r.json.settlements) {
      expect(s.to).toBe(ids.Alice);
      expect(s.amount).toBe(300);
    }
  });

  it("payment settles a debt to zero and is excluded from total", async () => {
    const { gid, ids } = await makeGroup(["Alice", "Bob"]);
    await addBill(gid, { amount: 1000, paidBy: ids.Alice, split: equal([ids.Alice, ids.Bob]) });
    const before = await call("GET", `/api/groups/${gid}/summary`);
    expect(before.json.settlements).toEqual([{ from: ids.Bob, to: ids.Alice, amount: 500 }]);
    const pay = await addBill(gid, { kind: "payment", description: "Settle", amount: 500, paidBy: ids.Bob, split: equal([ids.Alice]) });
    expect(pay.status).toBe(201);
    const after = await call("GET", `/api/groups/${gid}/summary`);
    expect(after.json.settlements).toEqual([]);
    expect(after.json.total).toBe(1000);
    for (const b of after.json.balances) expect(b.net).toBe(0);
  });

  it("empty group has zero balances", async () => {
    const { gid } = await makeGroup();
    const r = await call("GET", `/api/groups/${gid}/summary`);
    expect(r.json.total).toBe(0);
    expect(r.json.settlements).toEqual([]);
    expect(r.json.balances).toHaveLength(3);
  });
});

describe("not found and isolation", () => {
  it("404 for unknown and malformed group ids", async () => {
    for (const gid of ["A".repeat(22), "short", "A".repeat(23), "has%20space", "..%2F..%2Fetc"]) {
      for (const [m, p, b] of [
        ["GET", `/api/groups/${gid}`],
        ["PATCH", `/api/groups/${gid}`, { name: "x" }],
        ["GET", `/api/groups/${gid}/summary`],
        ["POST", `/api/groups/${gid}/members`, { name: "x" }],
      ] as [string, string, unknown?][]) {
        const r = await call(m, p, b);
        expect(r.status, `${m} ${p}`).toBe(404);
        expect(r.json.error.code).toBe("not_found");
      }
    }
  });

  it("404 for unknown bill id", async () => {
    const { gid } = await makeGroup();
    expect((await call("DELETE", `/api/groups/${gid}/bills/${"A".repeat(16)}`)).status).toBe(404);
    expect((await call("DELETE", `/api/groups/${gid}/bills/nope`)).status).toBe(404);
  });

  it("bill of group A is invisible under group B", async () => {
    const a = await makeGroup();
    const b = await makeGroup();
    const bill = await addBill(a.gid, { amount: 100, paidBy: a.ids.Alice, split: equal([a.ids.Alice]) });
    const bid = bill.json.bill.id;
    const body = { description: "x", amount: 100, paidBy: b.ids.Alice, date: DATE, split: equal([b.ids.Alice]) };
    expect((await call("PUT", `/api/groups/${b.gid}/bills/${bid}`, body)).status).toBe(404);
    expect((await call("DELETE", `/api/groups/${b.gid}/bills/${bid}`)).status).toBe(404);
    // untouched in A
    expect((await call("GET", `/api/groups/${a.gid}`)).json.bills).toHaveLength(1);
  });

  it("member of group B cannot be used in group A", async () => {
    const a = await makeGroup();
    const b = await makeGroup();
    const asPayer = await addBill(a.gid, { amount: 100, paidBy: b.ids.Alice, split: equal([a.ids.Alice]) });
    expect(asPayer.status).toBe(400);
    const inSplit = await addBill(a.gid, { amount: 100, paidBy: a.ids.Alice, split: equal([b.ids.Bob]) });
    expect(inSplit.status).toBe(400);
    const inExact = await addBill(a.gid, {
      amount: 100,
      paidBy: a.ids.Alice,
      split: { mode: "exact", shares: [{ memberId: b.ids.Bob, amount: 100 }] },
    });
    expect(inExact.status).toBe(400);
  });

  it("member of group B cannot be renamed or deleted via group A", async () => {
    const a = await makeGroup();
    const b = await makeGroup();
    expect((await call("PATCH", `/api/groups/${a.gid}/members/${b.ids.Alice}`, { name: "Hax" })).status).toBe(404);
    expect((await call("DELETE", `/api/groups/${a.gid}/members/${b.ids.Alice}`)).status).toBe(404);
    expect((await call("GET", `/api/groups/${b.gid}`)).json.members).toHaveLength(3);
  });

  it("unknown api path is JSON 404; wrong content type is 415", async () => {
    const r = await call("GET", "/api/nope");
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("not_found");
    const t = await call("POST", "/api/groups", "name=x", { "Content-Type": "text/plain" });
    expect(t.status).toBe(415);
  });
});
