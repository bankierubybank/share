import { afterAll, describe, expect, it } from "vitest";
import { api, cleanupGroups, makeGroup, today } from "../helpers/http";

afterAll(cleanupGroups);

describe("payments in summary", () => {
  it("count toward net only — paid/owed stay expense totals", async () => {
    const { gid, ids } = await makeGroup(["Ann", "Ben", "Cat"]);
    const post = (body: unknown) => api("POST", `/api/groups/${gid}/bills`, body);
    expect((await post({ description: "Hotel", amount: 9000, paidBy: ids.Ann, date: today(), split: { mode: "equal", members: [ids.Ann, ids.Ben, ids.Cat] } })).status).toBe(201);
    expect((await post({ kind: "payment", description: "Payment", amount: 3000, paidBy: ids.Ben, date: today(), split: { mode: "equal", members: [ids.Ann] } })).status).toBe(201);

    const s = (await api("GET", `/api/groups/${gid}/summary`)).json;
    const by = Object.fromEntries(s.balances.map((b: { memberId: string }) => [b.memberId, b]));
    expect(by[ids.Ann]).toEqual({ memberId: ids.Ann, paid: 9000, owed: 3000, net: 3000 });
    expect(by[ids.Ben]).toEqual({ memberId: ids.Ben, paid: 0, owed: 3000, net: 0 });
    expect(by[ids.Cat]).toEqual({ memberId: ids.Cat, paid: 0, owed: 3000, net: -3000 });
    expect(s.total).toBe(9000);
    expect(s.settlements).toEqual([{ from: ids.Cat, to: ids.Ann, amount: 3000 }]);
  });
});
