// Trip stats card (#11): computed client-side from the bills. Lazy-loaded with the summary.
import type { Bill, Member } from "../api";
import { h } from "../dom";
import { locale, t } from "../i18n";

export interface TripStats {
  days: number;
  total: number;
  perDay: number;
  perPersonPerDay: number;
  topPayer: { memberId: string; amount: number } | null;
  biggest: Bill | null;
  daily: { date: string; amount: number }[];
}

const dayMs = 86_400_000;
const toDay = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

export function computeStats(bills: Bill[], members: Member[]): TripStats | null {
  const expenses = bills.filter((b) => b.kind === "expense");
  if (!expenses.length) return null;
  const dates = expenses.map((b) => b.date).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const days = Math.round((toDay(last) - toDay(first)) / dayMs) + 1;
  const total = expenses.reduce((a, b) => a + b.amount, 0);
  const paid = new Map<string, number>();
  for (const b of expenses) for (const p of b.payers) paid.set(p.memberId, (paid.get(p.memberId) ?? 0) + p.amount);
  const top = [...paid].sort((a, b) => b[1] - a[1])[0];
  const byDay = new Map<string, number>();
  for (const b of expenses) byDay.set(b.date, (byDay.get(b.date) ?? 0) + b.amount);
  // Every day in the range (zero days included) so gaps are visible; cap at 62 bars.
  const daily: { date: string; amount: number }[] = [];
  for (let t = toDay(first); t <= toDay(last) && daily.length < 62; t += dayMs) {
    const d = new Date(t).toISOString().slice(0, 10);
    daily.push({ date: d, amount: byDay.get(d) ?? 0 });
  }
  return {
    days,
    total,
    perDay: Math.round(total / days),
    perPersonPerDay: members.length ? Math.round(total / days / members.length) : 0,
    topPayer: top ? { memberId: top[0], amount: top[1] } : null,
    biggest: expenses.reduce((a, b) => (b.amount > a.amount ? b : a)),
    daily,
  };
}

export function statsCard(s: TripStats, money: (n: number) => string, nameOf: (id: string) => string) {
  const max = Math.max(...s.daily.map((d) => d.amount), 1);
  const tile = (label: string, value: string, testid: string) =>
    h("div", { class: "stat-tile", dataset: { testid } },
      h("div", { class: "md-typescale-body-small muted" }, label),
      h("div", { class: "md-typescale-title-medium tabular" }, value));
  const fmtDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(locale(), { day: "numeric", month: "short" });
  return h("section", { class: "card flush", "aria-labelledby": "stats-title", dataset: { testid: "trip-stats" } },
    h("div", { class: "card-head" }, h("h2", { class: "md-typescale-title-medium", id: "stats-title" }, t("stats.title"))),
    h("div", { class: "stat-grid" },
      tile(t("stats.days"), String(s.days), "stat-days"),
      tile(t("stats.perDay"), money(s.perDay), "stat-per-day"),
      tile(t("stats.perPersonDay"), money(s.perPersonPerDay), "stat-ppd"),
      s.topPayer && tile(t("stats.paidMost"), `${nameOf(s.topPayer.memberId)} · ${money(s.topPayer.amount)}`, "stat-top"),
      s.biggest && tile(t("stats.biggest"), `${s.biggest.description} · ${money(s.biggest.amount)}`, "stat-biggest")),
    s.daily.length > 1 &&
      h("div", { class: "day-chart", role: "list", "aria-label": t("stats.chartAria"), dataset: { testid: "day-chart" } },
        s.daily.map((d) =>
          h("div", { class: "day-col", role: "listitem", title: `${fmtDay(d.date)}: ${money(d.amount)}`, "aria-label": `${fmtDay(d.date)}: ${money(d.amount)}` },
            h("div", { class: "day-bar-track", "aria-hidden": "true" },
              h("div", { class: "day-bar", style: `height:${d.amount ? Math.max(4, (d.amount / max) * 100) : 0}%` })),
            h("div", { class: "day-label md-typescale-label-small", "aria-hidden": "true" }, String(Number(d.date.slice(8, 10))))))));
}
