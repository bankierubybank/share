import { afterAll, describe, expect, it } from "vitest";
import { api, BASE_URL, cleanupGroups, makeGroup } from "../helpers/http";

// v0.12: favourite bills (#4) and leave trip (#6). A favourite is checked like a bill (only this trip's people and
// categories); leaving is a write like any other (JSON only, members only).

afterAll(cleanupGroups);

const remote = !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE_URL);
const as = (email: string) => ({ "Cf-Access-Authenticated-User-Email": email });
const body = (paidBy: string, members: string[]) =>
  ({ description: "Rent", amount: 9000, paidBy, category: "lodging", split: { mode: "equal", members } });

describe("favourites (any target)", () => {
  it("another trip's people or categories are refused; junk ids never 2xx/5xx", async () => {
    const a = await makeGroup(["Ann", "Ben"]);
    const b = await makeGroup(["Cat", "Dan"]);
    const foreign = await api("POST", `/api/groups/${a.gid}/templates`, { name: "X", bill: body(b.ids.Cat, [b.ids.Cat, b.ids.Dan]) });
    expect(foreign.status, foreign.text).toBe(400);
    const cat = await api("POST", `/api/groups/${a.gid}/templates`, { name: "Y", bill: { ...body(a.ids.Ann, [a.ids.Ann]), category: "c:AAAAAAAAAAAAAAAA" } });
    expect(cat.status, cat.text).toBe(400);
    for (const p of ["x", "%00", "AAAAAAAAAAAAAAAA", "' OR 1=1 --", "A".repeat(200)]) {
      const r = await api("DELETE", `/api/groups/${a.gid}/templates/${p}`);
      expect([p, r.status < 500 && !(r.status >= 200 && r.status < 300)]).toEqual([p, true]);
    }
  });

  it("a favourite's name is stored as text, never interpreted; oversize names refused", async () => {
    const g = await makeGroup(["Ann", "Ben"]);
    const name = `<img src=x onerror=alert(1)>`;
    const r = await api("POST", `/api/groups/${g.gid}/templates`, { name, bill: body(g.ids.Ann, [g.ids.Ann, g.ids.Ben]) });
    expect(r.status, r.text).toBe(201);
    expect(r.json.template.name).toBe(name);
    expect((await api("POST", `/api/groups/${g.gid}/templates`, { name: "N".repeat(41), bill: body(g.ids.Ann, [g.ids.Ann]) })).status).toBe(400);
  });

  it("leave is CSRF-guarded like every write (JSON only)", async () => {
    const g = await makeGroup(["Ann", "Ben"]);
    const r = await api("POST", `/api/groups/${g.gid}/leave`, "x=1", { "Content-Type": "application/x-www-form-urlencoded" });
    expect(r.status).toBe(415);
  });
});

describe.skipIf(remote)("favourites + leave: outsiders (local: header identities)", () => {
  it("someone not in the trip can't list, add, delete favourites or leave", async () => {
    const g = await makeGroup(["Ann", "Ben"]);
    const tpl = await api("POST", `/api/groups/${g.gid}/templates`, { name: "Rent", bill: body(g.ids.Ann, [g.ids.Ann, g.ids.Ben]) });
    expect(tpl.status, tpl.text).toBe(201);
    const out = as("outsider12@x.io");
    expect((await api("GET", `/api/groups/${g.gid}/templates`, undefined, out)).status).toBe(403);
    expect((await api("POST", `/api/groups/${g.gid}/templates`, { name: "Z", bill: body(g.ids.Ann, [g.ids.Ann]) }, out)).status).toBe(403);
    expect((await api("DELETE", `/api/groups/${g.gid}/templates/${tpl.json.template.id}`, undefined, out)).status).toBe(403);
    expect((await api("POST", `/api/groups/${g.gid}/leave`, {}, out)).status).toBe(403);
    const full = await api("GET", `/api/groups/${g.gid}/full`, undefined, out);
    expect(full.text).not.toContain("Rent");
  });
});
