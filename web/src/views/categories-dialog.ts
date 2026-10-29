// A trip's own categories (v0.11, #12): name + icon. Lazy chunk (bill dialog "+ New", Settings → Categories).
import { api, ApiError, type CustomCategory } from "../api";
import { h, icon } from "../dom";
import { openDialog, type MdDialog } from "../dialogs";
import { CUSTOM_ICONS } from "../categories";
import { t } from "../i18n";

type Field = HTMLElement & { value: string; error: boolean; errorText: string; focus(): void };

/** New (no `cat`) or edit; resolves with the saved category, or null (cancelled / deleted when `onDelete` ran). */
export async function editCategoryDialog(gid: string, cat?: CustomCategory, onDelete?: () => Promise<void>): Promise<CustomCategory | null> {
  let chosen: string = cat?.icon ?? "label";
  let saved: CustomCategory | null = null;
  const name = h("md-outlined-text-field", { label: t("common.name"), value: cat?.name ?? "", maxLength: 24, dataset: { testid: "cat-name" } }) as Field;
  const buttons = CUSTOM_ICONS.map((ic) => h("md-icon-button", {
    type: "button", toggle: true, selected: ic === chosen, "aria-label": ic.replace(/_/g, " "), dataset: { testid: `cat-icon-${ic}` },
    onclick: () => {
      chosen = ic;
      buttons.forEach((b, i) => ((b as HTMLElement & { selected: boolean }).selected = CUSTOM_ICONS[i] === ic));
    },
  }, icon(ic)));
  const save = async () => {
    try {
      saved = (await api.saveCategory(gid, { id: cat?.id, name: name.value, icon: chosen })).category;
      d.close("ok");
    } catch (e) {
      name.error = true;
      name.errorText = e instanceof ApiError && e.code === "conflict" ? t("cat.taken") : e instanceof Error ? e.message : t("common.saveFailed");
    }
  };
  const d = h("md-dialog", { dataset: { testid: "category-dialog" } },
    h("div", { slot: "headline" }, cat ? t("cat.edit") : t("cat.new")),
    h("form", { slot: "content", class: "stack", onsubmit: (e: Event) => { e.preventDefault(); void save(); } },
      name,
      h("div", { class: "icon-grid", role: "group", "aria-label": t("cat.icon") }, buttons)),
    h("div", { slot: "actions" },
      cat && onDelete && h("md-text-button", { type: "button", class: "danger push-left", dataset: { testid: "cat-delete" }, onclick: async () => {
        await onDelete();
        d.close("deleted");
      } }, t("common.delete")),
      h("md-text-button", { type: "button", onclick: () => d.close("cancel") }, t("common.cancel")),
      h("md-filled-button", { type: "button", dataset: { testid: "cat-save" }, onclick: () => void save() }, t("common.save")))) as MdDialog;
  d.addEventListener("opened", () => name.focus(), { once: true });
  await openDialog(d);
  return saved;
}
