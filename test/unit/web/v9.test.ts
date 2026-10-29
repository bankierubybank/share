import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { everyoneText, reminderText } from "../../../web/src/remind";
import { dequeue, enqueue, loadPage, queued, savePage, type Queued } from "../../../web/src/offline";
import { forgetGroup } from "../../../web/src/store";
import { layoutHeight } from "../../../web/src/summary-image";
import { setLang } from "../../../web/src/i18n";

function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0, m };
}

beforeEach(() => vi.stubGlobal("localStorage", fakeStorage()));
afterEach(() => {
  vi.unstubAllGlobals();
  setLang("en");
});

describe("reminders (#6)", () => {
  const debt = { from: "Ben", to: "Ann", amount: "฿150.00" };
  it("one person: who, how much, PromptPay when the payee has one, the trip link", () => {
    const text = reminderText("Phuket", debt, "0812345678", "https://x.test/g/abc");
    expect(text.split("\n")).toEqual(["Hi Ben! For “Phuket” you owe Ann ฿150.00.", "Ann's PromptPay: 0812345678", "https://x.test/g/abc"]);
    expect(reminderText("Phuket", debt, null, "u")).not.toContain("PromptPay");
  });
  it("everyone: one line per payment, in Thai too", () => {
    setLang("th");
    const text = everyoneText("ภูเก็ต", [debt, { from: "Cy", to: "Ann", amount: "฿20.00" }], "u");
    expect(text).toContain("• Ben โอนให้ Ann ฿150.00");
    expect(text).toContain("• Cy โอนให้ Ann ฿20.00");
    expect(text.split("\n")).toHaveLength(4);
  });
});

describe("offline store (#8)", () => {
  const q = (ref: string): Queued => ({ ref, input: { kind: "expense", description: ref, date: "2026-10-01", category: "food", split: { mode: "equal", members: ["m"] }, amount: 100, paidBy: "m" }, shown: { id: `tmp-${ref}` } as Queued["shown"], queuedAt: "2026-10-01T00:00:00Z" });

  it("queues per trip, keeps order, dequeues by ref", () => {
    expect(enqueue("g1", q("a"))).toBe(true);
    enqueue("g1", q("b"));
    enqueue("g2", q("c"));
    enqueue("g1", q("a")); // same ref again: replaced, not doubled
    expect(queued("g1").map((x) => x.ref)).toEqual(["b", "a"]);
    dequeue("g1", "b");
    dequeue("g1", "a");
    expect(queued("g1")).toEqual([]);
    expect(queued("g2")).toHaveLength(1);
  });

  it("broken storage reads as empty; full storage refuses to queue", () => {
    localStorage.setItem("share.outbox:g", "{not json");
    expect(queued("g")).toEqual([]);
    vi.stubGlobal("localStorage", { ...fakeStorage(), setItem: () => { throw new Error("QuotaExceededError"); } });
    expect(enqueue("g", q("x"))).toBe(false);
  });

  it("forgetting a trip removes its offline copy and queue", () => {
    savePage("g9", { hello: 1 });
    enqueue("g9", q("z"));
    expect(loadPage<{ hello: number }>("g9")?.page.hello).toBe(1);
    forgetGroup("g9");
    expect(loadPage("g9")).toBeNull();
    expect(queued("g9")).toEqual([]);
  });
});

describe("summary image (#10)", () => {
  it("grows with people and payments", () => {
    const base = { trip: "T", subtitle: "", budget: null, budgetUsed: null, balancesTitle: "", paysTitle: "", settled: "", footer: "" };
    const small = layoutHeight({ ...base, balances: [{ name: "A", text: "", tone: "zero" }], pays: [] });
    const big = layoutHeight({ ...base, balances: Array(6).fill({ name: "A", text: "", tone: "zero" }), pays: Array(5).fill({ text: "", amount: "" }) });
    expect(big - small).toBe((5 + 4) * 64);
    expect(layoutHeight({ ...base, budget: "x", budgetUsed: 0.5, balances: [], pays: [] }) - layoutHeight({ ...base, balances: [], pays: [] })).toBe(110);
  });
});
