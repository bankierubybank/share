import { exports } from "cloudflare:workers";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { materializeDue } from "../../src/routes";

// Regressions from the 2026-10-27 code review (docs/ISSUES.md #24–#27).

async function call(method: string, path: string, body?: unknown) {
  const res = await exports.default.fetch(
    new Request(`http://example.com${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined, text };
}

/** A streamed body with no Content-Length (chunked upload). */
function streamed(path: string, contentType: string, chunkBytes: number, chunks: number, first?: Uint8Array) {
  let sent = 0;
  return exports.default.fetch(
    new Request(`http://example.com${path}`, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: new ReadableStream({
        pull(c) {
          if (sent === 0 && first) c.enqueue(first);
          if (sent++ >= chunks) return c.close();
          c.enqueue(new Uint8Array(chunkBytes).fill(0x41));
        },
      }),
      // @ts-expect-error workerd accepts duplex for streaming request bodies
      duplex: "half",
    }),
  );
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function makeGroup() {
  const r = await call("POST", "/api/groups", { name: "Review", currency: "THB", members: ["Ann", "Ben"] });
  return { gid: r.json.group.id as string, ann: r.json.members[0].id as string, ben: r.json.members[1].id as string };
}

describe("bounded body reads without Content-Length", () => {
  it("chunked JSON over 32 KiB → 413", async () => {
    const { gid, ann } = await makeGroup();
    const bill = await call("POST", `/api/groups/${gid}/bills`, { description: "x", amount: 100, paidBy: ann, date: daysAgo(0), split: { mode: "equal", members: [ann] } });
    const res = await streamed(`/api/groups/${gid}/bills/${bill.json.bill.id}`, "application/json", 4096, 20);
    expect(res.status).toBe(413);
  });

  it("chunked receipt over 2 MiB → 413 (valid JPEG header, endless body)", async () => {
    const { gid, ann } = await makeGroup();
    const bill = await call("POST", `/api/groups/${gid}/bills`, { description: "x", amount: 100, paidBy: ann, date: daysAgo(0), split: { mode: "equal", members: [ann] } });
    const jpegHead = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const res = await streamed(`/api/groups/${gid}/bills/${bill.json.bill.id}/receipt`, "image/jpeg", 64 * 1024, 40, jpegHead);
    expect(res.status).toBe(413);
  });
});

describe("repeating bills can't run away", () => {
  it("startDate older than the backfill window → 400", async () => {
    const { gid, ann } = await makeGroup();
    const r = await call("POST", `/api/groups/${gid}/recurring`, {
      frequency: "weekly", startDate: "1990-01-01",
      bill: { description: "Rent", amount: 100, paidBy: ann, split: { mode: "equal", members: [ann] } },
    });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/within the last/);
  });

  it("stops (with lastError) when the group hits the bill cap", async () => {
    const { gid, ann } = await makeGroup();
    const rec = await call("POST", `/api/groups/${gid}/recurring`, {
      frequency: "weekly", startDate: daysAgo(1),
      bill: { description: "Gym", amount: 100, paidBy: ann, split: { mode: "equal", members: [ann] } },
    });
    expect(rec.status).toBe(201);
    // Fill the group to the 5000-bill cap directly, then make the recurrence due again.
    const stmts = [];
    for (let i = 0; i < 5000; i++)
      stmts.push(env.DB.prepare("INSERT INTO bills (id, group_id, kind, description, amount, paid_by, date, split_mode) VALUES (?, ?, 'expense', 'f', 1, ?, '2026-01-01', 'equal')")
        .bind(`fill${String(i).padStart(12, "0")}`, gid, ann));
    for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
    await env.DB.prepare("UPDATE recurrences SET next_date = ? WHERE group_id = ?").bind(daysAgo(0), gid).run();
    expect(await materializeDue(env, gid)).toBe(0);
    const r = await env.DB.prepare("SELECT active, last_error FROM recurrences WHERE group_id = ?").bind(gid).first<{ active: number; last_error: string }>();
    expect(r).toMatchObject({ active: 0, last_error: "group reached 5000 bills" });
  });

  it("creates the occurrences that still fit under the cap, then stops", async () => {
    const { gid, ann } = await makeGroup();
    const rec = await call("POST", `/api/groups/${gid}/recurring`, {
      frequency: "weekly", startDate: daysAgo(-7), // future: nothing created yet
      bill: { description: "Yoga", amount: 100, paidBy: ann, split: { mode: "equal", members: [ann] } },
    });
    expect(rec.json.created).toBe(0);
    const stmts = [];
    for (let i = 0; i < 4998; i++)
      stmts.push(env.DB.prepare("INSERT INTO bills (id, group_id, kind, description, amount, paid_by, date, split_mode) VALUES (?, ?, 'expense', 'f', 1, ?, '2026-01-01', 'equal')")
        .bind(`part${String(i).padStart(12, "0")}`, gid, ann));
    for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
    await env.DB.prepare("UPDATE recurrences SET next_date = ? WHERE group_id = ?").bind(daysAgo(14), gid).run(); // 3 due
    expect(await materializeDue(env, gid)).toBe(2);
    const n = await env.DB.prepare("SELECT count(*) n FROM bills WHERE group_id = ? AND description = 'Yoga'").bind(gid).first<{ n: number }>();
    expect(n?.n).toBe(2);
    const r = await env.DB.prepare("SELECT active FROM recurrences WHERE group_id = ?").bind(gid).first<{ active: number }>();
    expect(r?.active).toBe(0);
  });

  it("one batched claim: a second concurrent run creates nothing", async () => {
    const { gid, ann } = await makeGroup();
    const rec = await call("POST", `/api/groups/${gid}/recurring`, {
      frequency: "weekly", startDate: daysAgo(-7),
      bill: { description: "Swim", amount: 100, paidBy: ann, split: { mode: "equal", members: [ann] } },
    });
    expect(rec.status).toBe(201);
    await env.DB.prepare("UPDATE recurrences SET next_date = ? WHERE group_id = ?").bind(daysAgo(21), gid).run(); // 4 due
    const [a, b] = await Promise.all([materializeDue(env, gid), materializeDue(env, gid)]);
    expect(a + b).toBe(4);
    const n = await env.DB.prepare("SELECT count(*) n FROM bills WHERE group_id = ? AND description = 'Swim'").bind(gid).first<{ n: number }>();
    expect(n?.n).toBe(4);
  });
});
