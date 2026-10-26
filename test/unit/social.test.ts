import { describe, expect, it } from "vitest";
import { matchMembersByName, parseComment, parseMove, parseSubgroup, remapSplit, SOCIAL_LIMITS } from "../../src/lib/social";
import { ValidationError } from "../../src/lib/validate";

const members = new Set(["m1", "m2", "m3"]);
const GID = "A".repeat(22);

describe("parseComment", () => {
  it("accepts a plain body and defaults the author to null", () => {
    expect(parseComment({ body: "hello" }, members)).toEqual({ body: "hello", authorMemberId: null });
  });

  it("trims surrounding whitespace", () => {
    expect(parseComment({ body: "  \n  hi there \t \n" }, members).body).toBe("hi there");
  });

  it("keeps single and double newlines, collapses 3+ newlines to a blank line", () => {
    expect(parseComment({ body: "a\nb" }, members).body).toBe("a\nb");
    expect(parseComment({ body: "a\n\nb" }, members).body).toBe("a\n\nb");
    expect(parseComment({ body: "a\n\n\n\n\nb" }, members).body).toBe("a\n\nb");
  });

  it("strips control characters except newline (tab, CR, NUL, ESC, DEL, VT, FF)", () => {
    expect(parseComment({ body: "a\u0000b\u0001c\u001bd\u007fe\tf\rg\u000bh\u000ci" }, members).body).toBe("abcdefghi");
    expect(parseComment({ body: "x\r\ny" }, members).body).toBe("x\ny");
  });

  it("keeps markup and unicode verbatim (escaping is the renderer's job)", () => {
    const s = "<b>สวัสดี</b> 😀 & \"q\" 'x'";
    expect(parseComment({ body: s }, members).body).toBe(s);
  });

  it("rejects empty and control-only bodies", () => {
    for (const b of ["", "   ", "\n\n", "\u0000\u0001", "\t\r"]) expect(() => parseComment({ body: b }, members), JSON.stringify(b)).toThrow(ValidationError);
  });

  it("enforces the 500 char cap after cleaning", () => {
    expect(parseComment({ body: "x".repeat(SOCIAL_LIMITS.commentMax) }, members).body).toHaveLength(500);
    expect(() => parseComment({ body: "x".repeat(501) }, members)).toThrow(ValidationError);
    // control chars and edge whitespace do not count towards the cap
    expect(parseComment({ body: `  ${"x".repeat(500)}\u0000  ` }, members).body).toHaveLength(500);
  });

  it("rejects non-object bodies and non-string text", () => {
    for (const v of [null, undefined, "str", 5, true, [], [{ body: "x" }], Symbol.for("invalid-json")]) expect(() => parseComment(v, members)).toThrow(ValidationError);
    for (const b of [undefined, null, 5, true, ["a"], { a: 1 }]) expect(() => parseComment({ body: b }, members), String(b)).toThrow(ValidationError);
  });

  it("accepts a known memberId (null/undefined = no author) and rejects unknown or mistyped ones", () => {
    expect(parseComment({ body: "x", memberId: "m2" }, members).authorMemberId).toBe("m2");
    expect(parseComment({ body: "x", memberId: null }, members).authorMemberId).toBeNull();
    expect(parseComment({ body: "x", memberId: undefined }, members).authorMemberId).toBeNull();
    for (const id of ["nope", "", 1, ["m1"], { id: "m1" }, true]) expect(() => parseComment({ body: "x", memberId: id }, members), String(id)).toThrow(ValidationError);
  });
});

describe("parseSubgroup", () => {
  it("accepts name + member ids and cleans the name", () => {
    expect(parseSubgroup({ name: "  The   Couple ", memberIds: ["m1", "m2"] }, members)).toEqual({ name: "The Couple", memberIds: ["m1", "m2"] });
  });

  it("name must be 1-40 chars", () => {
    expect(parseSubgroup({ name: "x".repeat(40), memberIds: ["m1"] }, members).name).toHaveLength(40);
    for (const n of ["", "   ", "x".repeat(41), 5, null, undefined]) expect(() => parseSubgroup({ name: n, memberIds: ["m1"] }, members), String(n)).toThrow(ValidationError);
  });

  it("memberIds must be a non-empty array of distinct known members", () => {
    for (const ids of [[], undefined, null, "m1", { 0: "m1" }, ["m1", "m1"], ["m1", "zzz"], [1], [null]]) {
      expect(() => parseSubgroup({ name: "g", memberIds: ids }, members), JSON.stringify(ids)).toThrow(ValidationError);
    }
  });

  it("rejects non-object bodies", () => {
    for (const v of [null, [], "x", 1]) expect(() => parseSubgroup(v, members)).toThrow(ValidationError);
  });
});

describe("parseMove", () => {
  it("accepts a 22-char group id for targetGroupId and sourceGroupId", () => {
    expect(parseMove({ targetGroupId: GID }, "targetGroupId")).toEqual({ groupId: GID, addMissingMembers: false });
    expect(parseMove({ sourceGroupId: GID, addMissingMembers: true }, "sourceGroupId")).toEqual({ groupId: GID, addMissingMembers: true });
    expect(parseMove({ targetGroupId: GID, addMissingMembers: false }, "targetGroupId").addMissingMembers).toBe(false);
  });

  it("uses the field it is asked for", () => {
    expect(() => parseMove({ sourceGroupId: GID }, "targetGroupId")).toThrow(ValidationError);
    expect(() => parseMove({ targetGroupId: GID }, "sourceGroupId")).toThrow(ValidationError);
  });

  it("rejects malformed ids", () => {
    for (const id of ["", "short", "A".repeat(21), "A".repeat(23), `${"A".repeat(21)}!`, `${"A".repeat(21)} `, 5, null, undefined, [GID], { id: GID }]) {
      expect(() => parseMove({ targetGroupId: id }, "targetGroupId"), String(id)).toThrow(ValidationError);
    }
  });

  it("addMissingMembers must be a boolean when present", () => {
    for (const v of ["true", 1, 0, null, {}, []]) expect(() => parseMove({ targetGroupId: GID, addMissingMembers: v }, "targetGroupId"), String(v)).toThrow(ValidationError);
  });

  it("rejects non-object bodies", () => {
    for (const v of [null, undefined, [], "x", 1]) expect(() => parseMove(v, "targetGroupId")).toThrow(ValidationError);
  });
});

describe("remapSplit", () => {
  const map = new Map([["a", "A"], ["b", "B"], ["c", "C"]]);

  it("equal", () => {
    expect(remapSplit({ mode: "equal", members: ["a", "b", "c"] }, map)).toEqual({ mode: "equal", members: ["A", "B", "C"] });
  });

  it("exact", () => {
    expect(remapSplit({ mode: "exact", shares: [{ memberId: "a", amount: 100 }, { memberId: "b", amount: 0 }] }, map)).toEqual({
      mode: "exact",
      shares: [{ memberId: "A", amount: 100 }, { memberId: "B", amount: 0 }],
    });
  });

  it("shares (weights)", () => {
    expect(remapSplit({ mode: "shares", weights: [{ memberId: "a", weight: 2 }, { memberId: "c", weight: 1 }] }, map)).toEqual({
      mode: "shares",
      weights: [{ memberId: "A", weight: 2 }, { memberId: "C", weight: 1 }],
    });
  });

  it("percent", () => {
    expect(remapSplit({ mode: "percent", percents: [{ memberId: "a", bp: 7000 }, { memberId: "b", bp: 3000 }] }, map)).toEqual({
      mode: "percent",
      percents: [{ memberId: "A", bp: 7000 }, { memberId: "B", bp: 3000 }],
    });
  });

  it("itemized keeps descriptions, amounts, service and tax; remaps item members", () => {
    const split = {
      mode: "itemized",
      serviceBp: 1000,
      taxBp: 700,
      items: [
        { description: "Steak", amount: 3000, members: ["a"] },
        { description: "Wine", amount: 3500, members: ["a", "b", "c"] },
      ],
    };
    expect(remapSplit(split, map)).toEqual({
      mode: "itemized",
      serviceBp: 1000,
      taxBp: 700,
      items: [
        { description: "Steak", amount: 3000, members: ["A"] },
        { description: "Wine", amount: 3500, members: ["A", "B", "C"] },
      ],
    });
  });

  it("does not mutate its input", () => {
    const split = { mode: "equal", members: ["a", "b"] };
    const copy = structuredClone(split);
    remapSplit(split, map);
    expect(split).toEqual(copy);
  });

  it("ids missing from the map are left as-is; empty map is identity", () => {
    expect(remapSplit({ mode: "equal", members: ["a", "zzz"] }, map)).toEqual({ mode: "equal", members: ["A", "zzz"] });
    const s = { mode: "exact", shares: [{ memberId: "a", amount: 5 }] };
    expect(remapSplit(s, new Map())).toEqual(s);
  });

  it("unknown mode is returned as a clone", () => {
    expect(remapSplit({ mode: "weird", foo: 1 }, map)).toEqual({ mode: "weird", foo: 1 });
  });
});

describe("matchMembersByName", () => {
  const target = [{ id: "T1", name: "alice" }, { id: "T2", name: "BOB" }, { id: "T3", name: "Dave" }];

  it("matches case-insensitively and reports missing names", () => {
    const needed = [{ id: "s1", name: "Alice" }, { id: "s2", name: "Bob" }, { id: "s3", name: "Carol" }];
    const r = matchMembersByName(needed, target);
    expect([...r.map]).toEqual([["s1", "T1"], ["s2", "T2"]]);
    expect(r.missing).toEqual([{ id: "s3", name: "Carol" }]);
  });

  it("all matched -> nothing missing", () => {
    const r = matchMembersByName([{ id: "s1", name: "DAVE" }], target);
    expect(r.map.get("s1")).toBe("T3");
    expect(r.missing).toEqual([]);
  });

  it("empty target list -> everything missing, order preserved", () => {
    const needed = [{ id: "s1", name: "Zed" }, { id: "s2", name: "Amy" }];
    const r = matchMembersByName(needed, []);
    expect(r.map.size).toBe(0);
    expect(r.missing).toEqual(needed);
  });

  it("nothing needed -> empty result", () => {
    const r = matchMembersByName([], target);
    expect(r.map.size).toBe(0);
    expect(r.missing).toEqual([]);
  });

  it("matches non-ASCII names case-insensitively", () => {
    const r = matchMembersByName([{ id: "s1", name: "ÉMILE" }], [{ id: "T", name: "émile" }]);
    expect(r.map.get("s1")).toBe("T");
  });

  it("does not trim or fuzzy-match", () => {
    const r = matchMembersByName([{ id: "s1", name: "alice " }, { id: "s2", name: "Ali" }], target);
    expect(r.map.size).toBe(0);
    expect(r.missing).toHaveLength(2);
  });
});
