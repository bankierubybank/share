// Trip settings, split out of group.ts (v0.12, #24): name / currency / budget / dates, read-only link, the trip's
// categories, notifications, merge, archive, delete and leave. Lazy: loaded the first time Settings opens.
import { api, ApiError, type CustomCategory } from "../api";
import { clear, h, icon, snackbar } from "../dom";
import { confirmDialog, openDialog, type MdDialog } from "../dialogs";
import { CURRENCIES, formatMoney, parseMoney, toInput } from "../money";
import { categoryInfo } from "../categories";
import { forgetGroup } from "../store";
import { navigate } from "../router";
import { t, tn } from "../i18n";
import type { State } from "./group";

type Field = HTMLElement & { value: string; error: boolean; errorText: string; focus(): void };
const loadMove = () => import("./move");

export interface SettingsCtx {
  gid: string;
  /** The page's current state (read on every use: the page re-renders with new data). */
  state: () => State;
  isView: boolean;
  refresh: () => unknown;
}

export function settings({ gid, state: st, isView, refresh }: SettingsCtx) {
  async function editGroup() {
    const state = st();
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
              icon("delete_forever", "icon"), t("settings.deleteGroup")),
            state.me && h("md-text-button", { class: "danger", dataset: { testid: "leave-trip" }, onclick: async () => { d.close("cancel"); await leaveFlow(); } },
              icon("logout", "icon"), t("leave.button")))),
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
  /** Re-open Settings so the notifications button shows its new st(). */
  const editGroupAgain = () => {
    document.querySelector<MdDialog>("md-dialog[data-testid=settings-dialog]")?.close("cancel");
    setTimeout(() => void editGroup(), 0);
  };

  async function deleteGroupFlow() {
    const field = h("md-outlined-text-field", { label: t("delete.confirmLabel"), dataset: { testid: "delete-confirm-input" } }) as Field;
    const btn = h("md-filled-button", { class: "danger-filled", disabled: true, dataset: { testid: "delete-confirm" } }, t("delete.forever")) as HTMLElement & { disabled: boolean };
    field.addEventListener("input", () => (btn.disabled = field.value.trim() !== st().group.name));
    const d = h("md-dialog", { type: "alert", dataset: { testid: "delete-dialog" } },
      h("div", { slot: "headline" }, t("delete.title", { name: st().group.name })),
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
      const name = st().group.name;
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
          !st().group.archived && h("md-text-button", { dataset: { testid: url ? "view-link-rotate" : "view-link-create" }, onclick: async () => {
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
      t("merge.help", { currency: st().group.currency }),
      gid, st().group.currency);
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

  /** Leave the trip (v0.12, #6): unlinks me; my name and bills stay. Checked here first, the server decides. */
  async function leaveFlow() {
    const name = st().group.name;
    const mine = st().summary.balances.find((b) => b.memberId === st().me)?.net ?? 0;
    if (st().members.filter((m) => m.email).length <= 1) return snackbar(t("leave.last"));
    if (mine !== 0) return snackbar(t("leave.unsettled", { amount: formatMoney(mine, st().group.currency) }));
    if (!(await confirmDialog(t("leave.title", { name }), t("leave.text"), t("leave.confirm")))) return;
    try {
      await api.leaveTrip(gid);
    } catch (e) {
      return snackbar(e instanceof ApiError && e.code === "unsettled" ? t("leave.unsettledShort") : e instanceof ApiError && e.code === "last_link" ? t("leave.last")
        : e instanceof Error ? e.message : t("common.saveFailed"));
    }
    forgetGroup(gid);
    navigate("/", true);
    snackbar(t("leave.done", { name }));
  }

  return { editGroup };
}
