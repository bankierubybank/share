import { describe, expect, it } from "vitest";
import { actorLabel, devIdentity, identityFromClaims, DEV_DEFAULT_IDENTITY } from "../../src/lib/identity";

const req = (headers: Record<string, string>) => new Request("http://x/", { headers });

describe("identityFromClaims (verified Access JWT)", () => {
  it("email, lowercased", () => expect(identityFromClaims({ email: "Ann@Example.COM" })).toBe("ann@example.com"));
  it("service token → svc:<client id>", () => expect(identityFromClaims({ common_name: "abc123.access" })).toBe("svc:abc123.access"));
  it("email wins over common_name", () => expect(identityFromClaims({ email: "a@b.io", common_name: "x.access" })).toBe("a@b.io"));
  it("rejects odd shapes", () => {
    expect(identityFromClaims({})).toBeNull();
    expect(identityFromClaims({ email: "<script>@x.io" })).toBeNull();
    expect(identityFromClaims({ email: 42 })).toBeNull();
    expect(identityFromClaims({ common_name: "a b" })).toBeNull();
    expect(identityFromClaims({ common_name: "" })).toBeNull();
  });
});

describe("devIdentity (local only: DEV_IDENTITY=1)", () => {
  it("defaults when no header", () => expect(devIdentity(req({}))).toBe(DEV_DEFAULT_IDENTITY));
  it("uses the Access email header", () => expect(devIdentity(req({ "Cf-Access-Authenticated-User-Email": "Bob@X.io" }))).toBe("bob@x.io"));
  it("bad header → null (not the default)", () => expect(devIdentity(req({ "Cf-Access-Authenticated-User-Email": "<script>" }))).toBeNull());
});

describe("actorLabel", () => {
  it("hides service-token client ids", () => {
    expect(actorLabel("svc:abc.access")).toBe("service token");
    expect(actorLabel("a@b.io")).toBe("a@b.io");
    expect(actorLabel(null)).toBeNull();
  });
});
