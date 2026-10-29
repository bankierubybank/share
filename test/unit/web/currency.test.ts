import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCurrency, formatMoney, rememberCurrency } from "../../../web/src/money";
import { setLang } from "../../../web/src/i18n";

// #24: new-trip currency = last used, else THB for anything Thai, else browser region, else USD.

function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 };
}

function env(languages: string[], timeZone: string) {
  vi.stubGlobal("navigator", { language: languages[0], languages });
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...real.call(this), timeZone };
  });
}

beforeEach(() => vi.stubGlobal("localStorage", fakeStorage()));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setLang("en");
});

describe("defaultCurrency", () => {
  it("English browser on a Bangkok clock → THB (used to be USD)", () => {
    env(["en-US"], "Asia/Bangkok");
    expect(defaultCurrency()).toBe("THB");
  });
  it("any Thai browser language → THB", () => {
    env(["en-GB", "th-TH"], "Europe/London");
    expect(defaultCurrency()).toBe("THB");
  });
  it("otherwise the browser region", () => {
    env(["ja-JP"], "Asia/Tokyo");
    expect(defaultCurrency()).toBe("JPY");
    env(["en-US"], "America/New_York");
    expect(defaultCurrency()).toBe("USD");
  });
  it("the last trip's currency wins over everything", () => {
    env(["th-TH"], "Asia/Bangkok");
    rememberCurrency("EUR");
    expect(defaultCurrency()).toBe("EUR");
  });
  it("ignores a remembered value that isn't a supported currency", () => {
    env(["en-US"], "America/New_York");
    rememberCurrency("XYZ");
    expect(defaultCurrency()).toBe("USD");
  });
});

describe("formatMoney", () => {
  it("narrow symbol for the trip currency, code when asked (fx)", () => {
    expect(formatMoney(123450, "THB")).toBe("฿1,234.50");
    expect(formatMoney(1200, "USD", "code")).toMatch(/^USD\s12\.00$/); // \s: Intl puts a no-break space there
  });
});
