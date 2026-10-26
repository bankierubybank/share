import { afterEach, describe, expect, it } from "vitest";
import { en, lang, locale, setLang, t, tn, th, type TKey } from "../../../web/src/i18n";

const keys = Object.keys(en) as TKey[];
const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

afterEach(() => setLang("en"));

describe("dictionaries", () => {
  it("th has exactly the keys of en", () => {
    expect(Object.keys(th).sort()).toEqual(Object.keys(en).sort());
  });

  it("no empty strings", () => {
    for (const k of keys) {
      expect(en[k].trim(), `en ${k}`).not.toBe("");
      expect(th[k].trim(), `th ${k}`).not.toBe("");
    }
  });

  it("every {param} in en appears in th for the same key (and vice versa)", () => {
    for (const k of keys) expect(params(th[k]), k).toEqual(params(en[k]));
  });

  it("plural keys come in .one/.other pairs", () => {
    for (const k of keys) {
      if (k.endsWith(".one")) expect(keys, k).toContain(k.replace(/\.one$/, ".other"));
      if (k.endsWith(".other")) expect(keys, k).toContain(k.replace(/\.other$/, ".one"));
    }
  });

  it("Thai pairs share the same text (no plural in Thai)", () => {
    for (const k of keys) if (k.endsWith(".one")) expect(th[k]).toBe(th[k.replace(/\.one$/, ".other") as TKey]);
  });

  it("th contains Thai script for user-facing labels", () => {
    for (const k of ["tab.bills", "tab.summary", "tab.members", "tab.activity", "summary.whoPays", "bill.add"] as TKey[])
      expect(th[k]).toMatch(/[฀-๿]/);
  });
});

describe("t()", () => {
  it("interpolates {name}", () => {
    setLang("en");
    expect(t("member.edit", { name: "Ann" })).toBe("Edit Ann");
    setLang("th");
    expect(t("member.edit", { name: "Ann" })).toBe("แก้ไข Ann");
  });

  it("interpolates numbers and several params", () => {
    setLang("en");
    expect(t("bill.err.sumPayers", { sum: 10, total: "12.00" })).toBe("Payers add up to 10, the bill is 12.00");
  });

  it("does not re-expand placeholders found in values", () => {
    setLang("en");
    expect(t("member.edit", { name: "{name}" })).toBe("Edit {name}");
    expect(t("member.edit", { name: "$&" })).toBe("Edit $&");
  });

  it("leaves unknown placeholders intact", () => {
    setLang("en");
    expect(t("member.edit")).toBe("Edit {name}");
  });

  it("returns the active language", () => {
    setLang("th");
    expect(t("tab.summary")).toBe("สรุป");
    setLang("en");
    expect(t("tab.summary")).toBe("Summary");
  });
});

describe("tn()", () => {
  it("picks one/other in English and passes n", () => {
    setLang("en");
    expect(tn("people", 1)).toBe("1 person");
    expect(tn("people", 0)).toBe("0 people");
    expect(tn("people", 2)).toBe("2 people");
    expect(tn("merge.done", 1)).toBe("Merged 1 bill");
    expect(tn("merge.done", 3)).toBe("Merged 3 bills");
  });

  it("uses the same text for one/other in Thai", () => {
    setLang("th");
    expect(tn("people", 1)).toBe("1 คน");
    expect(tn("people", 5)).toBe("5 คน");
  });
});

describe("lang()/locale()", () => {
  it("setLang switches lang() and locale()", () => {
    setLang("th");
    expect(lang()).toBe("th");
    expect(locale()).toBe("th-TH");
    setLang("en");
    expect(lang()).toBe("en");
    expect(locale()).toBeUndefined();
  });
});
