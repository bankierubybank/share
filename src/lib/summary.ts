// Trip summary (balances, who pays whom, totals). Pure: the Worker serves it, and the web app recomputes it
// locally while a save is still on its way (optimistic UI) so the numbers never disagree.
import { computeBalances, computeSettlements, type Balance, type BillForBalance, type Settlement } from "./money";

export interface SummaryBill extends BillForBalance {
  kind: "expense" | "payment";
  category: string;
}

export interface Summary {
  balances: Balance[];
  settlements: Settlement[];
  total: number;
  byCategory: Record<string, number>;
}

export function summarize(memberIds: string[], bills: SummaryBill[]): Summary {
  const balances = computeBalances(memberIds, bills);
  const expenses = bills.filter((b) => b.kind === "expense");
  const byCategory: Record<string, number> = {};
  for (const b of expenses) byCategory[b.category] = (byCategory[b.category] ?? 0) + b.amount;
  const total = expenses.reduce((a, b) => a + b.amount, 0);
  return { balances, settlements: computeSettlements(balances), total, byCategory };
}
