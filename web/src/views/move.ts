// Pick another group (recent list or pasted link) for moving a bill or merging groups (#10).
import { ApiError, parseGroupRef } from "../api";
import { h, icon } from "../dom";
import { t } from "../i18n";
import { confirmDialog, openDialog, type MdDialog } from "../dialogs";
import { recentGroups } from "../store";

type Field = HTMLElement & { value: string; error: boolean; errorText: string };

/** Resolves with the chosen group id, or null if cancelled. */
export async function pickGroupDialog(title: string, help: string, excludeId: string, currency: string): Promise<string | null> {
  let chosen: string | null = null;
  const others = recentGroups().filter((g) => g.id !== excludeId && !g.archived);
  const paste = h("md-outlined-text-field", { label: t("move.pasteLabel"), dataset: { testid: "pick-group-input" } }) as Field;
  const d = h("md-dialog", { dataset: { testid: "pick-group-dialog" } },
    h("div", { slot: "headline" }, title),
    h("div", { slot: "content", class: "stack" },
      h("p", { class: "md-typescale-body-medium muted" }, help),
      others.length
        ? h("md-list", { "aria-label": t("common.yourGroups") }, others.map((g) =>
            h("md-list-item", {
              type: "button", dataset: { testid: "pick-group-item" },
              onclick: () => { chosen = g.id; d.close("ok"); },
            },
              icon("groups", "start"),
              h("div", { slot: "headline" }, g.name),
              h("div", { slot: "supporting-text" }, g.currency === currency ? g.currency : t("move.diffCurrency", { currency: g.currency })))))
        : h("p", { class: "md-typescale-body-small muted" }, t("move.noOthers")),
      paste),
    h("div", { slot: "actions" },
      h("md-text-button", { onclick: () => d.close("cancel") }, t("common.cancel")),
      h("md-filled-button", { dataset: { testid: "pick-group-go" }, onclick: () => {
        const id = parseGroupRef(paste.value);
        if (!id || id === excludeId) {
          paste.error = true;
          paste.errorText = id === excludeId ? t("move.thisGroup") : t("move.pasteInvalid");
          return;
        }
        chosen = id;
        d.close("ok");
      } }, t("common.continue")))) as MdDialog;
  return (await openDialog(d)) === "ok" ? chosen : null;
}

/**
 * Runs a move/merge call; if the target lacks some people, asks to add them and retries.
 * Returns the call's result, or null if the user declined.
 */
export async function withMissingMembers<T>(run: (addMissing: boolean) => Promise<T>): Promise<T | null> {
  try {
    return await run(false);
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== "missing_members" || !e.missing) throw e;
    const ok = await confirmDialog(
      t("move.addMissingTitle"),
      t("move.addMissingText", { names: e.missing.join(", ") }),
      t("move.addContinue"),
    );
    return ok ? run(true) : null;
  }
}
