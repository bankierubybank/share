import { describe, expect, it } from "vitest";
import { ratePlan } from "../../src/lib/ratelimit";

describe("ratePlan", () => {
  it("people: keyed by identity; link limit on join/view routes only", () => {
    expect(ratePlan("ann@x.io", "1.2.3.4", "/api/join/abc", null, false)).toEqual({ key: "ann@x.io", link: true });
    expect(ratePlan("ann@x.io", "1.2.3.4", "/api/view/abc", null, false)).toEqual({ key: "ann@x.io", link: true });
    expect(ratePlan("ann@x.io", null, "/api/groups/abc/view-link", null, false)).toEqual({ key: "ann@x.io", link: false });
    expect(ratePlan("ann@x.io", null, "/api/groups", null, false)).toEqual({ key: "ann@x.io", link: false });
  });

  it("the opt-in header never lets a person skip limits or pick their own counter on prod", () => {
    expect(ratePlan("ann@x.io", null, "/api/join/abc", "mine", false)).toEqual({ key: "ann@x.io", link: true });
  });

  it("no identity: keyed by IP", () => {
    expect(ratePlan(null, "1.2.3.4", "/api/view/abc", null, false)).toEqual({ key: "ip:1.2.3.4", link: true });
    expect(ratePlan(null, null, "/api/health", null, false)).toEqual({ key: "ip:unknown", link: false });
  });

  it("service tokens: no limits unless a test opts in; then counted under their identity", () => {
    expect(ratePlan("svc:abc.access", null, "/api/view/abc", null, false)).toEqual({ key: null, link: false });
    expect(ratePlan("svc:abc.access", null, "/api/groups", null, false)).toEqual({ key: null, link: false });
    expect(ratePlan("svc:abc.access", null, "/api/view/abc", "gate", false)).toEqual({ key: "svc:abc.access", link: true });
    expect(ratePlan("svc:abc.access", null, "/api/groups", "gate", false)).toEqual({ key: "svc:abc.access", link: false });
  });

  it("dev mode: nothing unless opted in, then the test's own counter", () => {
    expect(ratePlan("dev@example.com", null, "/api/join/abc", null, true)).toEqual({ key: null, link: false });
    expect(ratePlan("dev@example.com", null, "/api/join/abc", "k1", true)).toEqual({ key: "test:k1", link: true });
    expect(ratePlan("dev@example.com", null, "/api/health", "k1", true)).toEqual({ key: "test:k1", link: false });
  });
});
