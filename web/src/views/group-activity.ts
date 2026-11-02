// What an activity entry says, split out of group.ts (v0.12, #24). `money` formats in the trip's currency.
import type { Activity } from "../api";
import { t } from "../i18n";

export function describeActivity(a: Activity, money: (minor: number) => string): string {
  const d = (a.detail ?? {}) as Record<string, unknown>;
  const desc = typeof d.description === "string" ? `“${d.description}”` : "";
  const amt = typeof d.amount === "number" ? ` ${money(d.amount)}` : "";
  const nm = (k: string) => (typeof d[k] === "string" ? String(d[k]) : "");
  const dd = { desc, amt };
  switch (a.action) {
    case "group.create": return t("act.groupCreate");
    case "group.rename": return t("act.groupRename", { to: nm("to") });
    case "group.currency": return t("act.groupCurrency", { from: nm("from"), to: nm("to") });
    case "group.archive": return t("act.groupArchive");
    case "group.dates": return t("act.groupDates");
    case "category.add": return t("act.categoryAdd", { name: nm("name") });
    case "category.update": return t("act.categoryUpdate", { name: nm("name") });
    case "category.remove": return t("act.categoryRemove", { name: nm("name") });
    case "group.delete": return t("act.groupDelete");
    case "group.restore": return t("act.groupRestore");
    case "group.budget": return d.to ? t("act.groupBudget", { amount: money(Number(d.to)) }) : t("act.groupBudgetOff");
    case "group.unarchive": return t("act.groupUnarchive");
    case "member.add": return t("act.memberAdd", { name: nm("name") });
    case "member.rename": return t("act.memberRename", { from: nm("from"), to: nm("to") });
    case "member.promptpay": return t(d.set ? "act.promptpaySet" : "act.promptpayRemoved", { name: nm("name") });
    case "member.remove": return t("act.memberRemove", { name: nm("name") });
    case "member.email": return t(d.set ? "act.emailSet" : "act.emailRemoved", { name: nm("name") });
    case "member.link": return t("act.memberLink", { name: nm("name") });
    case "member.leave": return t("act.memberLeave", { name: nm("name") });
    case "member.join": return t(d.added ? "act.memberJoinNew" : "act.memberJoin", { name: nm("name") });
    case "invite.create": return t("act.inviteCreate");
    case "invite.revoke": return t("act.inviteRevoke");
    case "bill.create": return t(d.kind === "payment" ? "act.paymentCreate" : "act.billCreate", dd);
    case "bill.update": return t("act.billUpdate", dd);
    case "bill.delete": return t("act.billDelete", dd);
    case "bill.restore": return t("act.billRestore", dd);
    case "bill.recurring": return t("act.billRecurring", dd);
    case "receipt.add": return t("act.receiptAdd", { desc });
    case "receipt.remove": return t("act.receiptRemove", { desc });
    case "recurring.create": return t(d.frequency === "weekly" ? "act.recurringWeekly" : "act.recurringMonthly", { desc });
    case "recurring.stop": return t("act.recurringStop", { desc });
    case "comment.add": return t("act.commentAdd", { desc, excerpt: nm("excerpt") });
    case "viewlink.create": return t("act.viewCreate");
    case "viewlink.revoke": return t("act.viewRevoke");
    case "bill.moveOut": return t("act.moveOut", { ...dd, to: nm("to") });
    case "bill.moveIn": return t("act.moveIn", { ...dd, from: nm("from") });
    case "group.merge": return t("act.merge", { from: nm("from"), bills: String(d.bills ?? "") });
    default: return a.action;
  }
}
