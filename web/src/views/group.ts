import { api, ApiError, type Activity, type Bill, type Category, type Group, type Member, type Recurrence, type Summary } from "../api";
import { clear, h, icon, snackbar } from "../dom";
import { confirmDialog, openDialog, type MdDialog } from "../dialogs";
import { CURRENCIES, formatMoney } from "../money";
import { CATEGORY_META, CATEGORY_ORDER } from "../categories";
import { forgetGroup, rememberGroup } from "../store";
import { navigate } from "../router";
import { openBillDialog } from "./bill-dialog";
import { billsToCsv, downloadText, safeFilename } from "../export";
import { currentTheme, setTheme, type Theme } from "../theme";

type Tab = "bills" | "summary" | "members" | "activity";
const TABS: Tab[] = ["bills", "summary", "members", "activity"];
type Field = HTMLElement & { value: string; error: boolean; errorText: string; focus(): void };

interface State {
  group: Group;
  members: Member[];
  bills: Bill[];
  summary: Summary;
  recurring: Recurrence[];
  activity: Activity[];
}

export async function renderGroup(root: HTMLElement, gid: string) {
  let tab: Tab = (session.get(`tab:${gid}`) as Tab) || "bills";
  if (!TABS.includes(tab)) tab = "bills";
  let viewAs: string | null = local.get(`share.viewAs:${gid}`);
  let query = "";
  let catFilter: Category | null = null;
  let onlyMine = false;
  let state: State;

  clear(root, appBar("Loading…"), h("main", { class: "page center", "aria-busy": "true" }, h("md-circular-progress", { indeterminate: true, "aria-label": "Loading" })));

  async function load(): Promise<boolean> {
    try {
      const [g, summary, rec, act] = await Promise.all([api.getGroup(gid), api.summary(gid), api.recurring(gid), api.activity(gid)]);
      state = { ...g, summary, recurring: rec.recurring, activity: act.activity };
      if (viewAs && !state.members.some((m) => m.id === viewAs)) viewAs = null;
      rememberGroup(g.group);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        forgetGroup(gid);
        clear(root, appBar("Not found"),
          h("main", { class: "page center stack", dataset: { testid: "group-not-found" } },
            icon("search_off"),
            h("p", { class: "md-typescale-body-large" }, "This group doesn't exist or the link is wrong."),
            h("md-filled-button", { onclick: () => navigate("/") }, "Go home")));
      } else {
        clear(root, appBar("Error"),
          h("main", { class: "page center stack" },
            icon("cloud_off"),
            h("p", { class: "md-typescale-body-large", role: "alert" }, err instanceof Error ? err.message : "Something went wrong"),
            h("md-filled-button", { onclick: () => renderGroup(root, gid) }, "Retry")));
      }
      return false;
    }
  }

  async function refresh() {
    if (await load()) render();
  }

  const memberName = (id: string) => state.members.find((m) => m.id === id)?.name ?? "Removed";
  const money = (n: number) => formatMoney(n, state.group.currency);
  const readOnly = () => state.group.archived;

  function appBar(title: string, actions: Node[] = []) {
    return h("header", { class: "top-app-bar" },
      h("md-icon-button", { "aria-label": "Back to home", onclick: () => navigate("/"), dataset: { testid: "nav-home" } }, icon("arrow_back")),
      h("h1", { class: "md-typescale-title-large title", dataset: { testid: "group-title" } }, title),
      h("div", { class: "actions" }, actions));
  }

  // ---------- actions ----------

  async function share() {
    const url = location.href;
    try {
      if (navigator.share) return void (await navigator.share({ title: state.group.name, url }));
    } catch {
      /* cancelled → copy */
    }
    try {
      await navigator.clipboard.writeText(url);
      snackbar("Link copied — send it to your group");
    } catch {
      snackbar(url);
    }
  }

  function exportCsv() {
    downloadText(`${safeFilename(state.group.name)}-${new Date().toISOString().slice(0, 10)}.csv`, billsToCsv(state));
    snackbar("CSV downloaded");
  }

  function printPdf() {
    document.body.classList.add("printing");
    const done = () => document.body.classList.remove("printing");
    window.addEventListener("afterprint", done, { once: true });
    window.print();
    setTimeout(done, 1000);
  }

  function overflowMenu() {
    const anchorId = "group-more";
    const btn = h("md-icon-button", { id: anchorId, "aria-label": "More actions", "aria-haspopup": "menu", dataset: { testid: "group-more" } }, icon("more_vert"));
    const themeLabel: Record<Theme, string> = { system: "Theme: system", light: "Theme: light", dark: "Theme: dark" };
    const next: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
    const item = (label: string, ic: Parameters<typeof icon>[0], testid: string, run: () => void) =>
      h("md-menu-item", { dataset: { testid }, onclick: run }, h("div", { slot: "headline" }, label), icon(ic, "start"));
    const menu = h("md-menu", { anchor: anchorId, positioning: "fixed", quick: true, dataset: { testid: "group-menu" } },
      item("Export CSV", "table_view", "export-csv", exportCsv),
      item("Print / save as PDF", "print", "export-print", printPdf),
      item(themeLabel[currentTheme()] + " — change", currentTheme() === "dark" ? "dark_mode" : currentTheme() === "light" ? "light_mode" : "contrast", "theme-toggle",
        () => { setTheme(next[currentTheme()]); snackbar(themeLabel[currentTheme()]); }),
      item("Group settings", "settings", "group-settings", editGroup),
    ) as HTMLElement & { open: boolean; show(): void; close(): void };
    // `quick`: md-menu's close animation computed scale(Infinity) here and never finished, leaving the menu
    // stuck (open=false but painted) so it could not reopen. No animation = reliable.
    btn.addEventListener("click", () => (menu.open ? menu.close() : menu.show()));
    return [btn, menu];
  }

  async function editGroup() {
    const name = h("md-outlined-text-field", { label: "Group name", value: state.group.name, maxLength: 60, dataset: { testid: "edit-group-name" } }) as Field;
    const cur = h("md-outlined-select", { quick: true, label: "Currency" },
      CURRENCIES.map((c) => h("md-select-option", { value: c, selected: c === state.group.currency }, h("div", { slot: "headline" }, c)))) as HTMLElement & { value: string };
    const err = h("div", { class: "form-error", role: "alert" });
    const archived = state.group.archived;
    const d = h("md-dialog", { dataset: { testid: "settings-dialog" } },
      h("div", { slot: "headline" }, "Group settings"),
      h("div", { slot: "content", class: "stack" },
        !archived && name, !archived && cur,
        !archived && h("p", { class: "md-typescale-body-small muted" }, "Changing currency does not convert existing amounts."),
        h("div", { class: "danger-zone stack-sm" },
          h("h2", { class: "md-typescale-title-small" }, archived ? "This group is archived" : "Finished with this group?"),
          h("p", { class: "md-typescale-body-small muted" }, archived ? "Unarchive to add or change bills again." : "Archiving makes it read-only and moves it down your list. Nothing is deleted."),
          h("div", { class: "row wrap" },
            h("md-outlined-button", { dataset: { testid: archived ? "unarchive-group" : "archive-group" }, onclick: async () => {
              try {
                await api.updateGroup(gid, { archived: !archived });
                snackbar(archived ? "Group unarchived" : "Group archived");
                d.close("ok");
              } catch (e) {
                err.textContent = e instanceof Error ? e.message : "Could not update";
              }
            } }, icon(archived ? "unarchive" : "archive", "icon"), archived ? "Unarchive" : "Archive"),
            h("md-text-button", { class: "danger", dataset: { testid: "delete-group" }, onclick: async () => { d.close("cancel"); await deleteGroupFlow(); } },
              icon("delete_forever", "icon"), "Delete group…"))),
        err),
      h("div", { slot: "actions" },
        h("md-text-button", { onclick: () => d.close("cancel") }, archived ? "Close" : "Cancel"),
        !archived && h("md-filled-button", { dataset: { testid: "edit-group-save" }, onclick: async () => {
          try {
            await api.updateGroup(gid, { name: name.value, currency: cur.value });
            d.close("ok");
          } catch (e) {
            err.textContent = e instanceof Error ? e.message : "Could not save";
          }
        } }, "Save")),
    ) as MdDialog;
    if ((await openDialog(d)) === "ok") refresh();
  }

  async function deleteGroupFlow() {
    const field = h("md-outlined-text-field", { label: "Type the group name to confirm", dataset: { testid: "delete-confirm-input" } }) as Field;
    const btn = h("md-filled-button", { class: "danger-filled", disabled: true, dataset: { testid: "delete-confirm" } }, "Delete forever") as HTMLElement & { disabled: boolean };
    field.addEventListener("input", () => (btn.disabled = field.value.trim() !== state.group.name));
    const d = h("md-dialog", { type: "alert", dataset: { testid: "delete-dialog" } },
      h("div", { slot: "headline" }, `Delete “${state.group.name}”?`),
      h("div", { slot: "content", class: "stack" },
        h("p", { class: "md-typescale-body-medium" }, "All bills, people, receipts and history are deleted for everyone with the link. This can't be undone."),
        field),
      h("div", { slot: "actions" }, h("md-text-button", { onclick: () => d.close("cancel") }, "Cancel"), btn)) as MdDialog;
    btn.addEventListener("click", async () => {
      try {
        await api.deleteGroup(gid);
        d.close("ok");
      } catch (e) {
        snackbar(e instanceof Error ? e.message : "Could not delete");
      }
    });
    if ((await openDialog(d)) === "ok") {
      forgetGroup(gid);
      snackbar("Group deleted");
      navigate("/", true);
    }
  }

  const billOpts = () => ({ group: state.group, members: state.members, bills: state.bills, viewAs, onDeleted: undoable });

  async function addBill(payment?: { from: string; to: string; amount: number }) {
    if (readOnly()) return snackbar("This group is archived");
    if (!state.members.length) return snackbar("Add people first");
    if (await openBillDialog({ ...billOpts(), payment })) refresh();
  }

  async function editBill(bill: Bill) {
    if (readOnly()) return snackbar("This group is archived — unarchive it in settings to edit");
    if (await openBillDialog({ ...billOpts(), bill })) refresh();
  }

  function undoable(bill: Bill) {
    snackbar(`“${bill.description}” deleted`, {
      label: "Undo",
      run: async () => {
        try {
          await api.restoreBill(gid, bill.id);
          snackbar("Bill restored");
          refresh();
        } catch (e) {
          snackbar(e instanceof Error ? e.message : "Could not restore");
        }
      },
    });
  }

  async function editMember(m: Member | null) {
    const name = h("md-outlined-text-field", { label: "Name", value: m?.name ?? "", maxLength: 60, required: true, dataset: { testid: "member-name-input" } }) as Field;
    const pp = h("md-outlined-text-field", {
      label: "PromptPay (optional)", value: m?.promptpay ?? "", inputMode: "numeric",
      supportingText: "Mobile number or national ID — shows a QR when someone settles up in THB",
      dataset: { testid: "member-promptpay-input" },
    }) as Field;
    const save = async () => {
      name.error = pp.error = false;
      try {
        if (m) await api.updateMember(gid, m.id, { name: name.value, promptpay: pp.value.trim() || null });
        else await api.addMember(gid, name.value, pp.value.trim() || null);
        d.close("ok");
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Could not save";
        const f = /promptpay/i.test(msg) ? pp : name;
        f.error = true;
        f.errorText = /promptpay/i.test(msg) ? "Use a 10-digit mobile or 13-digit ID" : msg;
      }
    };
    const d = h("md-dialog", { dataset: { testid: "member-dialog" } },
      h("div", { slot: "headline" }, m ? `Edit ${m.name}` : "Add person"),
      h("form", { slot: "content", class: "stack", onsubmit: (e: Event) => { e.preventDefault(); save(); } }, name, pp),
      h("div", { slot: "actions" }, h("md-text-button", { onclick: () => d.close("cancel") }, "Cancel"),
        h("md-filled-button", { onclick: save, dataset: { testid: "member-save" } }, "Save"))) as MdDialog;
    d.addEventListener("opened", () => name.focus(), { once: true });
    if ((await openDialog(d)) === "ok") refresh();
  }

  async function showRecurring() {
    const list = h("md-list", { dataset: { testid: "recurring-list" } },
      state.recurring.map((r) => h("md-list-item", { dataset: { testid: "recurring-item" } },
        icon("repeat", "start"),
        h("div", { slot: "headline" }, String(r.template.description)),
        h("div", { slot: "supporting-text" },
          `${r.frequency === "monthly" ? "Monthly" : "Weekly"} · ${r.template.amount !== undefined ? money(r.template.amount) : ""}`,
          r.active ? ` · next ${formatDate(r.nextDate)}` : r.lastError ? ` · stopped: ${r.lastError}` : " · stopped"),
        r.active && !readOnly() && h("md-text-button", { slot: "end", dataset: { testid: "recurring-stop" }, onclick: async () => {
          if (!(await confirmDialog("Stop repeating?", "Bills already added stay. No new ones will be created.", "Stop"))) return;
          await api.stopRecurring(gid, r.id);
          d.close("ok");
        } }, "Stop"))));
    const d = h("md-dialog", { dataset: { testid: "recurring-dialog" } },
      h("div", { slot: "headline" }, "Repeating bills"),
      h("div", { slot: "content" }, state.recurring.length ? list : h("p", null, "No repeating bills. Choose “Repeat” under More options when adding a bill.")),
      h("div", { slot: "actions" }, h("md-text-button", { onclick: () => d.close("cancel") }, "Close"))) as MdDialog;
    if ((await openDialog(d)) === "ok") refresh();
  }

  // ---------- panels ----------

  const addBillButton = () =>
    h("md-filled-button", { class: "wide-only", disabled: readOnly(), onclick: () => addBill(), dataset: { testid: "add-bill" } }, icon("add", "icon"), "Add bill");

  const involves = (b: Bill, id: string) => b.payers.some((p) => p.memberId === id) || b.shares.some((s) => s.memberId === id);

  function filteredBills() {
    const q = query.trim().toLowerCase();
    return state.bills.filter((b) =>
      (!q || b.description.toLowerCase().includes(q) || b.payers.some((p) => memberName(p.memberId).toLowerCase().includes(q))) &&
      (!catFilter || b.category === catFilter) &&
      (!onlyMine || !viewAs || involves(b, viewAs)));
  }

  function billsPanel() {
    const { bills, summary } = state;
    const head = h("div", { class: "card-head" },
      h("h2", { class: "md-typescale-title-medium" }, "Bills"),
      h("span", { class: "md-typescale-body-medium muted grow-text", dataset: { testid: "total-spent" } }, `Total ${money(summary.total)}`),
      addBillButton());
    if (!bills.length)
      return h("section", { class: "card empty", dataset: { testid: "bills-empty" }, "aria-label": "Bills" },
        icon("receipt_long"),
        h("p", { class: "md-typescale-body-large" }, "No bills yet"),
        h("p", { class: "md-typescale-body-medium muted" }, readOnly() ? "This group is archived." : "Add the first one with Add bill."),
        addBillButton(),
        state.recurring.some((r) => r.active) && h("md-text-button", { onclick: showRecurring }, icon("repeat", "icon"), "Repeating bills"));

    const listHost = h("div", { "aria-live": "polite" });
    const search = h("md-outlined-text-field", {
      class: "search-field", type: "search", label: "Search bills", value: query, dataset: { testid: "bill-search" },
      oninput: (e: Event) => { query = (e.target as Field).value; renderList(); },
    });
    search.prepend(icon("search", "leading-icon"));
    const usedCats = CATEGORY_ORDER.filter((c) => bills.some((b) => b.category === c));
    const catChips = h("md-chip-set", { class: "chip-scroll", "aria-label": "Filter by category" },
      viewAs && (() => {
        const c = h("md-filter-chip", { label: `Only ${memberName(viewAs)}`, selected: onlyMine, dataset: { testid: "filter-mine" } }) as HTMLElement & { selected: boolean };
        c.addEventListener("click", (e) => { e.preventDefault(); onlyMine = !onlyMine; c.selected = onlyMine; renderList(); });
        return c;
      })(),
      usedCats.length > 1 && usedCats.map((cat) => {
        const c = h("md-filter-chip", { label: CATEGORY_META[cat].label, selected: catFilter === cat, dataset: { testid: `filter-cat-${cat}` } }) as HTMLElement & { selected: boolean };
        c.prepend(icon(CATEGORY_META[cat].icon, "icon"));
        c.addEventListener("click", (e) => {
          e.preventDefault();
          catFilter = catFilter === cat ? null : cat;
          catChips.querySelectorAll<HTMLElement & { selected: boolean }>("md-filter-chip[data-testid^='filter-cat-']").forEach((x) => (x.selected = x.dataset.testid === `filter-cat-${catFilter}`));
          renderList();
        });
        return c;
      }));
    const activeRec = state.recurring.filter((r) => r.active).length;

    function renderList() {
      const list = filteredBills();
      if (!list.length) return clear(listHost, h("p", { class: "pad muted md-typescale-body-medium", dataset: { testid: "bills-no-match" } }, "No bills match."));
      let lastDate = "";
      const items: Node[] = [];
      for (const b of list) {
        if (b.date !== lastDate) {
          lastDate = b.date;
          items.push(h("div", { class: "list-subheader md-typescale-label-large", role: "heading", "aria-level": "3" }, formatDate(b.date)));
        }
        const isPayment = b.kind === "payment";
        const payers = b.payers.length > 1 ? b.payers.map((p) => memberName(p.memberId)).join(" & ") : memberName(b.paidBy);
        const who = b.shares.length === state.members.length ? "everyone" : state.members.filter((m) => b.shares.some((s) => s.memberId === m.id)).map((m) => m.name).join(", ");
        const mine = viewAs ? b.shares.find((s) => s.memberId === viewAs)?.amount ?? 0 : null;
        const supporting = isPayment ? `${payers} → ${memberName(b.shares[0]?.memberId ?? "")}` : `${payers} paid · ${who}`;
        const extras = [
          b.fx && `${formatMoney(b.fx.amount, b.fx.currency)} @ ${b.fx.rate}`,
          b.recurrenceId && "repeating",
          b.hasReceipt && "receipt",
        ].filter(Boolean).join(" · ");
        const cat = isPayment ? { icon: "payments" as const, label: "Payment" } : CATEGORY_META[b.category];
        items.push(h("md-list-item", { type: "button", onclick: () => editBill(b), dataset: { testid: "bill-item" }, "aria-label": `${b.description}, ${money(b.amount)}, ${supporting}` },
          h("div", { slot: "start", class: `avatar ${isPayment ? "payment" : ""}`, title: cat.label }, icon(cat.icon)),
          h("div", { slot: "headline" }, b.description),
          h("div", { slot: "supporting-text" }, supporting, extras && h("span", { class: "extras" }, ` · ${extras}`)),
          h("div", { slot: "end", class: "bill-end" },
            h("div", { class: "md-typescale-title-small tabular" }, money(b.amount)),
            mine !== null && !isPayment && h("div", { class: "md-typescale-body-small muted tabular", dataset: { testid: "bill-my-share" } }, mine ? `${memberName(viewAs!)} ${money(mine)}` : "not in"))));
      }
      clear(listHost, h("md-list", { dataset: { testid: "bills-list" }, "aria-label": "Bills" }, items));
    }
    renderList();

    return h("section", { class: "card flush", "aria-label": "Bills" },
      head,
      h("div", { class: "bill-tools" }, search, catChips,
        activeRec > 0 && h("md-assist-chip", { label: `${activeRec} repeating`, onclick: showRecurring, dataset: { testid: "recurring-chip" } })),
      listHost);
  }

  function categoryChart() {
    const entries = CATEGORY_ORDER.map((c) => [c, state.summary.byCategory[c] ?? 0] as const).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return null;
    const max = entries[0][1];
    const total = state.summary.total || 1;
    return h("section", { class: "card flush", "aria-labelledby": "cat-chart-title" },
      h("div", { class: "card-head" }, h("h2", { class: "md-typescale-title-medium", id: "cat-chart-title" }, "Spending by category")),
      h("div", { class: "bar-chart", role: "list", dataset: { testid: "category-chart" } },
        entries.map(([c, v]) => {
          const pct = Math.round((v / total) * 100);
          return h("div", { class: "bar-row", role: "listitem", title: `${CATEGORY_META[c].label}: ${money(v)} (${pct}%)`, dataset: { testid: `cat-bar-${c}` } },
            h("div", { class: "bar-label md-typescale-body-medium" }, icon(CATEGORY_META[c].icon), CATEGORY_META[c].label),
            h("div", { class: "bar-track", "aria-hidden": "true" }, h("div", { class: "bar-fill", style: `width:${Math.max(2, (v / max) * 100)}%` })),
            h("div", { class: "bar-value md-typescale-body-medium tabular" }, money(v), h("span", { class: "muted" }, ` ${pct}%`)));
        })));
  }

  function myCard() {
    if (!viewAs) return null;
    const b = state.summary.balances.find((x) => x.memberId === viewAs);
    if (!b) return null;
    const mineOut = state.summary.settlements.filter((s) => s.from === viewAs);
    const mineIn = state.summary.settlements.filter((s) => s.to === viewAs);
    const name = memberName(viewAs);
    return h("section", { class: `card my-card ${b.net > 0 ? "pos" : b.net < 0 ? "neg" : ""}`, dataset: { testid: "my-card" }, "aria-live": "polite" },
      h("h2", { class: "md-typescale-title-medium" }, `${name}'s position`),
      h("p", { class: "md-typescale-headline-small tabular" }, b.net > 0 ? `Gets back ${money(b.net)}` : b.net < 0 ? `Owes ${money(-b.net)}` : "All settled"),
      h("p", { class: "md-typescale-body-medium muted tabular" }, `Spent ${money(b.paid)} · share of bills ${money(b.owed)}`),
      mineOut.map((s) => h("p", { class: "md-typescale-body-large" }, `Pay ${memberName(s.to)} ${money(s.amount)}`)),
      mineIn.map((s) => h("p", { class: "md-typescale-body-large" }, `${memberName(s.from)} pays you ${money(s.amount)}`)));
  }

  function summaryPanel() {
    const { summary } = state;
    const settlements = summary.settlements.length
      ? h("md-list", { dataset: { testid: "settlements" }, "aria-label": "Who pays whom" },
          summary.settlements.map((s) => {
            const dim = viewAs && s.from !== viewAs && s.to !== viewAs;
            return h("md-list-item", { class: dim ? "dim" : "", dataset: { testid: "settlement" } },
              h("div", { slot: "headline" }, h("strong", null, memberName(s.from)), " pays ", h("strong", null, memberName(s.to))),
              h("div", { slot: "supporting-text", class: "md-typescale-title-medium amount-owed tabular" }, money(s.amount)),
              !readOnly() && h("md-filled-tonal-button", { slot: "end", onclick: () => addBill({ from: s.from, to: s.to, amount: s.amount }), dataset: { testid: "settle-btn" },
                "aria-label": `Settle: ${memberName(s.from)} pays ${memberName(s.to)} ${money(s.amount)}` }, "Settle"));
          }))
      : h("div", { class: "settled", dataset: { testid: "all-settled" } }, icon("check_circle"), h("span", { class: "md-typescale-body-large" }, "All settled up"));

    // Custom rows (not md-list-item): its end slot squeezed and cut off amounts on phones.
    const balances = h("div", { class: "balances", dataset: { testid: "balances" }, role: "list" },
      summary.balances.map((b) =>
        h("div", { class: `balance-row ${viewAs === b.memberId ? "me" : ""}`, role: "listitem", dataset: { testid: "balance-row" } },
          h("div", { class: "avatar initial", "aria-hidden": "true" }, initial(memberName(b.memberId))),
          h("div", { class: "balance-main" },
            h("div", { class: "balance-top" },
              h("span", { class: "md-typescale-body-large balance-name" }, memberName(b.memberId)),
              h("span", { class: `md-typescale-title-small tabular net ${b.net > 0 ? "pos" : b.net < 0 ? "neg" : ""}`, dataset: { testid: "balance-net" } },
                b.net > 0 ? `gets ${money(b.net)}` : b.net < 0 ? `owes ${money(-b.net)}` : "settled")),
            h("div", { class: "md-typescale-body-medium muted balance-detail", dataset: { testid: "balance-detail" } },
              h("span", { class: "tabular" }, `Paid ${money(b.paid)}`),
              h("span", { class: "tabular" }, `Share ${money(b.owed)}`))))));

    return h("div", { class: "stack-lg" },
      myCard(),
      h("section", { class: "card flush", "aria-labelledby": "pays-title" }, h("div", { class: "card-head" }, h("h2", { class: "md-typescale-title-medium", id: "pays-title" }, "Who pays whom")), settlements),
      h("section", { class: "card flush", "aria-labelledby": "bal-title" }, h("div", { class: "card-head" }, h("h2", { class: "md-typescale-title-medium", id: "bal-title" }, "Balances")), balances),
      categoryChart());
  }

  function membersPanel() {
    return h("section", { class: "card flush", "aria-labelledby": "people-title" },
      h("div", { class: "card-head" }, h("h2", { class: "md-typescale-title-medium", id: "people-title" }, "People"), h("span", { class: "muted md-typescale-body-medium" }, String(state.members.length))),
      h("md-list", { dataset: { testid: "members-list" }, "aria-label": "People" },
        state.members.map((m) =>
          h("md-list-item", { dataset: { testid: "member-item" } },
            h("div", { slot: "start", class: "avatar initial", "aria-hidden": "true" }, initial(m.name)),
            h("div", { slot: "headline" }, m.name),
            m.promptpay && h("div", { slot: "supporting-text" }, "PromptPay ✓"),
            !readOnly() && h("div", { slot: "end", class: "row tight" },
              h("md-icon-button", { "aria-label": `Edit ${m.name}`, onclick: () => editMember(m), dataset: { testid: `edit-member-${m.name}` } }, icon("edit")),
              h("md-icon-button", {
                "aria-label": `Remove ${m.name}`, dataset: { testid: `remove-member-${m.name}` },
                onclick: async () => {
                  if (!(await confirmDialog(`Remove ${m.name}?`, "Only people without bills can be removed.", "Remove"))) return;
                  try {
                    await api.deleteMember(gid, m.id);
                    refresh();
                  } catch (e) {
                    snackbar(e instanceof Error ? e.message : "Could not remove");
                  }
                },
              }, icon("person_remove")))))),
      !readOnly() && h("div", { class: "row pad" },
        h("md-filled-tonal-button", { onclick: () => editMember(null), dataset: { testid: "add-member-btn" } }, icon("person_add", "icon"), "Add person")));
  }

  function activityPanel() {
    const host = h("div");
    let items = state.activity;
    const render = () => clear(host,
      items.length
        ? h("ol", { class: "activity-list", dataset: { testid: "activity-list" } }, items.map((a) =>
            h("li", { class: "activity-item", dataset: { testid: "activity-item" } },
              h("div", { class: "activity-text md-typescale-body-medium" }, describe(a)),
              h("div", { class: "md-typescale-body-small muted" }, `${a.actor ?? "someone"} · `, h("time", { dateTime: a.at }, relTime(a.at))),
              a.restorable && !readOnly() && h("md-text-button", { dataset: { testid: "activity-restore" }, onclick: async () => {
                await api.restoreBill(gid, a.entityId!);
                snackbar("Bill restored");
                refresh();
              } }, icon("undo", "icon"), "Restore"))))
        : h("p", { class: "pad muted" }, "No activity yet."),
      items.length >= 50 && h("div", { class: "row pad" }, h("md-text-button", { onclick: async () => {
        const more = await api.activity(gid, items[items.length - 1].at);
        items = [...items, ...more.activity];
        render();
      } }, "Load more")));
    render();
    return h("section", { class: "card flush", "aria-labelledby": "act-title" },
      h("div", { class: "card-head" }, h("h2", { class: "md-typescale-title-medium", id: "act-title" }, "Activity"),
        h("md-text-button", { onclick: showRecurring, dataset: { testid: "open-recurring" } }, icon("repeat", "icon"), "Repeating")),
      host);
  }

  function describe(a: Activity): string {
    const d = (a.detail ?? {}) as Record<string, unknown>;
    const desc = typeof d.description === "string" ? `“${d.description}”` : "";
    const amt = typeof d.amount === "number" ? ` ${money(d.amount)}` : "";
    const nm = (k: string) => (typeof d[k] === "string" ? String(d[k]) : "");
    switch (a.action) {
      case "group.create": return "Created the group";
      case "group.rename": return `Renamed the group to “${nm("to")}”`;
      case "group.currency": return `Changed currency ${nm("from")} → ${nm("to")}`;
      case "group.archive": return "Archived the group";
      case "group.unarchive": return "Unarchived the group";
      case "member.add": return `Added ${nm("name")}`;
      case "member.rename": return `Renamed ${nm("from")} to ${nm("to")}`;
      case "member.promptpay": return `${d.set ? "Set" : "Removed"} PromptPay for ${nm("name")}`;
      case "member.remove": return `Removed ${nm("name")}`;
      case "bill.create": return `${d.kind === "payment" ? "Recorded payment" : "Added"} ${desc}${amt}`;
      case "bill.update": return `Edited ${desc}${amt}`;
      case "bill.delete": return `Deleted ${desc}${amt}`;
      case "bill.restore": return `Restored ${desc}${amt}`;
      case "bill.recurring": return `Repeating bill added ${desc}${amt}`;
      case "receipt.add": return `Attached a receipt to ${desc}`;
      case "receipt.remove": return `Removed the receipt from ${desc}`;
      case "recurring.create": return `Set ${desc} to repeat ${d.frequency === "weekly" ? "weekly" : "monthly"}`;
      case "recurring.stop": return `Stopped repeating ${desc}`;
      default: return a.action;
    }
  }

  function viewAsSelect() {
    const sel = h("md-outlined-select", { quick: true, label: "View as", class: "view-as", dataset: { testid: "view-as" } },
      h("md-select-option", { value: "all", selected: !viewAs }, h("div", { slot: "headline" }, "Everyone")),
      state.members.map((m) => h("md-select-option", { value: m.id, selected: viewAs === m.id }, h("div", { slot: "headline" }, m.name)))) as HTMLElement & { value: string };
    sel.addEventListener("change", () => {
      viewAs = sel.value === "all" ? null : sel.value;
      onlyMine = !!viewAs;
      viewAs ? local.set(`share.viewAs:${gid}`, viewAs) : local.remove(`share.viewAs:${gid}`);
      render();
    });
    return sel;
  }

  // ---------- layout ----------

  function render() {
    const focusId = (document.activeElement as HTMLElement | null)?.dataset?.testid;
    document.title = `${state.group.name} — Share`;
    const tabs = h("md-tabs", { class: "group-tabs", activeTabIndex: TABS.indexOf(tab), "aria-label": "Sections", dataset: { testid: "tabs" } },
      h("md-primary-tab", { dataset: { testid: "tab-bills" }, "aria-controls": "panel-bills" }, icon("receipt_long", "icon"), "Bills"),
      h("md-primary-tab", { dataset: { testid: "tab-summary" }, "aria-controls": "panel-summary" }, icon("account_balance_wallet", "icon"), "Summary"),
      h("md-primary-tab", { dataset: { testid: "tab-members" }, "aria-controls": "panel-members" }, icon("group", "icon"), "People"),
      h("md-primary-tab", { dataset: { testid: "tab-activity" }, "aria-controls": "panel-activity" }, icon("history", "icon"), "Activity"));
    tabs.addEventListener("change", () => {
      tab = TABS[(tabs as unknown as { activeTabIndex: number }).activeTabIndex];
      session.set(`tab:${gid}`, tab);
      layout.dataset.tab = tab;
      window.scrollTo(0, 0);
    });

    const panel = (id: Tab, body: Node) => h("div", { class: `panel panel-${id}`, id: `panel-${id}`, role: "tabpanel", "aria-label": id }, body);
    const layout = h("main", { class: "page group-layout", dataset: { tab }, id: "main" },
      readOnly() && h("div", { class: "banner", role: "status", dataset: { testid: "archived-banner" } },
        icon("archive"), h("span", { class: "grow" }, "This group is archived and read-only."),
        h("md-text-button", { onclick: async () => { await api.updateGroup(gid, { archived: false }); snackbar("Group unarchived"); refresh(); }, dataset: { testid: "banner-unarchive" } }, "Unarchive")),
      h("div", { class: "toolbar" }, viewAsSelect()),
      panel("bills", billsPanel()),
      panel("summary", summaryPanel()),
      panel("members", membersPanel()),
      panel("activity", activityPanel()));

    clear(root,
      h("a", { class: "skip-link", href: "#main" }, "Skip to content"),
      appBar(state.group.name, [
        h("md-icon-button", { "aria-label": "Share link", onclick: share, dataset: { testid: "share-link" } }, icon("share")),
        ...overflowMenu(),
      ]),
      tabs,
      layout,
      !readOnly() && h("md-fab", { class: "fab narrow-only", variant: "primary", label: "Add bill", "aria-label": "Add bill", onclick: () => addBill(), dataset: { testid: "add-bill" } },
        icon("add", "icon")),
      printView());
    if (focusId) root.querySelector<HTMLElement>(`[data-testid="${focusId}"]`)?.focus();
  }

  /** Print-only report (hidden on screen): bills table + balances + settlements. */
  function printView() {
    const cur = state.group.currency;
    return h("section", { class: "print-only", "aria-hidden": "true" },
      h("h1", null, state.group.name),
      h("p", null, `Printed ${new Date().toLocaleString()} · Total ${money(state.summary.total)} · ${cur}`),
      h("h2", null, "Who pays whom"),
      state.summary.settlements.length
        ? h("ul", null, state.summary.settlements.map((s) => h("li", null, `${memberName(s.from)} pays ${memberName(s.to)} ${money(s.amount)}`)))
        : h("p", null, "All settled up."),
      h("h2", null, "Balances"),
      h("table", null, h("thead", null, h("tr", null, ["Person", "Paid", "Share", "Net"].map((x) => h("th", null, x)))),
        h("tbody", null, state.summary.balances.map((b) => h("tr", null, h("td", null, memberName(b.memberId)), h("td", null, money(b.paid)), h("td", null, money(b.owed)), h("td", null, money(b.net)))))),
      h("h2", null, "Bills"),
      h("table", null, h("thead", null, h("tr", null, ["Date", "Description", "Category", "Paid by", "Amount"].map((x) => h("th", null, x)))),
        h("tbody", null, state.bills.map((b) => h("tr", null,
          h("td", null, b.date), h("td", null, b.description), h("td", null, b.kind === "payment" ? "Payment" : CATEGORY_META[b.category].label),
          h("td", null, b.payers.map((p) => memberName(p.memberId)).join(" & ")), h("td", null, money(b.amount)))))));
  }

  if (await load()) render();
}

function initial(name: string) {
  return [...name.trim()][0]?.toUpperCase() ?? "?";
}

function formatDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function relTime(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (s < 60) return rtf.format(-Math.round(s), "second");
  if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  if (s < 86400 * 7) return rtf.format(-Math.round(s / 86400), "day");
  return new Date(iso).toLocaleDateString();
}

const wrap = (s: () => Storage) => ({
  get: (k: string) => { try { return s().getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { s().setItem(k, v); } catch { /* ignore */ } },
  remove: (k: string) => { try { s().removeItem(k); } catch { /* ignore */ } },
});
const session = wrap(() => sessionStorage);
const local = wrap(() => localStorage);
