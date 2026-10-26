import { api, ApiError, type Bill, type Group, type Member, type Summary } from "../api";
import { clear, h, icon, snackbar } from "../dom";
import { confirmDialog, openDialog, promptDialog, type MdDialog } from "../dialogs";
import { CURRENCIES, formatMoney } from "../money";
import { forgetGroup, rememberGroup } from "../store";
import { navigate } from "../router";
import { openBillDialog } from "./bill-dialog";

type Tab = "bills" | "summary" | "members";

interface State {
  group: Group;
  members: Member[];
  bills: Bill[];
  summary: Summary;
}

export async function renderGroup(root: HTMLElement, gid: string) {
  let tab: Tab = (sessionStorageGet(`tab:${gid}`) as Tab) || "bills";
  let state: State;

  clear(root, appBar("Loading…"), h("main", { class: "page center" }, h("md-circular-progress", { indeterminate: true, "aria-label": "Loading" })));

  async function load(): Promise<boolean> {
    try {
      const [g, summary] = await Promise.all([api.getGroup(gid), api.summary(gid)]);
      state = { ...g, summary };
      rememberGroup(g.group);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        forgetGroup(gid);
        clear(
          root,
          appBar("Not found"),
          h(
            "main",
            { class: "page center stack", dataset: { testid: "group-not-found" } },
            icon("search_off"),
            h("p", { class: "md-typescale-body-large" }, "This group doesn't exist or the link is wrong."),
            h("md-filled-button", { onclick: () => navigate("/") }, "Go home"),
          ),
        );
      } else {
        clear(
          root,
          appBar("Error"),
          h(
            "main",
            { class: "page center stack" },
            icon("cloud_off"),
            h("p", { class: "md-typescale-body-large" }, err instanceof Error ? err.message : "Something went wrong"),
            h("md-filled-button", { onclick: () => renderGroup(root, gid) }, "Retry"),
          ),
        );
      }
      return false;
    }
  }

  async function refresh() {
    if (await load()) render();
  }

  const memberName = (id: string) => state.members.find((m) => m.id === id)?.name ?? "Removed";
  const money = (n: number) => formatMoney(n, state.group.currency);

  function appBar(title: string, actions: Node[] = []) {
    return h(
      "header",
      { class: "top-app-bar" },
      h("md-icon-button", { "aria-label": "Home", onclick: () => navigate("/"), dataset: { testid: "nav-home" } }, icon("arrow_back")),
      h("span", { class: "md-typescale-title-large title", dataset: { testid: "group-title" } }, title),
      h("div", { class: "actions" }, actions),
    );
  }

  async function share() {
    const url = location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: state.group.name, url });
        return;
      }
    } catch {
      /* cancelled → fall through to copy */
    }
    try {
      await navigator.clipboard.writeText(url);
      snackbar("Link copied — send it to your group");
    } catch {
      snackbar(url);
    }
  }

  async function editGroup() {
    const name = h("md-outlined-text-field", { label: "Group name", value: state.group.name, maxLength: 60, dataset: { testid: "edit-group-name" } }) as HTMLElement & { value: string };
    const cur = h(
      "md-outlined-select",
      { label: "Currency" },
      CURRENCIES.map((c) => h("md-select-option", { value: c, selected: c === state.group.currency }, h("div", { slot: "headline" }, c))),
    ) as HTMLElement & { value: string };
    const err = h("div", { class: "form-error", role: "alert" });
    const d = h(
      "md-dialog",
      null,
      h("div", { slot: "headline" }, "Group settings"),
      h("div", { slot: "content", class: "stack" }, name, cur, h("p", { class: "md-typescale-body-small muted" }, "Changing currency does not convert existing amounts."), err),
      h(
        "div",
        { slot: "actions" },
        h("md-text-button", { onclick: () => d.close("cancel") }, "Cancel"),
        h(
          "md-filled-button",
          {
            dataset: { testid: "edit-group-save" },
            onclick: async () => {
              try {
                await api.updateGroup(gid, { name: name.value, currency: cur.value });
                d.close("ok");
              } catch (e) {
                err.textContent = e instanceof Error ? e.message : "Could not save";
              }
            },
          },
          "Save",
        ),
      ),
    ) as MdDialog;
    if ((await openDialog(d)) === "ok") refresh();
  }

  async function addBill(payment?: { from: string; to: string; amount: number }) {
    if (!state.members.length) return snackbar("Add people first");
    if (await openBillDialog({ gid, currency: state.group.currency, members: state.members, payment })) refresh();
  }

  async function editBill(bill: Bill) {
    if (await openBillDialog({ gid, currency: state.group.currency, members: state.members, bill })) refresh();
  }

  // ---------- panels ----------

  /** Laptop: "Add bill" lives in the Bills card (FAB hidden via CSS). Same testid as the FAB. */
  const addBillButton = () =>
    h("md-filled-button", { class: "wide-only", onclick: () => addBill(), dataset: { testid: "add-bill" } }, icon("add", "icon"), "Add bill");

  function billsPanel() {
    const { bills, summary } = state;
    if (!bills.length)
      return h(
        "section",
        { class: "card empty", dataset: { testid: "bills-empty" } },
        icon("receipt_long"),
        h("p", { class: "md-typescale-body-large" }, "No bills yet"),
        h("p", { class: "md-typescale-body-medium muted" }, "Add the first one with Add bill."),
        addBillButton(),
      );
    let lastDate = "";
    const items: Node[] = [];
    for (const b of bills) {
      if (b.date !== lastDate) {
        lastDate = b.date;
        items.push(h("div", { class: "list-subheader md-typescale-label-large" }, formatDate(b.date)));
      }
      const isPayment = b.kind === "payment";
      const supporting = isPayment
        ? `${memberName(b.paidBy)} → ${memberName(b.shares[0]?.memberId ?? "")}`
        : `${memberName(b.paidBy)} paid · ${b.shares.length === state.members.length ? "everyone" : state.members.filter((m) => b.shares.some((s) => s.memberId === m.id)).map((m) => m.name).join(", ")}`;
      items.push(
        h(
          "md-list-item",
          { type: "button", onclick: () => editBill(b), dataset: { testid: "bill-item" } },
          h("div", { slot: "start", class: `avatar ${isPayment ? "payment" : ""}` }, icon(isPayment ? "payments" : "receipt")),
          h("div", { slot: "headline" }, b.description),
          h("div", { slot: "supporting-text" }, supporting),
          h("div", { slot: "end", class: "md-typescale-title-small tabular" }, money(b.amount)),
        ),
      );
    }
    return h(
      "section",
      { class: "card flush" },
      h(
        "div",
        { class: "card-head" },
        h("h2", { class: "md-typescale-title-medium" }, "Bills"),
        h("span", { class: "md-typescale-body-medium muted grow-text", dataset: { testid: "total-spent" } }, `Total ${money(summary.total)}`),
        addBillButton(),
      ),
      h("md-list", { dataset: { testid: "bills-list" } }, items),
    );
  }

  function summaryPanel() {
    const { summary } = state;
    const settlements = summary.settlements.length
      ? h(
          "md-list",
          { dataset: { testid: "settlements" } },
          summary.settlements.map((s) =>
            h(
              "md-list-item",
              { dataset: { testid: "settlement" } },
              h("div", { slot: "headline" }, h("strong", null, memberName(s.from)), " pays ", h("strong", null, memberName(s.to))),
              h("div", { slot: "supporting-text", class: "md-typescale-title-medium amount-owed tabular" }, money(s.amount)),
              h(
                "md-filled-tonal-button",
                { slot: "end", onclick: () => addBill({ from: s.from, to: s.to, amount: s.amount }), dataset: { testid: "settle-btn" } },
                "Settle",
              ),
            ),
          ),
        )
      : h("div", { class: "settled", dataset: { testid: "all-settled" } }, icon("check_circle"), h("span", { class: "md-typescale-body-large" }, "All settled up"));

    // Custom rows (not md-list-item): its end slot squeezed and cut off amounts on phones.
    const balances = h(
      "div",
      { class: "balances", dataset: { testid: "balances" } },
      summary.balances.map((b) =>
        h(
          "div",
          { class: "balance-row", dataset: { testid: "balance-row" } },
          h("div", { class: "avatar initial" }, initial(memberName(b.memberId))),
          h(
            "div",
            { class: "balance-main" },
            h(
              "div",
              { class: "balance-top" },
              h("span", { class: "md-typescale-body-large balance-name" }, memberName(b.memberId)),
              h(
                "span",
                { class: `md-typescale-title-small tabular net ${b.net > 0 ? "pos" : b.net < 0 ? "neg" : ""}`, dataset: { testid: "balance-net" } },
                b.net > 0 ? `gets ${money(b.net)}` : b.net < 0 ? `owes ${money(-b.net)}` : "settled",
              ),
            ),
            h(
              "div",
              { class: "md-typescale-body-medium muted balance-detail", dataset: { testid: "balance-detail" } },
              h("span", { class: "tabular" }, `Paid ${money(b.paid)}`),
              h("span", { class: "tabular" }, `Share ${money(b.owed)}`),
            ),
          ),
        ),
      ),
    );

    return h(
      "div",
      { class: "stack-lg" },
      h("section", { class: "card flush" }, h("div", { class: "card-head" }, h("h2", { class: "md-typescale-title-medium" }, "Who pays whom")), settlements),
      h("section", { class: "card flush" }, h("div", { class: "card-head" }, h("h2", { class: "md-typescale-title-medium" }, "Balances")), balances),
    );
  }

  function membersPanel() {
    const field = h("md-outlined-text-field", { label: "Add person", maxLength: 60, class: "grow", dataset: { testid: "add-member-input" } }) as HTMLElement & {
      value: string; error: boolean; errorText: string;
    };
    const add = async () => {
      const name = field.value.trim();
      if (!name) return;
      try {
        await api.addMember(gid, name);
        snackbar(`${name} added`);
        refresh();
      } catch (e) {
        field.error = true;
        field.errorText = e instanceof Error ? e.message : "Could not add";
      }
    };
    field.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") add();
    });
    return h(
      "section",
      { class: "card flush" },
      h("div", { class: "card-head" }, h("h2", { class: "md-typescale-title-medium" }, "People"), h("span", { class: "muted md-typescale-body-medium" }, String(state.members.length))),
      h(
        "md-list",
        { dataset: { testid: "members-list" } },
        state.members.map((m) =>
          h(
            "md-list-item",
            { dataset: { testid: "member-item" } },
            h("div", { slot: "start", class: "avatar initial" }, initial(m.name)),
            h("div", { slot: "headline" }, m.name),
            h(
              "div",
              { slot: "end", class: "row tight" },
              h(
                "md-icon-button",
                {
                  "aria-label": `Rename ${m.name}`,
                  onclick: async () => {
                    const ok = await promptDialog("Rename", "Name", m.name, async (v) => {
                      try {
                        await api.renameMember(gid, m.id, v);
                        return null;
                      } catch (e) {
                        return e instanceof Error ? e.message : "Could not rename";
                      }
                    });
                    if (ok) refresh();
                  },
                },
                icon("edit"),
              ),
              h(
                "md-icon-button",
                {
                  "aria-label": `Remove ${m.name}`,
                  dataset: { testid: `remove-member-${m.name}` },
                  onclick: async () => {
                    if (!(await confirmDialog(`Remove ${m.name}?`, "Only people without bills can be removed.", "Remove"))) return;
                    try {
                      await api.deleteMember(gid, m.id);
                      refresh();
                    } catch (e) {
                      snackbar(e instanceof Error ? e.message : "Could not remove");
                    }
                  },
                },
                icon("person_remove"),
              ),
            ),
          ),
        ),
      ),
      h("div", { class: "row pad" }, field, h("md-filled-tonal-button", { onclick: add, dataset: { testid: "add-member-btn" } }, icon("person_add", "icon"), "Add")),
    );
  }

  // ---------- layout ----------

  function render() {
    document.title = `${state.group.name} — Share`;
    const tabs = h(
      "md-tabs",
      { class: "group-tabs", activeTabIndex: ["bills", "summary", "members"].indexOf(tab), dataset: { testid: "tabs" } },
      h("md-primary-tab", { dataset: { testid: "tab-bills" } }, icon("receipt_long", "icon"), "Bills"),
      h("md-primary-tab", { dataset: { testid: "tab-summary" } }, icon("account_balance_wallet", "icon"), "Summary"),
      h("md-primary-tab", { dataset: { testid: "tab-members" } }, icon("group", "icon"), "People"),
    );
    tabs.addEventListener("change", () => {
      tab = (["bills", "summary", "members"] as Tab[])[(tabs as unknown as { activeTabIndex: number }).activeTabIndex];
      sessionStorageSet(`tab:${gid}`, tab);
      layout.dataset.tab = tab;
      window.scrollTo(0, 0);
    });

    const layout = h(
      "main",
      { class: "page group-layout", dataset: { tab } },
      h("div", { class: "panel panel-bills" }, billsPanel()),
      h("div", { class: "panel panel-summary" }, summaryPanel()),
      h("div", { class: "panel panel-members" }, membersPanel()),
    );

    clear(
      root,
      appBar(state.group.name, [
        h("md-icon-button", { "aria-label": "Share link", onclick: share, dataset: { testid: "share-link" } }, icon("share")),
        h("md-icon-button", { "aria-label": "Group settings", onclick: editGroup, dataset: { testid: "group-settings" } }, icon("settings")),
      ]),
      tabs,
      layout,
      h(
        "md-fab",
        { class: "fab narrow-only", variant: "primary", label: "Add bill", "aria-label": "Add bill", onclick: () => addBill(), dataset: { testid: "add-bill" } },
        icon("add", "icon"),
      ),
    );
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

function sessionStorageGet(k: string) {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
}
function sessionStorageSet(k: string, v: string) {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
