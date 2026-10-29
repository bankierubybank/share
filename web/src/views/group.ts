// Components only the group view and its dialogs use: loaded with this chunk, not on the home page (#18).
import "@material/web/checkbox/checkbox.js";
import "@material/web/chips/filter-chip.js";
import "@material/web/dialog/dialog.js";
import "@material/web/fab/fab.js";
import "@material/web/menu/menu.js";
import "@material/web/menu/menu-item.js";
import "@material/web/chips/assist-chip.js";
import "@material/web/progress/circular-progress.js";
import "@material/web/tabs/tabs.js";
import "@material/web/tabs/primary-tab.js";

import { api, ApiError, type Activity, type Bill, type BillCategory, type Contact, type CustomCategory, type Group, type InviteStatus, type Member, type Recurrence, type Subgroup, type Summary } from "../api";
import { clear, h, icon, snackbar } from "../dom";
import { confirmDialog, openDialog, type MdDialog } from "../dialogs";
import { CURRENCIES, formatMoney, parseMoney, toInput } from "../money";
import { CATEGORY_ORDER, categoryInfo } from "../categories";
import { forgetGroup, rememberGroup } from "../store";
import { dispatch, navigate } from "../router";
import { lang, locale, setLang, t, tn } from "../i18n";
import { attachPullToRefresh, attachRowGestures } from "../gestures";
import { summarize } from "../../../src/lib/summary";
import type { PendingSave } from "./bill-dialog";
import { dequeue, enqueue, loadPage, queued, savePage } from "../offline";

const cmpDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

// Lazy chunks (#18): dialogs, export and stats load on first use.
const loadBillDialog = () => import("./bill-dialog");
const loadExport = () => import("../export");
const loadStats = () => import("./stats");
const loadMove = () => import("./move");
const loadRemind = () => import("../remind");
const loadImage = () => import("../summary-image");
type PageData = Awaited<ReturnType<typeof api.groupPage>>;
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
  subgroups: Subgroup[];
  /** Invite link status (absent in view mode). */
  invite?: InviteStatus;
  /** Opaque change token (live refresh; absent in view mode). */
  version?: string;
  /** My member id (linked identity); null in view mode. */
  me: string | null;
  /** The trip's own categories (v0.11). */
  categories: CustomCategory[];
}

/** mode "view": `gid` is a read-only view id (/v/:id); nothing can be edited and the group id is unknown. */
/** Bumped by every renderGroup: re-rendering the same URL (language switch, claim) must not stack pollers. */
let pageGen = 0;
/** Email suggestions (v0.11), fetched once per page load of the app. */
let contactsCache: Promise<Contact[]> | null = null;
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export async function renderGroup(root: HTMLElement, gid: string, mode: "edit" | "view" = "edit") {
  const isView = mode === "view";
  const gen = ++pageGen;
  // A load that finishes after the user navigated away must not paint over the new page.
  const ownPath = location.pathname;
  const stillHere = () => location.pathname === ownPath;
  let statsMod: Awaited<ReturnType<typeof loadStats>> | null = null;
  let tab: Tab = (session.get(`tab:${gid}`) as Tab) || "bills";
  if (!TABS.includes(tab) || (mode === "view" && tab === "activity")) tab = "bills";
  let viewAs: string | null = local.get(`share.viewAs:${gid}`);
  let query = "";
  let catFilter: BillCategory | null = null;
  let onlyMine = false;
  let state: State;

  clear(root, appBar(t("common.loading")), h("main", { class: "page center", "aria-busy": "true" }, h("md-circular-progress", { indeterminate: true, "aria-label": t("common.loading") })));

  // Saves refresh in the background, so loads can overlap: only the newest one may paint.
  let loadSeq = 0;
  async function load(): Promise<boolean> {
    const seq = ++loadSeq;
    try {
      if (isView) {
        const [v, sm] = await Promise.all([api.view(gid), loadStats()]);
        statsMod = sm;
        state = {
          group: { ...v.group, id: "" },
          members: v.members.map((m) => ({ ...m, promptpay: null, email: null })),
          bills: v.bills.map((b) => ({ ...b, createdBy: null, hasReceipt: false, recurrenceId: null })),
          summary: v.summary, recurring: [], activity: [], subgroups: [], me: null, categories: v.categories ?? [],
        };
      } else {
        let p: PageData;
        try {
          const [page, sm] = await Promise.all([api.groupPage(gid), loadStats()]);
          p = page;
          statsMod = sm;
          offlineAt = null;
          if (seq === loadSeq) savePage(gid, p);
        } catch (e) {
          // Offline (#8): show the last copy this device got; new bills queue until the connection is back.
          const copy = e instanceof ApiError && e.code === "network" ? loadPage<PageData>(gid) : null;
          if (!copy) throw e;
          p = copy.page;
          offlineAt = copy.savedAt;
          statsMod = await loadStats().catch(() => null);
        }
        if (seq !== loadSeq) return false; // a newer load is on its way
        state = p;
        server = { bills: p.bills, summary: p.summary };
        rememberGroup(p.group);
        overlayPending();
      }
      if (viewAs && !state.members.some((m) => m.id === viewAs)) viewAs = null;
      return true;
    } catch (err) {
      if (!stillHere() || seq !== loadSeq) return false;
      if (!isView && err instanceof ApiError && err.code === "claim_required" && err.members) {
        claimView(err.members);
      } else if (!isView && err instanceof ApiError && err.code === "trip_deleted") {
        deletedView();
      } else if (!isView && err instanceof ApiError && err.code === "not_member") {
        forgetGroup(gid);
        notMemberView();
      } else if (err instanceof ApiError && err.status === 404) {
        if (!isView) forgetGroup(gid);
        clear(root, appBar(t("common.notFound")),
          h("main", { class: "page center stack", dataset: { testid: "group-not-found" } },
            icon("search_off"),
            h("p", { class: "md-typescale-body-large" }, isView ? t("group.viewGone") : t("group.gone")),
            h("md-filled-button", { onclick: () => navigate("/") }, t("common.goHome"))));
      } else {
        clear(root, appBar(t("common.error")),
          h("main", { class: "page center stack" },
            icon("cloud_off"),
            h("p", { class: "md-typescale-body-large", role: "alert" }, err instanceof Error ? err.message : t("common.somethingWrong")),
            h("md-filled-button", { onclick: () => renderGroup(root, gid) }, t("common.retry"))));
      }
      return false;
    }
  }

  /** Pre-0.4 trip nobody is linked to yet: pick who you are (that locks the trip to linked people). */
  function claimView(members: { id: string; name: string }[]) {
    clear(root, appBar(t("group.claimTitle")),
      h("main", { class: "page stack", id: "main", dataset: { testid: "claim-view" } },
        h("h1", { class: "md-typescale-headline-small" }, t("group.claimTitle")),
        h("p", { class: "md-typescale-body-medium muted" }, t("group.claimText")),
        h("md-list", { "aria-label": t("group.claimTitle") }, members.map((m) =>
          h("md-list-item", {
            type: "button", dataset: { testid: `claim-${m.name}` },
            onclick: async () => {
              try {
                await api.setMe(gid, m.id);
                renderGroup(root, gid);
              } catch (e) {
                snackbar(e instanceof Error ? e.message : t("common.saveFailed"));
              }
            },
          }, h("div", { slot: "start", class: "avatar initial", "aria-hidden": "true" }, initial(m.name)), h("div", { slot: "headline" }, m.name)))),
        h("md-text-button", { onclick: () => navigate("/") }, t("common.goHome"))));
  }

  /** In the bin (v0.10): anyone in the trip can bring it back. */
  function deletedView() {
    clear(root, appBar(t("delete.done")),
      h("main", { class: "page center stack", id: "main", dataset: { testid: "trip-deleted" } },
        icon("delete"),
        h("p", { class: "md-typescale-body-large" }, t("bin.tripDeleted")),
        h("md-filled-button", { dataset: { testid: "restore-trip-page" }, onclick: async () => {
          try {
            await api.restoreGroup(gid);
            renderGroup(root, gid);
          } catch (e) {
            snackbar(e instanceof Error ? e.message : t("common.restoreFailed"));
          }
        } }, icon("undo", "icon"), t("bin.restore")),
        h("md-text-button", { onclick: () => navigate("/") }, t("common.goHome"))));
  }

  function notMemberView() {
    const who = h("p", { class: "md-typescale-body-medium muted" });
    clear(root, appBar(t("group.notMemberTitle")),
      h("main", { class: "page center stack", id: "main", dataset: { testid: "not-member" } },
        icon("lock"),
        h("p", { class: "md-typescale-body-large" }, t("group.notMemberText")),
        who,
        h("md-filled-button", { onclick: () => navigate("/") }, t("common.goHome"))));
    api.me().then(({ actor }) => { if (actor) who.textContent = t("group.signedInAs", { email: actor }); }, () => undefined);
  }

  let lastOwnRefresh = 0;
  /** Set while showing the offline copy: when that copy was saved. */
  let offlineAt: string | null = null;
  async function refresh() {
    lastOwnRefresh = Date.now();
    if ((await load()) && stillHere()) render();
  }

  const memberName = (id: string) => state.members.find((m) => m.id === id)?.name ?? t("member.removed");
  const money = (n: number) => formatMoney(n, state.group.currency);
  const readOnly = () => isView || state.group.archived;

  function appBar(title: string, actions: Node[] = []) {
    return h("header", { class: "top-app-bar" },
      h("md-icon-button", { "aria-label": t("group.backHome"), onclick: () => navigate("/"), dataset: { testid: "nav-home" } }, icon("arrow_back")),
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
      snackbar(t("group.linkCopied"));
    } catch {
      snackbar(url);
    }
  }

  async function exportCsv() {
    const { billsToCsv, downloadText, safeFilename } = await loadExport();
    downloadText(`${safeFilename(state.group.name)}-${new Date().toISOString().slice(0, 10)}.csv`, billsToCsv(state));
    snackbar(t("group.csvDownloaded"));
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
    const btn = h("md-icon-button", { id: anchorId, "aria-label": t("group.more"), "aria-haspopup": "menu", dataset: { testid: "group-more" } }, icon("more_vert"));
    const themeLabel: Record<Theme, string> = { system: t("theme.menu.system"), light: t("theme.light"), dark: t("theme.dark") };
    const next: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
    const item = (label: string, ic: Parameters<typeof icon>[0], testid: string, run: () => void) =>
      h("md-menu-item", { dataset: { testid }, onclick: run }, h("div", { slot: "headline" }, label), icon(ic, "start"));
    const menu = h("md-menu", { anchor: anchorId, positioning: "fixed", quick: true, dataset: { testid: "group-menu" } },
      item(t("menu.exportCsv"), "table_view", "export-csv", exportCsv),
      item(t("menu.print"), "print", "export-print", printPdf),
      item(t("menu.image"), "image", "export-image", () => void summaryImage()),
      item(t("keys.menu"), "keyboard", "shortcuts-help", () => void shortcutsHelp()),
      item(t("menu.themeChange", { label: themeLabel[currentTheme()] }), currentTheme() === "dark" ? "dark_mode" : currentTheme() === "light" ? "light_mode" : "contrast", "theme-toggle",
        () => { setTheme(next[currentTheme()]); snackbar(themeLabel[currentTheme()]); }),
      item(t("lang.switchTo"), "translate", "lang-toggle", () => { setLang(lang() === "th" ? "en" : "th"); dispatch(); }),
      item(t("menu.settings"), "settings", "group-settings", editGroup),
    ) as HTMLElement & { open: boolean; show(): void; close(): void };
    // `quick`: md-menu's close animation computed scale(Infinity) here and never finished, leaving the menu
    // stuck (open=false but painted) so it could not reopen. No animation = reliable.
    btn.addEventListener("click", () => (menu.open ? menu.close() : menu.show()));
    return [btn, menu];
  }

  async function editGroup() {
    const name = h("md-outlined-text-field", { label: t("home.groupName"), value: state.group.name, maxLength: 60, dataset: { testid: "edit-group-name" } }) as Field;
    const cur = h("md-outlined-select", { quick: true, label: t("home.currency"), dataset: { testid: "edit-group-currency" } },
      CURRENCIES.map((c) => h("md-select-option", { value: c, selected: c === state.group.currency }, h("div", { slot: "headline" }, c)))) as HTMLElement & { value: string };
    const budget = h("md-outlined-text-field", {
      label: t("budget.field"), inputMode: "decimal", suffixText: state.group.currency, dataset: { testid: "edit-group-budget" },
      value: state.group.budget ? toInput(state.group.budget, state.group.currency) : "", supportingText: t("budget.help"),
    }) as Field & { suffixText: string };
    // Untouched, the budget keeps its stored minor units on a currency switch — like every bill does (amounts aren't
    // converted) — so show it in the newly picked currency. Typed by hand, it's read in that currency.
    let budgetTouched = false;
    budget.addEventListener("input", () => { budgetTouched = true; budget.error = false; });
    cur.addEventListener("change", () => {
      budget.suffixText = cur.value;
      if (!budgetTouched) budget.value = state.group.budget ? toInput(state.group.budget, cur.value) : "";
    });
    const startF = h("md-outlined-text-field", { label: t("dates.start"), type: "date", value: state.group.startDate ?? "", dataset: { testid: "edit-group-start" } }) as Field;
    const endF = h("md-outlined-text-field", { label: t("dates.end"), type: "date", value: state.group.endDate ?? "", dataset: { testid: "edit-group-end" } }) as Field;
    const err = h("div", { class: "form-error", role: "alert" });
    const archived = state.group.archived;
    const d = h("md-dialog", { dataset: { testid: "settings-dialog" } },
      h("div", { slot: "headline" }, t("menu.settings")),
      h("div", { slot: "content", class: "stack" },
        !archived && name, !archived && cur, !archived && budget,
        !archived && h("div", { class: "row wrap" }, h("div", { class: "grow" }, startF), h("div", { class: "grow" }, endF)),
        !archived && h("p", { class: "md-typescale-body-small muted" }, t("settings.currencyNote")),
        await viewLinkSection(),
        !archived && h("div", { class: "stack-sm", dataset: { testid: "settings-categories" } },
          h("h2", { class: "md-typescale-title-small" }, t("cat.title")),
          h("p", { class: "md-typescale-body-small muted" }, t("cat.help")),
          h("md-chip-set", { "aria-label": t("cat.title") },
            state.categories.map((c) => {
              const info = categoryInfo(`c:${c.id}`, state.categories);
              return h("md-assist-chip", { label: info.label, dataset: { testid: "settings-cat" }, onclick: () => { d.close("cancel"); void editCategory(c); } }, icon(info.icon, "icon"));
            }),
            h("md-assist-chip", { label: t("cat.new"), dataset: { testid: "settings-cat-new" }, onclick: () => { d.close("cancel"); void editCategory(); } }, icon("add", "icon")))),
        await pushSection(),
        !archived && h("div", { class: "stack-sm" },
          h("h2", { class: "md-typescale-title-small" }, t("settings.merge")),
          h("md-outlined-button", { dataset: { testid: "merge-group" }, onclick: () => { d.close("cancel"); void mergeFlow(); } },
            icon("groups", "icon"), t("settings.mergeBtn"))),
        h("div", { class: "danger-zone stack-sm" },
          h("h2", { class: "md-typescale-title-small" }, archived ? t("settings.archivedTitle") : t("settings.finished")),
          h("p", { class: "md-typescale-body-small muted" }, archived ? t("settings.archivedHelp") : t("settings.archiveHelp")),
          h("div", { class: "row wrap" },
            h("md-outlined-button", { dataset: { testid: archived ? "unarchive-group" : "archive-group" }, onclick: async () => {
              try {
                await api.updateGroup(gid, { archived: !archived });
                snackbar(archived ? t("settings.unarchivedToast") : t("settings.archivedToast"));
                d.close("ok");
              } catch (e) {
                err.textContent = e instanceof Error ? e.message : t("common.updateFailed");
              }
            } }, icon(archived ? "unarchive" : "archive", "icon"), archived ? t("settings.unarchive") : t("settings.archive")),
            h("md-text-button", { class: "danger", dataset: { testid: "delete-group" }, onclick: async () => { d.close("cancel"); await deleteGroupFlow(); } },
              icon("delete_forever", "icon"), t("settings.deleteGroup")))),
        err),
      h("div", { slot: "actions" },
        h("md-text-button", { onclick: () => d.close("cancel") }, archived ? t("common.close") : t("common.cancel")),
        !archived && h("md-filled-button", { dataset: { testid: "edit-group-save" }, onclick: async () => {
          const raw = budget.value.trim();
          const b = !budgetTouched ? state.group.budget : raw ? parseMoney(raw, cur.value) : null;
          if (budgetTouched && raw && !(b && b > 0)) {
            budget.error = true;
            budget.errorText = t("budget.invalid");
            return;
          }
          const startDate = startF.value || null;
          const endDate = endF.value || null;
          if (startDate && endDate && endDate < startDate) {
            endF.error = true;
            endF.errorText = t("dates.order");
            return;
          }
          try {
            await api.updateGroup(gid, {
              name: name.value, currency: cur.value, ...(b !== state.group.budget ? { budget: b } : {}),
              ...(startDate !== state.group.startDate ? { startDate } : {}), ...(endDate !== state.group.endDate ? { endDate } : {}),
            });
            d.close("ok");
          } catch (e) {
            err.textContent = e instanceof Error ? e.message : t("common.saveFailed");
          }
        } }, t("common.save"))),
    ) as MdDialog;
    if ((await openDialog(d)) === "ok") refresh();
  }

  async function editCategory(c?: CustomCategory) {
    const { editCategoryDialog } = await import("./categories-dialog");
    const saved = await editCategoryDialog(gid, c, c ? async () => {
      await api.deleteCategory(gid, c.id);
      snackbar(t("cat.deleted", { name: c.name }));
    } : undefined);
    if (saved || c) refresh();
  }

  /** Notifications on/off for this browser (v0.11, #6). */
  async function pushSection() {
    if (isView) return null;
    const mod = await import("../push");
    const on = !!(await mod.currentSubscription().catch(() => null));
    const help = h("p", { class: "md-typescale-body-small muted" }, mod.pushSupported() ? t("push.help") : t("push.unsupported"));
    const btn = h("md-outlined-button", { dataset: { testid: "push-toggle" }, disabled: !mod.pushSupported(), onclick: async () => {
      try {
        if (on) {
          await mod.disablePush();
          snackbar(t("push.off"));
        } else {
          const r = await mod.enablePush();
          snackbar(r === "on" ? t("push.on") : r === "denied" ? t("push.denied") : t("push.unsupported"));
        }
      } catch (e) {
        snackbar(e instanceof Error ? e.message : t("common.saveFailed"));
      }
      editGroupAgain();
    } }, icon(on ? "notifications_off" : "notifications", "icon"), on ? t("push.turnOff") : t("push.turnOn"));
    return h("div", { class: "stack-sm" }, h("h2", { class: "md-typescale-title-small" }, t("push.title")), help, btn);
  }
  /** Re-open Settings so the notifications button shows its new state. */
  const editGroupAgain = () => {
    document.querySelector<MdDialog>("md-dialog[data-testid=settings-dialog]")?.close("cancel");
    setTimeout(() => void editGroup(), 0);
  };

  async function deleteGroupFlow() {
    const field = h("md-outlined-text-field", { label: t("delete.confirmLabel"), dataset: { testid: "delete-confirm-input" } }) as Field;
    const btn = h("md-filled-button", { class: "danger-filled", disabled: true, dataset: { testid: "delete-confirm" } }, t("delete.forever")) as HTMLElement & { disabled: boolean };
    field.addEventListener("input", () => (btn.disabled = field.value.trim() !== state.group.name));
    const d = h("md-dialog", { type: "alert", dataset: { testid: "delete-dialog" } },
      h("div", { slot: "headline" }, t("delete.title", { name: state.group.name })),
      h("div", { slot: "content", class: "stack" },
        h("p", { class: "md-typescale-body-medium" }, t("delete.text")),
        field),
      h("div", { slot: "actions" }, h("md-text-button", { onclick: () => d.close("cancel") }, t("common.cancel")), btn)) as MdDialog;
    btn.addEventListener("click", async () => {
      try {
        await api.deleteGroup(gid);
        d.close("ok");
      } catch (e) {
        snackbar(e instanceof Error ? e.message : t("common.deleteFailed"));
      }
    });
    if ((await openDialog(d)) === "ok") {
      forgetGroup(gid);
      navigate("/", true);
      const name = state.group.name;
      snackbar(t("delete.done"), { label: t("common.undo"), run: async () => {
        try {
          await api.restoreGroup(gid);
          snackbar(t("bin.restored", { name }));
          navigate(`/g/${gid}`);
        } catch (e) {
          snackbar(e instanceof Error ? e.message : t("common.restoreFailed"));
        }
      } });
    }
  }

  // ---------- optimistic saves (#13) ----------
  // A saved/deleted bill shows at once (marked "Saving…") with totals recomputed locally by the same code the
  // Worker uses; the server's answer then replaces it (refresh) or, on failure, it is rolled back with an Edit
  // action that reopens what was entered.
  const pending = new Map<string, PendingSave>();
  /** Last server answer; `state.bills`/`state.summary` = this + pending changes. */
  let server: { bills: Bill[]; summary: Summary } = { bills: [], summary: { balances: [], settlements: [], total: 0, byCategory: {} } };

  function overlayPending() {
    const waiting = isView ? [] : queued(gid);
    queuedIds = new Set(waiting.map((q) => q.shown.id));
    if (!pending.size && !waiting.length) {
      state.bills = server.bills;
      state.summary = server.summary;
      return;
    }
    let bills = [...server.bills];
    for (const q of waiting) {
      if (pending.has(q.shown.id)) continue;
      if (q.op === "update" || q.op === "delete") bills = bills.filter((b) => b.id !== q.shown.id);
      if (q.op !== "delete") bills.push(q.shown);
    }
    for (const op of pending.values()) {
      bills = bills.filter((b) => b.id !== op.id);
      if (op.bill) bills.push(op.bill);
    }
    // Same order as the server: newest date first, then newest created.
    bills.sort((a, b) => cmpDesc(a.date, b.date) || cmpDesc(a.createdAt, b.createdAt));
    state.bills = bills;
    state.summary = summarize(state.members.map((m) => m.id), bills) as Summary;
  }

  function track(op: PendingSave) {
    pending.set(op.id, op);
    overlayPending();
    if (stillHere()) render();
    op.done.then(
      () => {
        pending.delete(op.id);
        void refresh();
      },
      (e) => {
        pending.delete(op.id);
        // No connection (#8): keep the change on this device and send it when we're back online — new bills,
        // and (v0.11) edits and deletes. A second offline change to the same bill replaces the first (same base).
        const queuedAt = new Date().toISOString();
        const isNew = op.id.startsWith("tmp-");
        const earlier = queued(gid).find((q) => q.ref === op.id);
        const offline = e instanceof ApiError && e.code === "network" && (
          isNew ? !!op.input && !!op.bill && enqueue(gid, { ref: op.id.slice(4), op: "create", input: op.input, shown: op.bill, queuedAt })
            : op.bill ? !!op.input && enqueue(gid, { ref: op.id, op: "update", input: op.input, base: earlier?.base ?? op.base, shown: op.bill, queuedAt })
              : !!op.original && enqueue(gid, { ref: op.id, op: "delete", shown: earlier?.shown ?? op.original, queuedAt }));
        overlayPending();
        if (!stillHere()) return;
        render();
        if (offline) return snackbar(op.receipt ? t("offline.queuedNoPhoto") : t("offline.queued"));
        const msg = e instanceof Error ? e.message : t("common.saveFailed");
        snackbar(t("bill.saveFailedToast", { msg }), op.bill ? { label: t("bill.editAgain"), run: () => void reopen(op) } : undefined);
      },
    );
  }

  /** Sends bills queued offline, oldest first. Stops at the first network failure (still offline). */
  let flushing = false;
  async function flushOutbox() {
    if (isView || flushing) return;
    const items = queued(gid);
    if (!items.length) return;
    flushing = true;
    let sent = 0;
    try {
      for (const q of items) {
        try {
          if (q.op === "update") await api.updateBill(gid, q.ref, { ...q.input!, ifUpdatedAt: q.base });
          else if (q.op === "delete") await api.deleteBill(gid, q.ref).catch((e) => { if (!(e instanceof ApiError && e.status === 404)) throw e; });
          else await api.createBill(gid, { ...q.input!, clientRef: q.ref });
          dequeue(gid, q.ref);
          sent++;
        } catch (e) {
          // Still offline, signed out (kept until the sign-in), busy or down: try again later.
          if (e instanceof ApiError && (e.code === "network" || e.code === "signed_out" || e.status === 429 || e.status >= 500)) break;
          if (q.op === "update" && e instanceof ApiError && (e.code === "stale" || e.status === 404)) {
            // Someone else changed (or deleted) it meanwhile: theirs stays; offer to apply mine again by hand.
            dequeue(gid, q.ref);
            snackbar(t("offline.stale", { desc: q.shown.description }), e.code === "stale" ? { label: t("bill.editAgain"), run: () => void editBillById(q.ref) } : undefined);
            continue;
          }
          // Refused (e.g. a person was removed meanwhile): drop it, offer to enter it again.
          dequeue(gid, q.ref);
          const msg = e instanceof Error ? e.message : t("common.saveFailed");
          snackbar(t("offline.refused", { desc: q.shown.description, msg }), { label: t("bill.editAgain"), run: () => void reopen({ id: q.shown.id, bill: q.shown, done: Promise.resolve(null) }) });
        }
      }
    } finally {
      flushing = false;
    }
    if (sent) {
      await refresh();
      if (stillHere()) snackbar(tn("offline.synced", sent));
    } else if (stillHere()) {
      overlayPending();
      render();
    }
  }

  async function reopen(op: PendingSave) {
    if (!op.bill || readOnly()) return;
    const again = op.id.startsWith("tmp-") ? { draft: op.bill } : { bill: op.bill };
    if (await openBillDialog({ ...billOpts(), ...again })) refresh();
  }

  const billOpts = () => ({
    group: state.group, members: state.members, bills: state.bills, viewAs, subgroups: state.subgroups, categories: state.categories,
    onDeleted: undoable, onDuplicate: (b: Bill) => void duplicateBill(b), onSaving: track,
  });
  const openBillDialog = async (o: Parameters<Awaited<ReturnType<typeof loadBillDialog>>["openBillDialog"]>[0]) =>
    (await loadBillDialog()).openBillDialog(o);

  async function duplicateBill(b: Bill) {
    if (readOnly()) return;
    if (await openBillDialog({ ...billOpts(), template: b })) refresh();
  }

  /** Bills with a change waiting on this device (offline queue); refreshed by overlayPending. */
  let queuedIds = new Set<string>();
  const isQueued = (id: string) => queuedIds.has(id) && !pending.has(id);

  async function editBillById(id: string) {
    await refresh();
    const b = state.bills.find((x) => x.id === id);
    if (b) void editBill(b);
  }

  function swipeDelete(b: Bill) {
    if (pending.has(b.id) || isQueued(b.id)) return;
    const done = api.deleteBill(gid, b.id).then(() => null);
    track({ id: b.id, bill: null, done, original: b });
    undoable(b, done);
  }

  async function addBill(payment?: { from: string; to: string; amount: number }) {
    if (readOnly()) return snackbar(t("group.archivedToast"));
    if (!state.members.length) return snackbar(t("group.addPeopleFirst"));
    if (await openBillDialog({ ...billOpts(), payment })) refresh();
  }

  async function editBill(bill: Bill) {
    if (isView) return;
    if (readOnly()) return snackbar(t("group.archivedEdit"));
    if (isQueued(bill.id)) {
      return snackbar(t("offline.waitingEdit"), { label: t("offline.discard"), run: () => {
        dequeue(gid, bill.id.startsWith("tmp-") ? bill.id.slice(4) : bill.id);
        overlayPending();
        render();
      } });
    }
    const op = pending.get(bill.id);
    if (op) {
      // Still saving: open it once the server has it (a failed save shows its own message).
      snackbar(t("bill.stillSaving"));
      const saved = await op.done.catch(() => null);
      if (!saved || !stillHere()) return;
      bill = saved;
    }
    if (await openBillDialog({ ...billOpts(), bill })) refresh();
  }

  /** `deleting`: the delete still on its way (optimistic); Undo waits for it. */
  function undoable(bill: Bill, deleting?: Promise<unknown>) {
    snackbar(t("bill.deletedToast", { desc: bill.description }), {
      label: t("common.undo"),
      run: async () => {
        try {
          if (deleting && !(await deleting.then(() => true, () => false))) {
            // Never reached the server. Queued offline: just drop it from the queue (v0.11).
            if (queued(gid).some((q) => q.op === "delete" && q.ref === bill.id)) {
              dequeue(gid, bill.id);
              overlayPending();
              render();
              snackbar(t("bill.restored"));
            }
            return;
          }
          await api.restoreBill(gid, bill.id);
          snackbar(t("bill.restored"));
          refresh();
        } catch (e) {
          snackbar(e instanceof Error ? e.message : t("common.restoreFailed"));
        }
      },
    });
  }

  async function editMember(m: Member | null) {
    const name = h("md-outlined-text-field", { label: t("common.name"), value: m?.name ?? "", maxLength: 60, required: true, dataset: { testid: "member-name-input" } }) as Field;
    const isMe = !!m && m.id === state.me;
    const email = h("md-outlined-text-field", {
      label: t("member.emailLabel"), value: m?.email?.startsWith("svc:") ? "" : (m?.email ?? ""), type: "email", inputMode: "email",
      supportingText: isMe ? t("member.emailYou") : t("member.emailHelp"), disabled: isMe || !!m?.email?.startsWith("svc:"),
      dataset: { testid: "member-email-input" },
    }) as Field & { disabled: boolean };
    // People from my other trips (v0.11, #9): tap one to fill the email.
    const suggestions = h("md-chip-set", { class: "chip-scroll", "aria-label": t("contacts.label"), dataset: { testid: "contact-suggestions" } });
    const taken = new Set(state.members.map((x) => x.email).filter(Boolean));
    const showSuggestions = async () => {
      if (email.disabled) return;
      const all = (contactsCache ??= api.contacts().then((r) => r.contacts, () => [] as Contact[]));
      const q = email.value.trim().toLowerCase();
      const who = name.value.trim().toLowerCase();
      const list = (await all).filter((c) => !taken.has(c.email) && (q ? c.email.includes(q) || c.name.toLowerCase().includes(q) : !!who && c.name.toLowerCase().startsWith(who)));
      clear(suggestions, list.slice(0, 5).map((c) =>
        h("md-assist-chip", { label: `${c.name} · ${c.email}`, dataset: { testid: "contact-suggestion" }, onclick: () => { email.value = c.email; clear(suggestions); } })));
    };
    email.addEventListener("input", () => void showSuggestions());
    email.addEventListener("focus", () => void showSuggestions());
    name.addEventListener("input", () => { if (!email.value) void showSuggestions(); });
    const pp = h("md-outlined-text-field", {
      label: t("member.promptpayLabel"), value: m?.promptpay ?? "", inputMode: "numeric",
      supportingText: t("member.promptpayHelp"),
      dataset: { testid: "member-promptpay-input" },
    }) as Field;
    const save = async () => {
      name.error = pp.error = email.error = false;
      const mail = email.disabled ? undefined : email.value.trim() || null;
      try {
        if (m) await api.updateMember(gid, m.id, { name: name.value, promptpay: pp.value.trim() || null, ...(mail !== undefined && mail !== m.email ? { email: mail } : {}) });
        else await api.addMember(gid, name.value, pp.value.trim() || null, mail);
        d.close("ok");
      } catch (e) {
        const msg = e instanceof Error ? e.message : t("common.saveFailed");
        const code = e instanceof ApiError ? e.code : "";
        const f = /promptpay/i.test(msg) ? pp : code === "last_link" || /email/i.test(msg) ? email : name;
        f.error = true;
        f.errorText = /promptpay/i.test(msg) ? t("member.promptpayError")
          : code === "last_link" ? t("member.lastLink")
          : code === "email_locked" ? t("member.emailLocked", { name: m?.name ?? "" })
          : /already linked/i.test(msg) ? t("member.emailTaken")
          : /email/i.test(msg) ? t("member.emailError") : msg;
      }
    };
    // "This is me": move my link to this (unlinked) person — e.g. the creator added themselves second.
    const thisIsMe = m && !isMe && !m.email && state.me !== null && h("md-text-button", {
      type: "button", dataset: { testid: "member-this-is-me" },
      onclick: async () => {
        try {
          await api.setMe(gid, m.id);
          d.close("ok");
        } catch (e) {
          snackbar(e instanceof Error ? e.message : t("common.saveFailed"));
        }
      },
    }, icon("person_pin", "icon"), t("member.thisIsMe"));
    const d = h("md-dialog", { dataset: { testid: "member-dialog" } },
      h("div", { slot: "headline" }, m ? t("member.edit", { name: m.name }) : t("member.add")),
      h("form", { slot: "content", class: "stack", onsubmit: (e: Event) => { e.preventDefault(); save(); } }, name, email, suggestions, pp, thisIsMe),
      h("div", { slot: "actions" }, h("md-text-button", { onclick: () => d.close("cancel") }, t("common.cancel")),
        h("md-filled-button", { onclick: save, dataset: { testid: "member-save" } }, t("common.save")))) as MdDialog;
    d.addEventListener("opened", () => name.focus(), { once: true });
    if ((await openDialog(d)) === "ok") refresh();
  }

  async function showRecurring() {
    const list = h("md-list", { dataset: { testid: "recurring-list" } },
      state.recurring.map((r) => h("md-list-item", { dataset: { testid: "recurring-item" } },
        icon("repeat", "start"),
        h("div", { slot: "headline" }, String(r.template.description)),
        h("div", { slot: "supporting-text" },
          `${r.frequency === "monthly" ? t("recurring.monthly") : t("recurring.weekly")} · ${r.template.amount !== undefined ? money(r.template.amount) : ""}`,
          r.active ? t("recurring.next", { date: formatDate(r.nextDate) }) : r.lastError ? t("recurring.stoppedErr", { err: r.lastError }) : t("recurring.stopped")),
        r.active && !readOnly() && h("md-text-button", { slot: "end", dataset: { testid: "recurring-stop" }, onclick: async () => {
          if (!(await confirmDialog(t("recurring.stopTitle"), t("recurring.stopText"), t("common.stop")))) return;
          await api.stopRecurring(gid, r.id);
          d.close("ok");
        } }, t("common.stop")))));
    const d = h("md-dialog", { dataset: { testid: "recurring-dialog" } },
      h("div", { slot: "headline" }, t("recurring.title")),
      h("div", { slot: "content" }, state.recurring.length ? list : h("p", null, t("recurring.none"))),
      h("div", { slot: "actions" }, h("md-text-button", { onclick: () => d.close("cancel") }, t("common.close")))) as MdDialog;
    if ((await openDialog(d)) === "ok") refresh();
  }

  // ---------- panels ----------

  const addBillButton = () =>
    isView ? null : h("md-filled-button", { class: "wide-only", disabled: readOnly(), onclick: () => addBill(), dataset: { testid: "add-bill" } }, icon("add", "icon"), t("bill.add"));

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
      h("h2", { class: "md-typescale-title-medium" }, t("tab.bills")),
      h("span", { class: "md-typescale-body-medium muted grow-text", dataset: { testid: "total-spent" } }, t("bills.total", { amount: money(summary.total) })),
      addBillButton());
    if (!bills.length)
      return h("section", { class: "card empty", dataset: { testid: "bills-empty" }, "aria-label": t("tab.bills") },
        icon("receipt_long"),
        h("p", { class: "md-typescale-body-large" }, t("bills.none")),
        h("p", { class: "md-typescale-body-medium muted" }, readOnly() ? t("bills.archivedEmpty") : t("bills.addFirst")),
        addBillButton(),
        state.recurring.some((r) => r.active) && h("md-text-button", { onclick: showRecurring }, icon("repeat", "icon"), t("recurring.title")));

    const listHost = h("div", { "aria-live": "polite" });
    const search = h("md-outlined-text-field", {
      class: "search-field", type: "search", label: t("bills.search"), value: query, dataset: { testid: "bill-search" },
      oninput: (e: Event) => { query = (e.target as Field).value; renderList(); },
    });
    search.prepend(icon("search", "leading-icon"));
    const usedCats = [...CATEGORY_ORDER, ...state.categories.map((c) => `c:${c.id}` as const)].filter((c) => bills.some((b) => b.category === c));
    const catChips = h("md-chip-set", { class: "chip-scroll", "aria-label": t("bills.filterCat") },
      viewAs && (() => {
        const c = h("md-filter-chip", { label: t("bills.only", { name: memberName(viewAs) }), selected: onlyMine, dataset: { testid: "filter-mine" } }) as HTMLElement & { selected: boolean };
        c.addEventListener("click", (e) => { e.preventDefault(); onlyMine = !onlyMine; c.selected = onlyMine; renderList(); });
        return c;
      })(),
      usedCats.length > 1 && usedCats.map((cat) => {
        const info = categoryInfo(cat, state.categories);
        const c = h("md-filter-chip", { label: info.label, selected: catFilter === cat, dataset: { testid: `filter-cat-${cat}` } }) as HTMLElement & { selected: boolean };
        c.prepend(icon(info.icon, "icon"));
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
      if (!list.length) return clear(listHost, h("p", { class: "pad muted md-typescale-body-medium", dataset: { testid: "bills-no-match" } }, t("bills.noMatch")));
      let lastDate = "";
      const items: Node[] = [];
      for (const b of list) {
        if (b.date !== lastDate) {
          lastDate = b.date;
          items.push(h("div", { class: "list-subheader md-typescale-label-large", role: "heading", "aria-level": "3" }, formatDate(b.date)));
        }
        const isPayment = b.kind === "payment";
        const payers = b.payers.length > 1 ? b.payers.map((p) => memberName(p.memberId)).join(" & ") : memberName(b.paidBy);
        const who = b.shares.length === state.members.length ? t("bills.everyone") : state.members.filter((m) => b.shares.some((s) => s.memberId === m.id)).map((m) => m.name).join(", ");
        const mine = viewAs ? b.shares.find((s) => s.memberId === viewAs)?.amount ?? 0 : null;
        const supporting = isPayment ? `${payers} → ${memberName(b.shares[0]?.memberId ?? "")}` : t("bills.paidBy", { payers, who });
        const extras = [
          b.fx && `${formatMoney(b.fx.amount, b.fx.currency, "code")} @ ${b.fx.rate}`,
          b.recurrenceId && t("bills.repeating"),
          b.hasReceipt && t("bills.receipt"),
          b.commentCount > 0 && tn("bills.comments", b.commentCount),
        ].filter(Boolean).join(" · ");
        const cat = isPayment ? { icon: "payments" as const, label: t("bill.payment") } : categoryInfo(b.category, state.categories);
        const saving = pending.has(b.id);
        const waiting = !saving && isQueued(b.id);
        items.push(h("md-list-item", {
          type: isView ? "text" : "button", class: saving ? "saving" : waiting ? "queued" : "", onclick: () => editBill(b),
          dataset: { testid: "bill-item", billId: b.id, ...(saving ? { saving: "1" } : {}), ...(waiting ? { queued: "1" } : {}) },
          "aria-label": `${b.description}, ${money(b.amount)}, ${supporting}${saving ? `, ${t("bill.saving")}` : waiting ? `, ${t("offline.waiting")}` : ""}`,
        },
          h("div", { slot: "start", class: `avatar ${isPayment ? "payment" : ""}`, title: cat.label }, icon(cat.icon)),
          h("div", { slot: "headline" }, b.description),
          h("div", { slot: "supporting-text" }, saving && h("span", { class: "saving-tag", dataset: { testid: "bill-saving" } }, `${t("bill.saving")} · `),
            waiting && h("span", { class: "saving-tag queued-tag", dataset: { testid: "bill-queued" } }, `${t("offline.waiting")} · `),
            supporting, extras && h("span", { class: "extras" }, ` · ${extras}`)),
          h("div", { slot: "end", class: "bill-end" },
            h("div", { class: "md-typescale-title-small tabular" }, money(b.amount)),
            mine !== null && !isPayment && h("div", { class: "md-typescale-body-small muted tabular", dataset: { testid: "bill-my-share" } }, mine ? `${memberName(viewAs!)} ${money(mine)}` : t("bills.notIn")))));
      }
      clear(listHost, h("md-list", { dataset: { testid: "bills-list" }, "aria-label": t("tab.bills") }, items));
      if (!readOnly()) {
        const byId = new Map(state.bills.map((b) => [b.id, b]));
        listHost.querySelectorAll<HTMLElement>("[data-bill-id]").forEach((row) => {
          const b = byId.get(row.dataset.billId!);
          if (b && !pending.has(b.id) && !isQueued(b.id)) attachRowGestures(row, { onSwipeLeft: () => swipeDelete(b), onLongPress: b.kind === "expense" ? () => duplicateBill(b) : undefined });
        });
      }
    }
    renderList();

    return h("section", { class: "card flush", "aria-label": t("tab.bills") },
      head,
      h("div", { class: "bill-tools" }, search, catChips,
        activeRec > 0 && h("md-assist-chip", { label: t("recurring.chip", { n: activeRec }), onclick: showRecurring, dataset: { testid: "recurring-chip" } })),
      listHost);
  }

  /** "12–18 Oct" from the trip dates (v0.11). */
  function tripDates(): string | null {
    const { startDate: s, endDate: e } = state.group;
    if (!s && !e) return null;
    const d = (x: string) => new Date(`${x}T00:00:00`);
    const f = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short" });
    if (s && e) return f.formatRange(d(s), d(e));
    return s ? t("dates.from", { date: f.format(d(s)) }) : t("dates.until", { date: f.format(d(e!)) });
  }

  /**
   * Spending per day (v0.11, #7): expenses by bill date, over the trip dates when set (else first → last bill).
   * One column per day, ≤ 62 days (longer: the last 62).
   */
  function dayChart() {
    const expenses = state.bills.filter((b) => b.kind === "expense");
    if (!expenses.length) return null;
    const dates = expenses.map((b) => b.date).sort();
    const from = state.group.startDate && state.group.startDate < dates[0] ? state.group.startDate : dates[0];
    const to = state.group.endDate && state.group.endDate > dates[dates.length - 1] ? state.group.endDate : dates[dates.length - 1];
    const days: string[] = [];
    for (let t0 = Date.parse(`${from}T00:00:00Z`); t0 <= Date.parse(`${to}T00:00:00Z`); t0 += 86_400_000) days.push(new Date(t0).toISOString().slice(0, 10));
    if (days.length < 2) return null;
    const shown = days.slice(-62);
    const sums = new Map<string, number>();
    for (const b of expenses) sums.set(b.date, (sums.get(b.date) ?? 0) + b.amount);
    const max = Math.max(1, ...shown.map((d) => sums.get(d) ?? 0));
    const total = shown.reduce((a, d) => a + (sums.get(d) ?? 0), 0);
    const label = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short" });
    const today = localToday();
    return h("section", { class: "card flush", "aria-labelledby": "day-chart-title" },
      h("div", { class: "card-head" }, h("h2", { class: "md-typescale-title-medium", id: "day-chart-title" }, t("chart.perDay")),
        h("span", { class: "md-typescale-body-medium muted tabular", dataset: { testid: "day-avg" } }, t("chart.avgDay", { amount: money(Math.round(total / shown.length)) }))),
      h("div", { class: "day-chart", role: "list", dataset: { testid: "day-chart" } },
        shown.map((d) => {
          const v = sums.get(d) ?? 0;
          return h("div", { class: `day-col ${d === today ? "today" : ""}`, role: "listitem", title: `${label(d)}: ${money(v)}`, "aria-label": `${label(d)}: ${money(v)}`, dataset: { testid: "day-bar" } },
            h("div", { class: "day-fill", style: `height:${v ? Math.max(3, (v / max) * 100) : 0}%` }));
        })),
      h("div", { class: "day-axis md-typescale-body-small muted", "aria-hidden": "true" },
        h("span", null, label(shown[0])), h("span", null, label(shown[shown.length - 1]))));
  }

  function categoryChart() {
    const entries = (Object.entries(state.summary.byCategory) as [BillCategory, number][]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return null;
    const max = entries[0][1];
    const total = state.summary.total || 1;
    return h("section", { class: "card flush", "aria-labelledby": "cat-chart-title" },
      h("div", { class: "card-head" }, h("h2", { class: "md-typescale-title-medium", id: "cat-chart-title" }, t("chart.byCategory"))),
      h("div", { class: "bar-chart", role: "list", dataset: { testid: "category-chart" } },
        entries.map(([c, v]) => {
          const pct = Math.round((v / total) * 100);
          const info = categoryInfo(c, state.categories);
          return h("div", { class: "bar-row", role: "listitem", title: `${info.label}: ${money(v)} (${pct}%)`, dataset: { testid: `cat-bar-${c}` } },
            h("div", { class: "bar-label md-typescale-body-medium" }, icon(info.icon), info.label),
            h("div", { class: "bar-track", "aria-hidden": "true" }, h("div", { class: "bar-fill", style: `width:${Math.max(2, (v / max) * 100)}%` })),
            h("div", { class: "bar-value md-typescale-body-medium tabular" }, money(v), h("span", { class: "muted" }, ` ${pct}%`)));
        })));
  }

  /**
   * Top of the trip, on every tab: where you stand (or the "View as" person), what to do next (pay / get paid,
   * with Settle), and the trip total. Answers "do I owe anything?" without opening Summary.
   */
  function tripHeader() {
    const { summary } = state;
    const who = viewAs ?? state.me;
    // No bills yet: invite the first one instead of saying "settled".
    const bal = who && state.bills.length ? summary.balances.find((x) => x.memberId === who) : undefined;
    const you = !!who && who === state.me;
    const name = who ? memberName(who) : "";
    const tone = bal ? (bal.net > 0 ? "pos" : bal.net < 0 ? "neg" : "zero") : "";
    const net = bal && (you
      ? bal.net > 0 ? t("hero.youGet", { amount: money(bal.net) }) : bal.net < 0 ? t("hero.youOwe", { amount: money(-bal.net) }) : t("hero.youSettled")
      : bal.net > 0 ? t("mycard.getsBack", { amount: money(bal.net) }) : bal.net < 0 ? t("mycard.owes", { amount: money(-bal.net) }) : t("mycard.settled"));
    const actions = who ? summary.settlements.filter((s) => s.from === who || s.to === who).map((s) => {
      const out = s.from === who;
      const text = out
        ? t("mycard.pay", { name: memberName(s.to), amount: money(s.amount) })
        : you ? t("mycard.paysYou", { name: memberName(s.from), amount: money(s.amount) })
          : t("mycard.paysThem", { from: memberName(s.from), name, amount: money(s.amount) });
      return h("li", { class: out ? "out" : "in", dataset: { testid: "hero-action" } },
        icon(out ? "arrow_forward" : "payments"),
        h("span", { class: "grow md-typescale-body-large" }, text),
        !out && !isView && remindButton(s, "hero-remind"),
        !readOnly() && h("md-filled-tonal-button", { onclick: () => addBill({ from: s.from, to: s.to, amount: s.amount }), dataset: { testid: "hero-settle" },
          "aria-label": t("summary.settleAria", { from: memberName(s.from), to: memberName(s.to), amount: money(s.amount) }) }, t("summary.settle")));
    }) : [];
    return h("section", { class: `trip-hero ${tone}`, dataset: { testid: "my-card" }, "aria-live": "polite", "aria-label": who ? (you ? t("hero.you") : t("mycard.title", { name })) : t("hero.trip") },
      h("div", { class: "hero-top" },
        h("span", { class: "hero-who md-typescale-label-large" }, who ? (you ? `${t("hero.you")} · ${name}` : t("mycard.title", { name })) : t("hero.trip")),
        state.members.length > 1 && viewAsSelect()),
      bal
        ? h("p", { class: "hero-net md-typescale-headline-medium tabular", dataset: { testid: "my-net" } }, net)
        : h("p", { class: "hero-net md-typescale-headline-medium tabular" }, state.bills.length ? money(summary.total) : t("hero.nothingYet")),
      bal && h("p", { class: "md-typescale-body-medium hero-sub tabular" }, t("mycard.spent", { paid: money(bal.paid), owed: money(bal.owed) })),
      actions.length > 0 && h("ul", { class: "hero-actions", "aria-label": t("summary.whoPays") }, actions),
      h("p", { class: "md-typescale-body-medium hero-sub hero-stats" },
        bal && h("span", { class: "tabular" }, `${t("hero.trip")} ${money(summary.total)} · `),
        t("hero.stats", { bills: tn("billCount", state.bills.length), people: tn("people", state.members.length) }),
        tripDates() && h("span", { dataset: { testid: "trip-dates" } }, ` · ${tripDates()}`)),
      budgetBar());
  }

  /** "฿7,700 left of ฿20,000" + bar; amber from 80 %, red when over (#4). Spent = expenses (not payments). */
  function budgetText() {
    const b = state.group.budget;
    if (!b) return null;
    const spent = state.summary.total;
    const used = spent / b;
    const text = spent > b
      ? t("budget.over", { amount: money(spent - b), budget: money(b) })
      : t("budget.left", { amount: money(b - spent), budget: money(b) });
    // With an end date (v0.11): what's left per day from today to the last day.
    const today = localToday();
    const end = state.group.endDate;
    const daysLeft = end && end >= today && spent < b ? Math.round((Date.parse(end) - Date.parse(today < (state.group.startDate ?? today) ? state.group.startDate! : today)) / 86_400_000) + 1 : 0;
    const pace = daysLeft > 0 ? tn("budget.pace", daysLeft, { amount: money(Math.floor((b - spent) / daysLeft)) }) : null;
    return { text, used, tone: used > 1 ? "over" : used >= 0.8 ? "warn" : "ok", pace };
  }

  function budgetBar() {
    const bt = budgetText();
    if (!bt) return null;
    const pct = Math.round(bt.used * 100);
    return h("div", { class: `budget ${bt.tone}`, dataset: { testid: "budget" } },
      h("div", { class: "budget-top md-typescale-body-medium" },
        h("span", { class: "tabular", dataset: { testid: "budget-text" } }, bt.text),
        h("span", { class: "tabular budget-pct" }, `${pct}%`)),
      bt.pace && h("div", { class: "md-typescale-body-small budget-pace tabular", dataset: { testid: "budget-pace" } }, bt.pace),
      h("div", { class: "budget-track", role: "progressbar", "aria-label": t("budget.label"), "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.min(pct, 100)) },
        h("div", { class: "budget-fill", style: `width:${Math.min(100, bt.used * 100)}%` })));
  }

  function summaryPanel() {
    const { summary } = state;
    const settlements = summary.settlements.length
      ? h("md-list", { dataset: { testid: "settlements" }, "aria-label": t("summary.whoPays") },
          summary.settlements.map((s) => {
            const dim = viewAs && s.from !== viewAs && s.to !== viewAs;
            return h("md-list-item", { class: dim ? "dim" : "", dataset: { testid: "settlement" } },
              h("div", { slot: "headline" }, h("strong", null, memberName(s.from)), t("summary.paysInfix"), h("strong", null, memberName(s.to))),
              h("div", { slot: "supporting-text", class: "md-typescale-title-medium amount-owed tabular" }, money(s.amount)),
              h("div", { slot: "end", class: "row settle-actions" },
                !isView && remindButton(s, "remind-btn"),
                !readOnly() && h("md-filled-tonal-button", { onclick: () => addBill({ from: s.from, to: s.to, amount: s.amount }), dataset: { testid: "settle-btn" },
                  "aria-label": t("summary.settleAria", { from: memberName(s.from), to: memberName(s.to), amount: money(s.amount) }) }, t("summary.settle"))));
          }))
      : h("div", { class: "settled", dataset: { testid: "all-settled" } }, icon("check_circle"), h("span", { class: "md-typescale-body-large" }, t("summary.allSettled")));

    // Custom rows (not md-list-item): its end slot squeezed and cut off amounts on phones.
    const balances = h("div", { class: "balances", dataset: { testid: "balances" }, role: "list" },
      summary.balances.map((b) =>
        h("div", { class: `balance-row ${viewAs === b.memberId ? "me" : ""}`, role: "listitem", dataset: { testid: "balance-row" } },
          h("div", { class: "avatar initial", "aria-hidden": "true" }, initial(memberName(b.memberId))),
          h("div", { class: "balance-main" },
            h("div", { class: "balance-top" },
              h("span", { class: "md-typescale-body-large balance-name" }, memberName(b.memberId)),
              h("span", { class: `md-typescale-title-small tabular net ${b.net > 0 ? "pos" : b.net < 0 ? "neg" : ""}`, dataset: { testid: "balance-net" } },
                b.net > 0 ? t("balance.gets", { amount: money(b.net) }) : b.net < 0 ? t("balance.owes", { amount: money(-b.net) }) : t("balance.settled"))),
            h("div", { class: "md-typescale-body-medium muted balance-detail", dataset: { testid: "balance-detail" } },
              h("span", { class: "tabular" }, t("balance.paid", { amount: money(b.paid) })),
              h("span", { class: "tabular" }, t("balance.share", { amount: money(b.owed) })))))));

    return h("div", { class: "stack-lg" },
      h("section", { class: "card flush", "aria-labelledby": "pays-title" },
        h("div", { class: "card-head" }, h("h2", { class: "md-typescale-title-medium", id: "pays-title" }, t("summary.whoPays")),
          !isView && summary.settlements.length > 1 && h("md-text-button", { onclick: () => void remindEveryone(), dataset: { testid: "remind-all" } },
            icon("share", "icon"), t("remind.all"))),
        settlements),
      h("section", { class: "card flush", "aria-labelledby": "bal-title" }, h("div", { class: "card-head" }, h("h2", { class: "md-typescale-title-medium", id: "bal-title" }, t("summary.balances"))), balances),
      categoryChart(),
      dayChart(),
      settleHistory(),
      statsMod && (() => {
        const st = statsMod!.computeStats(state.bills, state.members);
        return st ? statsMod!.statsCard(st, money, memberName) : null;
      })());
  }

  // ---------- reminders (#6): a message to send through the phone's share sheet ----------
  const tripUrl = () => `${location.origin}/g/${encodeURIComponent(gid)}`;
  const debt = (s: { from: string; to: string; amount: number }) => ({ from: memberName(s.from), to: memberName(s.to), amount: money(s.amount) });

  function remindButton(s: { from: string; to: string; amount: number }, testid: string) {
    return h("md-icon-button", {
      dataset: { testid }, title: t("remind.aria", { name: memberName(s.from) }), "aria-label": t("remind.aria", { name: memberName(s.from) }),
      onclick: async (e: Event) => {
        e.stopPropagation();
        const r = await loadRemind();
        const pp = state.members.find((m) => m.id === s.to)?.promptpay ?? null;
        await r.shareText(state.group.name, r.reminderText(state.group.name, debt(s), pp, tripUrl()));
      },
    }, icon("notifications"));
  }

  async function remindEveryone() {
    const r = await loadRemind();
    await r.shareText(state.group.name, r.everyoneText(state.group.name, state.summary.settlements.map(debt), tripUrl()));
  }

  // ---------- summary image (#10) ----------
  async function summaryImage() {
    const { summaryPng } = await loadImage();
    const { summary } = state;
    const bt = budgetText();
    const blob = await summaryPng({
      trip: state.group.name,
      subtitle: `${t("hero.trip")} ${money(summary.total)} · ${t("hero.stats", { bills: tn("billCount", state.bills.length), people: tn("people", state.members.length) })}`,
      budget: bt?.text ?? null,
      budgetUsed: bt?.used ?? null,
      balancesTitle: t("summary.balances"),
      balances: summary.balances.map((b) => ({
        name: memberName(b.memberId),
        text: b.net > 0 ? t("balance.gets", { amount: money(b.net) }) : b.net < 0 ? t("balance.owes", { amount: money(-b.net) }) : t("balance.settled"),
        tone: b.net > 0 ? "pos" : b.net < 0 ? "neg" : "zero",
      })),
      paysTitle: t("summary.whoPays"),
      pays: summary.settlements.map((s) => ({ text: `${memberName(s.from)} → ${memberName(s.to)}`, amount: money(s.amount) })),
      settled: t("summary.allSettled"),
      footer: t("image.footer", { date: new Date().toLocaleDateString(locale(), { dateStyle: "medium" }) }),
    });
    const url = URL.createObjectURL(blob);
    const { safeFilename } = await loadExport();
    const filename = `${safeFilename(state.group.name)}-summary.png`;
    const file = new File([blob], filename, { type: "image/png" });
    const canShare = !!navigator.canShare?.({ files: [file] });
    const d = h("md-dialog", { dataset: { testid: "image-dialog" } },
      h("div", { slot: "headline" }, t("image.title")),
      h("div", { slot: "content", class: "stack" },
        h("img", { src: url, alt: t("image.alt", { name: state.group.name }), class: "summary-image", dataset: { testid: "summary-image" } })),
      h("div", { slot: "actions" },
        h("md-text-button", { onclick: () => d.close("cancel") }, t("common.close")),
        // One element (a link styled as a button): a button inside a link has no accessible name (axe, #13).
        h("md-outlined-button", { href: url, download: filename, dataset: { testid: "image-download" } }, icon("download", "icon"), t("image.download")),
        canShare && h("md-filled-button", { dataset: { testid: "image-share" }, onclick: async () => {
          try { await navigator.share({ files: [file], title: state.group.name }); } catch { /* cancelled */ }
        } }, icon("share", "icon"), t("image.share")))) as MdDialog;
    await openDialog(d);
    URL.revokeObjectURL(url);
  }

  function settleHistory() {
    const pays = state.bills.filter((b) => b.kind === "payment");
    if (!pays.length) return null;
    const sum = pays.reduce((a, b) => a + b.amount, 0);
    return h("section", { class: "card flush", "aria-labelledby": "settle-hist-title", dataset: { testid: "settle-history" } },
      h("div", { class: "card-head" }, h("h2", { class: "md-typescale-title-medium", id: "settle-hist-title" }, t("summary.history")),
        h("span", { class: "md-typescale-body-medium muted" }, `${pays.length} · ${money(sum)}`)),
      h("md-list", { "aria-label": t("summary.payments") }, pays.map((b) =>
        h("md-list-item", { type: readOnly() ? "text" : "button", onclick: () => editBill(b), dataset: { testid: "settle-history-item" } },
          icon("payments", "start"),
          h("div", { slot: "headline" }, `${memberName(b.paidBy)} → ${memberName(b.shares[0]?.memberId ?? "")}`),
          h("div", { slot: "supporting-text" }, formatDate(b.date)),
          h("div", { slot: "end", class: "md-typescale-title-small tabular" }, money(b.amount))))));
  }

  // ---------- subgroups (#6) ----------
  async function editSubgroup(sg: Subgroup | null) {
    const sel = new Set(sg?.memberIds ?? []);
    const name = h("md-outlined-text-field", { label: t("common.name"), value: sg?.name ?? "", maxLength: 40, dataset: { testid: "subgroup-name" } }) as Field;
    const err = h("div", { class: "form-error", role: "alert" });
    const d = h("md-dialog", { dataset: { testid: "subgroup-dialog" } },
      h("div", { slot: "headline" }, sg ? t("subgroup.edit") : t("subgroup.new")),
      h("div", { slot: "content", class: "stack" }, name,
        h("div", { class: "split-list", role: "group", "aria-label": t("subgroup.members") }, state.members.map((m) =>
          h("label", { class: "split-row" },
            h("md-checkbox", { checked: sel.has(m.id), "aria-label": m.name, dataset: { testid: `subgroup-check-${m.name}` },
              onchange: (e: Event) => ((e.target as HTMLElement & { checked: boolean }).checked ? sel.add(m.id) : sel.delete(m.id)) }),
            h("span", { class: "grow" }, m.name)))),
        err),
      h("div", { slot: "actions" },
        sg && h("md-text-button", { class: "danger push-left", dataset: { testid: "subgroup-delete" }, onclick: async () => {
          await api.deleteSubgroup(gid, sg.id);
          d.close("ok");
          // Undo (#12): a saved group is only a shortcut, so putting it back = saving it again.
          snackbar(t("subgroup.deleted", { name: sg.name }), { label: t("common.undo"), run: async () => {
            try {
              await api.saveSubgroup(gid, { name: sg.name, memberIds: sg.memberIds.filter((id) => state.members.some((m) => m.id === id)) });
              refresh();
            } catch (e) {
              snackbar(e instanceof Error ? e.message : t("common.restoreFailed"));
            }
          } });
        } }, t("common.delete")),
        h("md-text-button", { onclick: () => d.close("cancel") }, t("common.cancel")),
        h("md-filled-button", { dataset: { testid: "subgroup-save" }, onclick: async () => {
          try {
            await api.saveSubgroup(gid, { id: sg?.id, name: name.value, memberIds: state.members.filter((m) => sel.has(m.id)).map((m) => m.id) });
            d.close("ok");
          } catch (e) {
            err.textContent = e instanceof Error ? e.message : t("common.saveFailed");
          }
        } }, t("common.save")))) as MdDialog;
    if ((await openDialog(d)) === "ok") refresh();
  }

  function subgroupsPanel() {
    if (isView) return null;
    return h("section", { class: "card flush", "aria-labelledby": "subgroups-title", dataset: { testid: "subgroups" } },
      h("div", { class: "card-head" }, h("h2", { class: "md-typescale-title-medium", id: "subgroups-title" }, t("subgroup.title"))),
      state.subgroups.length
        ? h("md-list", { "aria-label": t("subgroup.title") }, state.subgroups.map((sg) =>
            h("md-list-item", { type: readOnly() ? "text" : "button", onclick: () => !readOnly() && editSubgroup(sg), dataset: { testid: "subgroup-item" } },
              icon("groups", "start"),
              h("div", { slot: "headline" }, sg.name),
              h("div", { slot: "supporting-text" }, sg.memberIds.map(memberName).join(", ")))))
        : h("p", { class: "pad md-typescale-body-medium muted" }, t("subgroup.help")),
      !readOnly() && h("div", { class: "row pad" },
        h("md-text-button", { onclick: () => editSubgroup(null), dataset: { testid: "subgroup-add" } }, icon("add", "icon"), t("subgroup.new"))));
  }

  // ---------- read-only link (#12) + merge (#10) ----------
  async function viewLinkSection() {
    const host = h("div", { class: "stack-sm", dataset: { testid: "view-link-section" } });
    const paint = (vid: string | null) => {
      const url = vid ? `${location.origin}/v/${vid}` : null;
      clear(host,
        h("h2", { class: "md-typescale-title-small" }, t("view.title")),
        h("p", { class: "md-typescale-body-small muted" }, url
          ? t("view.help")
          : t("view.helpNone")),
        url && h("div", { class: "link-box md-typescale-body-small", dataset: { testid: "view-link-url" } }, url),
        h("div", { class: "row wrap" },
          url && h("md-outlined-button", { dataset: { testid: "view-link-copy" }, onclick: async () => {
            try { await navigator.clipboard.writeText(url); snackbar(t("view.copied")); } catch { snackbar(url); }
          } }, icon("content_copy", "icon"), t("common.copy")),
          !state.group.archived && h("md-text-button", { dataset: { testid: url ? "view-link-rotate" : "view-link-create" }, onclick: async () => {
            paint((await api.createViewLink(gid)).viewId);
            snackbar(url ? t("view.rotated") : t("view.created"));
          } }, url ? t("view.new") : t("view.create")),
          url && h("md-text-button", { class: "danger", dataset: { testid: "view-link-revoke" }, onclick: async () => {
            await api.revokeViewLink(gid);
            paint(null);
            snackbar(t("view.off"));
          } }, t("view.turnOff"))));
    };
    paint(null);
    api.viewLink(gid).then((r) => paint(r.viewId)).catch(() => {});
    return host;
  }

  async function mergeFlow() {
    const { pickGroupDialog, withMissingMembers } = await loadMove();
    const source = await pickGroupDialog(
      t("merge.title"),
      t("merge.help", { currency: state.group.currency }),
      gid, state.group.currency);
    if (!source) return;
    if (!(await confirmDialog(t("merge.confirmTitle"), t("merge.confirmText"), t("settings.merge")))) return;
    try {
      const r = await withMissingMembers((add) => api.merge(gid, source, add));
      if (!r) return;
      snackbar(tn("merge.done", r.moved) + (r.addedMembers.length ? t("merge.added", { names: r.addedMembers.join(", ") }) : ""));
      refresh();
    } catch (e) {
      snackbar(e instanceof Error ? e.message : t("merge.failed"));
    }
  }

  // ---------- first-visit tips (#17) ----------
  function tipsBanner() {
    if (readOnly() || local.get("share.tipsDismissed")) return null;
    // One slim line (expand for the list): it used to push the first bill below the fold on phones.
    const el = h("section", { class: "tips", role: "note", dataset: { testid: "tips" } },
      h("details", { class: "grow" },
        h("summary", { class: "md-typescale-label-large" }, icon("info"), t("tips.title")),
        h("ul", { class: "md-typescale-body-medium" },
          h("li", null, t("tips.1")),
          h("li", null, t("tips.2")),
          h("li", null, t("tips.3")),
          h("li", null, t("tips.4")))),
      h("md-icon-button", { "aria-label": t("tips.dismiss"), dataset: { testid: "tips-dismiss" }, onclick: () => { local.set("share.tipsDismissed", "1"); el.remove(); } }, icon("close")));
    return el;
  }

  function membersPanel() {
    return h("section", { class: "card flush", "aria-labelledby": "people-title" },
      h("div", { class: "card-head" }, h("h2", { class: "md-typescale-title-medium", id: "people-title" }, t("tab.members")), h("span", { class: "muted md-typescale-body-medium" }, String(state.members.length))),
      h("md-list", { dataset: { testid: "members-list" }, "aria-label": t("tab.members") },
        state.members.map((m) =>
          h("md-list-item", { dataset: { testid: "member-item" } },
            h("div", { slot: "start", class: "avatar initial", "aria-hidden": "true" }, initial(m.name)),
            h("div", { slot: "headline" }, m.name, m.id === state.me && h("span", { class: "you-tag", dataset: { testid: "member-you" } }, t("member.you"))),
            // Emails are only shown inside the trip (never in view links); service-token ids stay hidden.
            !isView && h("div", { slot: "supporting-text", class: m.email ? "" : "muted", dataset: { testid: "member-email" } },
              m.email ? (m.email.startsWith("svc:") ? t("member.serviceToken") : m.email) : t("member.noEmail")),
            m.promptpay && h("div", { slot: "supporting-text" }, "PromptPay ✓"),
            !readOnly() && h("div", { slot: "end", class: "row tight" },
              h("md-icon-button", { "aria-label": t("member.edit", { name: m.name }), onclick: () => editMember(m), dataset: { testid: `edit-member-${m.name}` } }, icon("edit")),
              h("md-icon-button", {
                "aria-label": t("member.removeAria", { name: m.name }), dataset: { testid: `remove-member-${m.name}` },
                onclick: async () => {
                  if (!(await confirmDialog(t("member.removeTitle", { name: m.name }), t("member.removeText"), t("common.remove")))) return;
                  try {
                    await api.deleteMember(gid, m.id);
                    refresh();
                  } catch (e) {
                    snackbar(e instanceof ApiError && e.code === "last_link" ? t("member.lastLink") : e instanceof Error ? e.message : t("member.removeFailed"));
                  }
                },
              }, icon("person_remove")))))),
      !readOnly() && h("div", { class: "row pad" },
        h("md-filled-tonal-button", { onclick: () => editMember(null), dataset: { testid: "add-member-btn" } }, icon("person_add", "icon"), t("member.add"))),
      !readOnly() && inviteSection());
  }

  // ---------- invite link (v0.6) ----------
  /** The token is returned only when created (the server keeps its hash): kept here across re-renders. */
  let inviteShown: { token: string; expiresAt: string } | null = null;

  function inviteSection() {
    const host = h("div", { class: "stack-sm pad invite-section", dataset: { testid: "invite-section" } });
    const day = (iso: string) => new Date(iso).toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" });
    const make = async (rotate: boolean) => {
      try {
        inviteShown = await api.createInvite(gid);
        paint({ active: true, expiresAt: inviteShown.expiresAt });
        snackbar(rotate ? t("invite.rotated") : t("invite.created"));
      } catch (e) {
        snackbar(e instanceof Error ? e.message : t("common.saveFailed"));
      }
    };
    const paint = (st: InviteStatus) => {
      state.invite = st;
      // Someone else rotated or turned it off meanwhile: the token we hold no longer works.
      if (!st.active || (inviteShown && st.expiresAt !== inviteShown.expiresAt)) inviteShown = null;
      const url = st.active && inviteShown ? `${location.origin}/join/${inviteShown.token}` : null;
      clear(host,
        h("h3", { class: "md-typescale-title-small row tight" }, icon("link"), t("invite.title")),
        h("p", { class: "md-typescale-body-small muted", dataset: { testid: "invite-status" } },
          url ? t("invite.help") : st.active && st.expiresAt ? t("invite.activeUntil", { date: day(st.expiresAt) }) : t("invite.helpNone")),
        url && h("div", { class: "link-box md-typescale-body-small", dataset: { testid: "invite-url" } }, url),
        url && h("p", { class: "md-typescale-body-small muted" }, t("invite.expires", { date: day(inviteShown!.expiresAt) }), " · ", t("invite.accessNote")),
        h("div", { class: "row wrap" },
          url && h("md-filled-tonal-button", { dataset: { testid: "invite-copy" }, onclick: async () => {
            try { await navigator.clipboard.writeText(url); snackbar(t("invite.copied")); } catch { snackbar(url); }
          } }, icon("content_copy", "icon"), t("common.copy")),
          url && typeof navigator.share === "function" && h("md-outlined-button", { dataset: { testid: "invite-share" }, onclick: () => {
            navigator.share({ title: state.group.name, text: t("invite.shareText", { name: state.group.name }), url }).catch(() => undefined);
          } }, icon("share", "icon"), t("group.shareLink")),
          h(st.active ? "md-text-button" : "md-outlined-button", { dataset: { testid: st.active ? "invite-rotate" : "invite-create" }, onclick: () => make(st.active) },
            st.active ? t("invite.new") : t("invite.create")),
          st.active && h("md-text-button", { class: "danger", dataset: { testid: "invite-revoke" }, onclick: async () => {
            try {
              await api.revokeInvite(gid);
              paint({ active: false, expiresAt: null });
              snackbar(t("invite.off"));
            } catch (e) {
              snackbar(e instanceof Error ? e.message : t("common.saveFailed"));
            }
          } }, t("invite.turnOff"))));
    };
    // Status comes with the page (GET …/full): no extra request.
    paint(state.invite ?? { active: false, expiresAt: null });
    host.dataset.ready = "1";
    return host;
  }

  function activityPanel() {
    const host = h("div");
    let items = state.activity;
    const render = () => clear(host,
      items.length
        ? h("ol", { class: "activity-list", dataset: { testid: "activity-list" } }, items.map((a) =>
            h("li", { class: "activity-item", dataset: { testid: "activity-item" } },
              h("div", { class: "activity-text md-typescale-body-medium" }, describe(a)),
              h("div", { class: "md-typescale-body-small muted" }, `${a.actor ?? t("activity.someone")} · `, h("time", { dateTime: a.at }, relTime(a.at))),
              a.restorable && !readOnly() && h("md-text-button", { dataset: { testid: "activity-restore" }, onclick: async () => {
                await api.restoreBill(gid, a.entityId!);
                snackbar(t("bill.restored"));
                refresh();
              } }, icon("undo", "icon"), t("common.restore")))))
        : h("p", { class: "pad muted" }, t("activity.none")),
      items.length >= 50 && h("div", { class: "row pad" }, h("md-text-button", { onclick: async () => {
        const more = await api.activity(gid, items[items.length - 1].at);
        items = [...items, ...more.activity];
        render();
      } }, t("activity.more"))));
    render();
    return h("section", { class: "card flush", "aria-labelledby": "act-title" },
      h("div", { class: "card-head" }, h("h2", { class: "md-typescale-title-medium", id: "act-title" }, t("tab.activity")),
        h("md-text-button", { onclick: showRecurring, dataset: { testid: "open-recurring" } }, icon("repeat", "icon"), t("recurring.short"))),
      host);
  }

  function describe(a: Activity): string {
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

  function viewAsSelect() {
    const sel = h("md-outlined-select", { quick: true, label: t("viewAs.label"), class: "view-as", dataset: { testid: "view-as" } },
      h("md-select-option", { value: "all", selected: !viewAs }, h("div", { slot: "headline" }, t("common.everyone"))),
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
    const tabs = h("md-tabs", { class: "group-tabs", activeTabIndex: TABS.indexOf(tab), "aria-label": t("group.sections"), dataset: { testid: "tabs" } },
      h("md-primary-tab", { dataset: { testid: "tab-bills" }, "aria-controls": "panel-bills" }, icon("receipt_long", "icon"), t("tab.bills")),
      h("md-primary-tab", { dataset: { testid: "tab-summary" }, "aria-controls": "panel-summary" }, icon("account_balance_wallet", "icon"), t("tab.summary")),
      h("md-primary-tab", { dataset: { testid: "tab-members" }, "aria-controls": "panel-members" }, icon("group", "icon"), t("tab.members")),
      !isView && h("md-primary-tab", { dataset: { testid: "tab-activity" }, "aria-controls": "panel-activity" }, icon("history", "icon"), t("tab.activity")));
    tabs.addEventListener("change", () => {
      tab = TABS[(tabs as unknown as { activeTabIndex: number }).activeTabIndex];
      session.set(`tab:${gid}`, tab);
      layout.dataset.tab = tab;
      window.scrollTo(0, 0);
    });

    const panel = (id: Tab, body: Node) => h("div", { class: `panel panel-${id}`, id: `panel-${id}`, role: "tabpanel", "aria-label": t(`tab.${id}`) }, body);
    const layout = h("main", { class: "page group-layout", dataset: { tab }, id: "main" },
      isView && h("div", { class: "banner", role: "status", dataset: { testid: "view-banner" } },
        icon("info"), h("span", { class: "grow" }, t("group.viewBanner"))),
      !isView && readOnly() && h("div", { class: "banner", role: "status", dataset: { testid: "archived-banner" } },
        icon("archive"), h("span", { class: "grow" }, t("group.archivedBanner")),
        h("md-text-button", { onclick: async () => { await api.updateGroup(gid, { archived: false }); snackbar("Group unarchived"); refresh(); }, dataset: { testid: "banner-unarchive" } }, t("settings.unarchive"))),
      offlineAt && h("div", { class: "banner offline", role: "status", dataset: { testid: "offline-banner" } },
        icon("cloud_off"), h("span", { class: "grow" }, t("offline.banner", { when: relTime(offlineAt) }))),
      tipsBanner(),
      tripHeader(),
      // Two columns on laptops (bills + activity | summary + people); on phones one panel at a time (tabs).
      h("div", { class: "cols" },
        h("div", { class: "col-main stack-lg" },
          panel("bills", billsPanel()),
          !isView && panel("activity", activityPanel())),
        h("div", { class: "col-side stack-lg" },
          panel("summary", summaryPanel()),
          panel("members", h("div", { class: "stack-lg" }, membersPanel(), subgroupsPanel())))));

    clear(root,
      h("a", { class: "skip-link", href: "#main" }, t("group.skip")),
      appBar(state.group.name, isView ? [] : [
        h("md-icon-button", { "aria-label": t("group.shareLink"), onclick: share, dataset: { testid: "share-link" } }, icon("share")),
        ...overflowMenu(),
      ]),
      pullIndicator,
      tabs,
      layout,
      !readOnly() && h("md-fab", { class: "fab narrow-only", variant: "primary", label: t("bill.add"), "aria-label": t("bill.add"), onclick: () => addBill(), dataset: { testid: "add-bill" } },
        icon("add", "icon")),
      printView());
    if (focusId) root.querySelector<HTMLElement>(`[data-testid="${focusId}"]`)?.focus();
  }

  const pullIndicator = h("div", { class: "pull-indicator", "aria-hidden": "true" }, icon("undo"));
  attachPullToRefresh(pullIndicator, async () => {
    await refresh();
    snackbar(t("group.upToDate"));
  });

  /** Print-only report (hidden on screen): bills table + balances + settlements. */
  function printView() {
    const cur = state.group.currency;
    return h("section", { class: "print-only", "aria-hidden": "true" },
      h("h1", null, state.group.name),
      h("p", null, t("print.header", { date: new Date().toLocaleString(locale()), total: money(state.summary.total), cur })),
      h("h2", null, t("summary.whoPays")),
      state.summary.settlements.length
        ? h("ul", null, state.summary.settlements.map((s) => h("li", null, t("print.pays", { from: memberName(s.from), to: memberName(s.to), amount: money(s.amount) }))))
        : h("p", null, t("print.settled")),
      h("h2", null, t("summary.balances")),
      h("table", null, h("thead", null, h("tr", null, [t("print.person"), t("print.paid"), t("print.share"), t("print.net")].map((x) => h("th", null, x)))),
        h("tbody", null, state.summary.balances.map((b) => h("tr", null, h("td", null, memberName(b.memberId)), h("td", null, money(b.paid)), h("td", null, money(b.owed)), h("td", null, money(b.net)))))),
      h("h2", null, t("tab.bills")),
      h("table", null, h("thead", null, h("tr", null, [t("print.date"), t("print.description"), t("print.category"), t("print.paidBy"), t("print.amount")].map((x) => h("th", null, x)))),
        h("tbody", null, state.bills.map((b) => h("tr", null,
          h("td", null, b.date), h("td", null, b.description), h("td", null, b.kind === "payment" ? t("bill.payment") : categoryInfo(b.category, state.categories).label),
          h("td", null, b.payers.map((p) => memberName(p.memberId)).join(" & ")), h("td", null, money(b.amount)))))));
  }

  // ---------- live refresh (#12): other people's changes show up without reloading ----------
  // Polls a tiny version token while the page is visible and reloads when it moved. Skips a beat while a dialog is
  // open or a save is in flight (a refresh then would fight the user); our own saves refresh themselves.
  // ---------- keyboard shortcuts (#11): N new bill · / search · S settle up · H home · ? help ----------
  function showTab(id: Tab) {
    tab = id;
    session.set(`tab:${gid}`, tab);
    const tabs = root.querySelector("md-tabs") as (HTMLElement & { activeTabIndex: number }) | null;
    if (tabs) tabs.activeTabIndex = TABS.indexOf(id);
    const layout = root.querySelector<HTMLElement>("main.group-layout");
    if (layout) layout.dataset.tab = id;
  }

  async function shortcutsHelp() {
    const rows: [string, string][] = [["N", t("keys.new")], ["/", t("keys.search")], ["S", t("keys.settle")], ["H", t("keys.home")], ["?", t("keys.help")]];
    const d = h("md-dialog", { dataset: { testid: "shortcuts-dialog" } },
      h("div", { slot: "headline" }, t("keys.title")),
      h("div", { slot: "content" },
        h("dl", { class: "shortcuts" }, rows.map(([k, v]) => [h("dt", null, h("kbd", null, k)), h("dd", null, v)]))),
      h("div", { slot: "actions" }, h("md-text-button", { onclick: () => d.close("ok") }, t("common.close")))) as MdDialog;
    await openDialog(d);
  }

  function startShortcuts() {
    if (isView) return;
    const keys: Record<string, () => void> = {
      n: () => void addBill(),
      "/": () => {
        showTab("bills");
        root.querySelector<HTMLElement>("[data-testid=bill-search]")?.focus();
      },
      s: () => {
        showTab("summary");
        const first = root.querySelector<HTMLElement>("[data-testid=settle-btn]") ?? root.querySelector<HTMLElement>("#pays-title");
        first?.scrollIntoView({ block: "center" });
        first?.focus();
      },
      h: () => navigate("/"),
      "?": () => void shortcutsHelp(),
    };
    const onKey = (e: KeyboardEvent) => {
      if (!stillHere() || gen !== pageGen) return document.removeEventListener("keydown", onKey);
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      // Typing somewhere (the real target can sit inside a component's shadow DOM), or a dialog/menu is up.
      const target = e.composedPath()[0] as HTMLElement | undefined;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (document.querySelector("md-dialog[open], md-menu[open]")) return;
      const run = keys[e.key.length === 1 ? e.key.toLowerCase() : e.key];
      if (!run) return;
      e.preventDefault();
      run();
    };
    document.addEventListener("keydown", onKey);
  }

  function startLiveRefresh() {
    if (isView) return;
    const every = Number(local.get("share.pollMs")) || 15_000; // E2E shortens it
    let timer = 0;
    const tick = async () => {
      clearTimeout(timer);
      if (!stillHere() || gen !== pageGen) return;
      timer = window.setTimeout(tick, every);
      if (document.hidden || pending.size || document.querySelector("md-dialog[open]")) return;
      if (queued(gid).length) await flushOutbox();
      if (offlineAt) return void refresh(); // showing the offline copy: any answer from the server replaces it
      try {
        const { v } = await api.version(gid);
        if (!stillHere() || v === state.version) return;
        const fromOthers = Date.now() - lastOwnRefresh > 10_000;
        await refresh();
        if (fromOthers && stillHere()) snackbar(t("live.updated"));
      } catch { /* offline or signed out: try again next tick */ }
    };
    timer = window.setTimeout(tick, every);
    const onVisible = () => {
      if (!stillHere() || gen !== pageGen) return document.removeEventListener("visibilitychange", onVisible);
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    const onOnline = () => {
      if (!stillHere() || gen !== pageGen) return window.removeEventListener("online", onOnline);
      void tick();
    };
    window.addEventListener("online", onOnline);
  }

  if ((await load()) && stillHere()) {
    render();
    startLiveRefresh();
    startShortcuts();
    if (!offlineAt) void flushOutbox();
    // Fetch the bill dialog once the page is up (still not in the first paint): adding a bill then works even if
    // the connection drops before the first Add (#8), with or without the service worker.
    setTimeout(() => void loadBillDialog().catch(() => undefined), 500);
  }
}

function initial(name: string) {
  return [...name.trim()][0]?.toUpperCase() ?? "?";
}

function formatDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function relTime(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
  if (s < 60) return rtf.format(-Math.round(s), "second");
  if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  if (s < 86400 * 7) return rtf.format(-Math.round(s / 86400), "day");
  return new Date(iso).toLocaleDateString(locale());
}

const wrap = (s: () => Storage) => ({
  get: (k: string) => { try { return s().getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { s().setItem(k, v); } catch { /* ignore */ } },
  remove: (k: string) => { try { s().removeItem(k); } catch { /* ignore */ } },
});
const session = wrap(() => sessionStorage);
const local = wrap(() => localStorage);
