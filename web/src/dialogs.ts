import { h } from "./dom";

export type MdDialog = HTMLElement & { open: boolean; returnValue: string; show(): Promise<void>; close(v?: string): Promise<void> };

/** Mounts a dialog, opens it, removes it from DOM after close. Resolves with returnValue. */
export function openDialog(dialog: MdDialog): Promise<string> {
  document.body.appendChild(dialog);
  return new Promise((resolve) => {
    // data-ready marks the end of the open animation (E2E waits for it before typing).
    dialog.addEventListener("opened", () => (dialog.dataset.ready = "1"), { once: true });
    dialog.addEventListener("closed", () => {
      resolve(dialog.returnValue);
      dialog.remove();
    }, { once: true });
    // Wait one frame so the element upgrades before opening (Safari).
    requestAnimationFrame(() => dialog.show());
  });
}

export async function confirmDialog(title: string, text: string, confirmLabel = "Delete"): Promise<boolean> {
  const d = h(
    "md-dialog",
    { dataset: { testid: "confirm-dialog" } },
    h("div", { slot: "headline" }, title),
    h("div", { slot: "content", class: "md-typescale-body-medium" }, text),
    h(
      "div",
      { slot: "actions" },
      h("md-text-button", { onclick: () => d.close("cancel") }, "Cancel"),
      h("md-filled-tonal-button", { onclick: () => d.close("ok"), dataset: { testid: "confirm-ok" } }, confirmLabel),
    ),
  ) as MdDialog;
  return (await openDialog(d)) === "ok";
}

type Field = HTMLElement & { value: string; error: boolean; errorText: string; focus(): void };

/** Single text-field prompt. `validate` returns an error message or null. */
export async function promptDialog(
  title: string,
  label: string,
  value: string,
  submit: (v: string) => Promise<string | null>,
): Promise<boolean> {
  const field = h("md-outlined-text-field", { label, value, maxLength: 60, dataset: { testid: "prompt-input" } }) as Field;
  const save = async () => {
    const v = field.value.trim();
    if (!v) {
      field.error = true;
      field.errorText = "Required";
      return;
    }
    const err = await submit(v);
    if (err) {
      field.error = true;
      field.errorText = err;
      return;
    }
    d.close("ok");
  };
  const d = h(
    "md-dialog",
    { dataset: { testid: "prompt-dialog" } },
    h("div", { slot: "headline" }, title),
    h(
      "form",
      { slot: "content", id: "prompt-form", onsubmit: (e: Event) => { e.preventDefault(); save(); } },
      field,
    ),
    h(
      "div",
      { slot: "actions" },
      h("md-text-button", { onclick: () => d.close("cancel") }, "Cancel"),
      h("md-filled-button", { onclick: save, dataset: { testid: "prompt-save" } }, "Save"),
    ),
  ) as MdDialog;
  d.addEventListener("opened", () => field.focus(), { once: true });
  return (await openDialog(d)) === "ok";
}
