// CSV export of a group's bills, balances and settlements.
import { CATEGORY_META } from "./categories";
import type { Bill, Group, Member, Summary } from "./api";
import { toInput } from "./money";
import { en } from "./i18n";

// Category may be an unknown string in old/foreign data: fall back to the raw value.
type ExportBill = Omit<Bill, "category"> & { category?: string };

/** Neutralize spreadsheet formula injection in user-supplied text. */
function safeText(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function field(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function row(cells: string[]): string {
  return cells.map(field).join(",");
}

export function billsToCsv(input: { group: Group; members: Member[]; bills: Bill[]; summary: Summary }): string {
  const { group, members, summary } = input;
  const cur = group.currency;
  const money = (n: number) => toInput(n, cur);
  const names = new Map(members.map((m) => [m.id, m.name]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const text = (s: string) => safeText(s);

  const lines: string[] = [];
  lines.push(
    row(["Date", "Type", "Category", "Description", "Amount", "Currency", "Paid by", ...members.map((m) => text(m.name))]),
  );
  for (const b of input.bills as ExportBill[]) {
    const paidBy = (b.payers?.length ?? 0) > 1
      ? b.payers.map((p) => `${nameOf(p.memberId)} ${money(p.amount)}`).join("; ")
      : nameOf(b.paidBy);
    const shares = new Map(b.shares.map((s) => [s.memberId, s.amount]));
    lines.push(
      row([
        b.date,
        b.kind === "payment" ? "Payment" : "Expense",
        text(b.kind === "payment" ? "" : (() => { const k = (CATEGORY_META as Record<string, { key: keyof typeof en }>)[b.category ?? ""]?.key; return k ? en[k] : b.category ?? ""; })()),
        text(b.description),
        money(b.amount),
        cur,
        text(paidBy),
        ...members.map((m) => money(shares.get(m.id) ?? 0)),
      ]),
    );
  }

  lines.push("");
  lines.push(row(["Balances"]));
  lines.push(row(["Member", "Paid", "Share", "Net"]));
  for (const bal of summary.balances) {
    lines.push(row([text(nameOf(bal.memberId)), money(bal.paid), money(bal.owed), money(bal.net)]));
  }

  lines.push("");
  lines.push(row(["Settlements"]));
  lines.push(row(["From", "To", "Amount"]));
  for (const s of summary.settlements) {
    lines.push(row([text(nameOf(s.from)), text(nameOf(s.to)), money(s.amount)]));
  }

  return "﻿" + lines.join("\r\n") + "\r\n";
}

export function downloadText(filename: string, text: string, mime = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000); // revoking at once can cancel the download
}

export function safeFilename(name: string): string {
  const s = name
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{M}\p{N}-]/gu, "")
    .slice(0, 60);
  return s || "group";
}
