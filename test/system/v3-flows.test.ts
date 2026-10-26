import { afterAll, describe, expect, it } from "vitest";
import { api, cleanupGroups, makeGroup, today } from "../helpers/http";

afterAll(cleanupGroups);

type Settlement = { from: string; to: string; amount: number };
type Summary = { balances: { memberId: string; paid: number; owed: number; net: number }[]; settlements: Settlement[]; total: number; byCategory: Record<string, number> };

const equal = (members: string[]) => ({ mode: "equal", members });

async function post(gid: string, body: Record<string, unknown>) {
  const r = await api("POST", `/api/groups/${gid}/bills`, { date: today(), ...body });
  expect(r.status, r.text).toBe(201);
  return r.json.bill as { id: string };
}

async function summary(gid: string) {
  const r = await api("GET", `/api/groups/${gid}/summary`);
  expect(r.status, r.text).toBe(200);
  return r.json as Summary;
}

const nets = (s: Summary) => Object.fromEntries(s.balances.map((b) => [b.memberId, b.net]));
/** Net flow each member gets from a settlement list (+ receives, - pays). */
function flows(list: Settlement[]) {
  const f: Record<string, number> = {};
  for (const s of list) {
    f[s.from] = (f[s.from] ?? 0) - s.amount;
    f[s.to] = (f[s.to] ?? 0) + s.amount;
  }
  return f;
}
const lowerNets = (s: Summary, ids: Record<string, string>) => {
  const byId = Object.fromEntries(Object.entries(ids).map(([n, i]) => [i, n.toLowerCase()]));
  return Object.fromEntries(s.balances.map((b) => [byId[b.memberId], b.net]));
};

describe("v3 trip planning: threads, subgroups, partial settle-up, move, merge, share link", () => {
  it("runs the whole story end to end", async () => {
    // ---- two trips. Trip B is written with different capitalisation and has no Dan yet.
    const A = await makeGroup(["Ann", "Ben", "Cat", "Dan"], "THB");
    const B = await makeGroup(["ann", "BEN", "Cat"], "THB");
    const a = A.ids;

    // ---- a saved "Couple" subgroup (Ben + Cat) is used for an equal split
    const sg = await api("POST", `/api/groups/${A.gid}/subgroups`, { name: "Couple", memberIds: [a.Ben, a.Cat] });
    expect(sg.status, sg.text).toBe(201);
    const couple: string[] = sg.json.subgroup.memberIds;
    expect(couple).toEqual([a.Ben, a.Cat]);

    // Ann pays 6000 for a tour; only the couple share it (3000 each).
    const tour = await post(A.gid, { description: "Couple tour", amount: 6000, paidBy: a.Ann, category: "activities", split: equal(couple) });
    // Dan pays the 12000 hotel for everybody (3000 each).
    const hotel = await post(A.gid, { description: "Hotel", amount: 12000, paidBy: a.Dan, category: "lodging", split: equal([a.Ann, a.Ben, a.Cat, a.Dan]) });

    // ---- comment thread on the tour
    const thread = [
      ["Who booked this?", a.Ben],
      ["I did, 6000 total", a.Ann],
      ["Can we split it between us two?\nThanks!", a.Cat],
    ] as const;
    for (const [body, memberId] of thread) {
      const r = await api("POST", `/api/groups/${A.gid}/bills/${tour.id}/comments`, { body, memberId });
      expect(r.status, r.text).toBe(201);
      // keep the server's millisecond clock moving so oldest-first order is unambiguous
      await new Promise((res) => setTimeout(res, 5));
    }
    const comments = (await api("GET", `/api/groups/${A.gid}/bills/${tour.id}/comments`)).json.comments as any[];
    expect(comments.map((c) => c.body)).toEqual(thread.map(([b]) => b));
    expect(comments.map((c) => c.authorMemberId)).toEqual(thread.map(([, m]) => m));
    const withCount = (await api("GET", `/api/groups/${A.gid}`)).json.bills as any[];
    expect(withCount.find((b) => b.id === tour.id).commentCount).toBe(3);
    expect(withCount.find((b) => b.id === hotel.id).commentCount).toBe(0);

    // ---- balances: Ann +3000, Ben -6000, Cat -6000, Dan +9000
    let s = await summary(A.gid);
    expect(nets(s)).toEqual({ [a.Ann]: 3000, [a.Ben]: -6000, [a.Cat]: -6000, [a.Dan]: 9000 });
    expect(s.total).toBe(18000);
    expect(flows(s.settlements)).toEqual({ [a.Ann]: 3000, [a.Ben]: -6000, [a.Cat]: -6000, [a.Dan]: 9000 });

    // ---- partial settle-up: Ben pays Dan 2000 of his 6000
    await post(A.gid, { kind: "payment", description: "Ben pays Dan", amount: 2000, paidBy: a.Ben, split: equal([a.Dan]) });
    s = await summary(A.gid);
    expect(nets(s)).toEqual({ [a.Ann]: 3000, [a.Ben]: -4000, [a.Cat]: -6000, [a.Dan]: 7000 });
    expect(s.total).toBe(18000); // payments are not expenses
    const remaining = s.settlements;
    expect(remaining.length).toBeGreaterThan(0);
    expect(flows(remaining)).toEqual({ [a.Ann]: 3000, [a.Ben]: -4000, [a.Cat]: -6000, [a.Dan]: 7000 });
    const paidBy = (id: string) => remaining.filter((x) => x.from === id).reduce((t, x) => t + x.amount, 0);
    expect(paidBy(a.Ben)).toBe(4000); // the remainder of Ben's debt is still suggested
    expect(paidBy(a.Cat)).toBe(6000);
    expect(remaining.every((x) => x.amount > 0 && x.from !== x.to)).toBe(true);
    // the payment must not have been applied to the wrong direction: Ben never receives money
    expect(remaining.some((x) => x.to === a.Ben)).toBe(false);

    // ---- a Chiang Mai bill was filed in Phuket by mistake -> move it to trip B
    const mis = await post(A.gid, { description: "Chiang Mai hostel", amount: 9000, paidBy: a.Ben, category: "lodging", split: equal([a.Ann, a.Ben, a.Cat]) });
    await api("POST", `/api/groups/${A.gid}/bills/${mis.id}/comments`, { body: "wrong trip, moving it", memberId: a.Cat });
    const netsBeforeMove = lowerNets(await summary(A.gid), a);

    const moved = await api("POST", `/api/groups/${A.gid}/bills/${mis.id}/move`, { targetGroupId: B.gid });
    expect(moved.status, moved.text).toBe(200);
    expect(moved.json.addedMembers).toEqual([]);
    const bIds = B.ids;
    expect(moved.json.bill.payers).toEqual([{ memberId: bIds.BEN, amount: 9000 }]);
    expect(moved.json.bill.shares.map((x: any) => x.memberId).sort()).toEqual([bIds.ann, bIds.BEN, bIds.Cat].sort());

    expect(((await api("GET", `/api/groups/${A.gid}`)).json.bills as any[]).some((b) => b.id === mis.id)).toBe(false);
    const bBills = (await api("GET", `/api/groups/${B.gid}`)).json.bills as any[];
    expect(bBills.map((b) => b.id)).toEqual([mis.id]);
    expect(bBills[0].commentCount).toBe(1);
    expect((await api("GET", `/api/groups/${B.gid}/bills/${mis.id}/comments`)).json.comments[0].body).toBe("wrong trip, moving it");
    expect((await api("GET", `/api/groups/${A.gid}/bills/${mis.id}/comments`)).status).toBe(404);

    // value conserved across the two trips, both balanced
    const netsA = lowerNets(await summary(A.gid), a);
    const netsB = lowerNets(await summary(B.gid), bIds);
    for (const n of ["ann", "ben", "cat"]) expect(netsA[n] + netsB[n], n).toBe(netsBeforeMove[n]);
    expect(netsB).toEqual({ ann: -3000, ben: 6000, cat: -3000 });

    // ---- a second mis-filed bill involves Dan, who is not in trip B: refuse, then add
    const dan = await post(A.gid, { description: "Chiang Mai dinner", amount: 4000, paidBy: a.Dan, split: equal([a.Dan, a.Cat]) });
    const refused = await api("POST", `/api/groups/${A.gid}/bills/${dan.id}/move`, { targetGroupId: B.gid });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatchObject({ code: "missing_members", missing: ["Dan"] });
    expect(((await api("GET", `/api/groups/${B.gid}`)).json.members as any[]).map((m) => m.name)).toEqual(["ann", "BEN", "Cat"]);
    const added = await api("POST", `/api/groups/${A.gid}/bills/${dan.id}/move`, { targetGroupId: B.gid, addMissingMembers: true });
    expect(added.status, added.text).toBe(200);
    expect(added.json.addedMembers).toEqual(["Dan"]);
    const bMembers = (await api("GET", `/api/groups/${B.gid}`)).json.members as { id: string; name: string }[];
    expect(bMembers.map((m) => m.name)).toEqual(["ann", "BEN", "Cat", "Dan"]);
    const bAll = Object.fromEntries(bMembers.map((m) => [m.name, m.id]));

    // ---- merge trip B into trip A
    const netsAPre = lowerNets(await summary(A.gid), a);
    const netsBPre = lowerNets(await summary(B.gid), bAll);
    const merged = await api("POST", `/api/groups/${A.gid}/merge`, { sourceGroupId: B.gid });
    expect(merged.status, merged.text).toBe(200);
    expect(merged.json).toEqual({ moved: 2, addedMembers: [], sourceArchived: true });
    expect((await api("GET", `/api/groups/${B.gid}`)).json.group.archived).toBe(true);
    expect(((await api("GET", `/api/groups/${B.gid}`)).json.bills as any[])).toEqual([]);
    expect((await api("POST", `/api/groups/${B.gid}/bills`, { description: "late", date: today(), amount: 1, paidBy: bAll.Cat, split: equal([bAll.Cat]) })).status).toBe(409);

    const aBills = (await api("GET", `/api/groups/${A.gid}`)).json.bills as any[];
    expect(aBills.map((b) => b.id)).toEqual(expect.arrayContaining([tour.id, hotel.id, mis.id, dan.id]));
    expect(aBills).toHaveLength(5);
    const finalSummary = await summary(A.gid);
    const finalNets = lowerNets(finalSummary, a);
    for (const n of ["ann", "ben", "cat", "dan"]) expect(finalNets[n], n).toBe((netsAPre[n] ?? 0) + (netsBPre[n] ?? 0));
    expect(Object.values(finalNets).reduce((x, y) => x + y, 0)).toBe(0);
    // the comment thread survived both hops
    expect((await api("GET", `/api/groups/${A.gid}/bills/${mis.id}/comments`)).json.comments).toHaveLength(1);
    expect((await api("GET", `/api/groups/${A.gid}/bills/${tour.id}/comments`)).json.comments).toHaveLength(3);

    // activity trail
    const acts = ((await api("GET", `/api/groups/${A.gid}/activity?limit=100`)).json.activity as { action: string }[]).map((x) => x.action);
    for (const want of ["comment.add", "bill.moveOut", "bill.moveIn", "group.merge"]) expect(acts, want).toContain(want);

    // ---- read-only link shows exactly what the group shows
    const vl = await api("POST", `/api/groups/${A.gid}/view-link`, {});
    expect(vl.status).toBe(201);
    const view = await api("GET", `/api/view/${vl.json.viewId}`);
    expect(view.status).toBe(200);
    expect(view.json.readOnly).toBe(true);
    expect(view.json.summary).toEqual(finalSummary);
    expect(view.json.bills.map((b: any) => b.id).sort()).toEqual(aBills.map((b) => b.id).sort());
    expect(view.json.members.map((m: any) => m.id).sort()).toEqual(Object.values(a).sort());
    expect(view.text).not.toContain(A.gid);
    const commentCounts = Object.fromEntries(view.json.bills.map((b: any) => [b.id, b.commentCount]));
    expect(commentCounts[tour.id]).toBe(3);

    // the viewer cannot change anything with that id
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await api(method, `/api/view/${vl.json.viewId}`, method === "DELETE" ? undefined : {});
      expect(r.status, method).toBeGreaterThanOrEqual(400);
    }
    expect((await api("GET", `/api/groups/${vl.json.viewId}`)).status).toBe(404);

    // owner revokes -> dead link
    expect((await api("DELETE", `/api/groups/${A.gid}/view-link`)).status).toBe(204);
    expect((await api("GET", `/api/view/${vl.json.viewId}`)).status).toBe(404);

    // everyone eventually settles: recording the suggested transfers zeroes the merged trip
    for (const t of finalSummary.settlements) {
      await post(A.gid, { kind: "payment", description: "settle", amount: t.amount, paidBy: t.from, split: equal([t.to]) });
    }
    const settled = await summary(A.gid);
    expect(settled.balances.every((b) => b.net === 0)).toBe(true);
    expect(settled.settlements).toEqual([]);
  });
});

describe("v3 view link vs live group", () => {
  it("a link created earlier keeps following the group: new bills, comments and deletes show up; rotate kills the old link", async () => {
    const { gid, ids } = await makeGroup(["Pim", "Noi"], "THB");
    const v1 = (await api("POST", `/api/groups/${gid}/view-link`, {})).json.viewId as string;
    const first = await post(gid, { description: "Noodles", amount: 300, paidBy: ids.Pim, split: equal([ids.Pim, ids.Noi]) });
    let v = (await api("GET", `/api/view/${v1}`)).json;
    expect(v.bills.map((b: any) => b.id)).toEqual([first.id]);
    expect(v.summary).toEqual(await summary(gid));
    await api("POST", `/api/groups/${gid}/bills/${first.id}/comments`, { body: "yum" });
    v = (await api("GET", `/api/view/${v1}`)).json;
    expect(v.bills[0].commentCount).toBe(1);
    await api("DELETE", `/api/groups/${gid}/bills/${first.id}`);
    v = (await api("GET", `/api/view/${v1}`)).json;
    expect(v.bills).toEqual([]);
    expect(v.summary.total).toBe(0);

    const v2 = (await api("POST", `/api/groups/${gid}/view-link`, {})).json.viewId as string;
    expect(v2).not.toBe(v1);
    expect((await api("GET", `/api/view/${v1}`)).status).toBe(404);
    expect((await api("GET", `/api/view/${v2}`)).status).toBe(200);
  });
});
