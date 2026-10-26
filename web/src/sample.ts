// Onboarding (#17): creates a small, realistic sample trip so first-time users can explore.
import { api } from "./api";
import { defaultCurrency, fractionDigits } from "./money";
import { t } from "./i18n";

const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Amounts below are in whole units of the currency; scaled to minor units here. */
export async function createSampleGroup(): Promise<string> {
  const currency = defaultCurrency();
  const k = 10 ** fractionDigits(currency);
  const scale = currency === "THB" ? 1 : currency === "JPY" || currency === "KRW" || currency === "IDR" || currency === "VND" ? 4 : 0.03;
  const amt = (thb: number) => Math.max(1, Math.round(thb * scale)) * k;
  const { group, members } = await api.createGroup(t("sample.group"), currency, [t("sample.you"), "Alex", "Sam"]);
  const [you, alex, sam] = members.map((m) => m.id);
  const all = [you, alex, sam];
  await api.createBill(group.id, { kind: "expense", description: t("sample.hotel"), amount: amt(4800), paidBy: you, date: daysAgo(2), category: "lodging", split: { mode: "equal", members: all } });
  await api.createBill(group.id, { kind: "expense", description: t("sample.dinner"), amount: amt(1650), paidBy: alex, date: daysAgo(1), category: "food", split: { mode: "equal", members: all } });
  await api.createBill(group.id, { kind: "expense", description: t("sample.boat"), amount: amt(1200), paidBy: sam, date: daysAgo(1), category: "activities", split: { mode: "equal", members: [you, sam] } });
  await api.createBill(group.id, { kind: "expense", description: t("sample.taxi"), amount: amt(600), paidBy: you, date: daysAgo(0), category: "transport", split: { mode: "equal", members: all } });
  return group.id;
}
