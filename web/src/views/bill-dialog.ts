import { api, ApiError, type Bill, type BillInput, type BillKind, type Member } from "../api";
import { clear, h, icon, snackbar } from "../dom";
import { confirmDialog, openDialog, type MdDialog } from "../dialogs";
import { formatMoney, parseMoney, splitEqual, toInput } from "../money";

type Field = HTMLElement & { value: string; error: boolean; errorText: string; disabled: boolean; focus(): void };
type Select = HTMLElement & { value: string };
type Checkbox = HTMLElement & { checked: boolean };

export interface BillDialogOptions {
  gid: string;
  currency: string;
  members: Member[];
  bill?: Bill;
  /** Prefill for a new payment (from a settlement suggestion). */
  payment?: { from: string; to: string; amount: number };
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Opens add/edit dialog. Resolves true when something was saved or deleted. */
export async function openBillDialog(opts: BillDialogOptions): Promise<boolean> {
  const { gid, currency, members, bill } = opts;
  const kind: BillKind = bill?.kind ?? (opts.payment ? "payment" : "expense");
  let mode: "equal" | "exact" = bill?.splitMode ?? "equal";
  let changed = false;

  const selected = new Set<string>(bill ? bill.shares.map((s) => s.memberId) : members.map((m) => m.id));
  const exact = new Map<string, number>(bill?.splitMode === "exact" ? bill.shares.map((s) => [s.memberId, s.amount]) : []);

  const description = h("md-outlined-text-field", {
    label: "Description",
    placeholder: kind === "payment" ? "Payment" : "Dinner, taxi, hotel…",
    value: bill?.description ?? (kind === "payment" ? "Payment" : ""),
    maxLength: 120,
    required: true,
    dataset: { testid: "bill-description" },
  }) as Field;

  const amount = h("md-outlined-text-field", {
    label: "Amount",
    inputMode: "decimal",
    value: bill ? toInput(bill.amount, currency) : opts.payment ? toInput(opts.payment.amount, currency) : "",
    prefixText: "",
    suffixText: currency,
    required: true,
    dataset: { testid: "bill-amount" },
    oninput: () => renderSplit(),
  }) as Field;

  const date = h("md-outlined-text-field", {
    label: "Date",
    type: "date",
    value: bill?.date ?? today(),
    required: true,
    dataset: { testid: "bill-date" },
  }) as Field;

  const memberOptions = (sel: string) =>
    members.map((m) => h("md-select-option", { value: m.id, selected: m.id === sel }, h("div", { slot: "headline" }, m.name)));

  const paidBy = h(
    "md-outlined-select",
    { label: kind === "payment" ? "From" : "Paid by", dataset: { testid: "bill-paid-by" } },
    memberOptions(bill?.paidBy ?? opts.payment?.from ?? members[0]?.id ?? ""),
  ) as Select;

  const receiver = h(
    "md-outlined-select",
    { label: "To", dataset: { testid: "bill-receiver" } },
    memberOptions(bill?.shares[0]?.memberId ?? opts.payment?.to ?? members[1]?.id ?? ""),
  ) as Select;

  const equalChip = h("md-filter-chip", { label: "Split equally", selected: mode === "equal", dataset: { testid: "mode-equal" } }) as HTMLElement & { selected: boolean };
  const exactChip = h("md-filter-chip", { label: "Exact amounts", selected: mode === "exact", dataset: { testid: "mode-exact" } }) as HTMLElement & { selected: boolean };
  const setMode = (m: "equal" | "exact") => {
    mode = m;
    equalChip.selected = m === "equal";
    exactChip.selected = m === "exact";
    renderSplit();
  };
  equalChip.addEventListener("click", (e) => { e.preventDefault(); setMode("equal"); });
  exactChip.addEventListener("click", (e) => { e.preventDefault(); setMode("exact"); });

  const splitList = h("div", { class: "split-list", dataset: { testid: "split-list" } });
  const splitStatus = h("div", { class: "split-status md-typescale-body-medium", dataset: { testid: "split-status" } });
  const formError = h("div", { class: "form-error md-typescale-body-medium", role: "alert" });

  function amountMinor(): number | null {
    return parseMoney(amount.value, currency);
  }

  function renderSplit() {
    if (kind === "payment") return;
    const total = amountMinor() ?? 0;
    if (mode === "equal") {
      const ids = members.filter((m) => selected.has(m.id)).map((m) => m.id);
      const shares = splitEqual(total, ids);
      clear(
        splitList,
        members.map((m) => {
          const cb = h("md-checkbox", {
            checked: selected.has(m.id),
            "aria-label": m.name,
            dataset: { testid: `split-check-${m.name}` },
            onchange: (e: Event) => {
              if ((e.target as Checkbox).checked) selected.add(m.id);
              else selected.delete(m.id);
              renderSplit();
            },
          });
          return h(
            "label",
            { class: "split-row" },
            cb,
            h("span", { class: "grow" }, m.name),
            h("span", { class: "muted tabular" }, selected.has(m.id) ? formatMoney(shares.get(m.id) ?? 0, currency) : "—"),
          );
        }),
      );
      splitStatus.textContent = ids.length
        ? `${ids.length} ${ids.length === 1 ? "person" : "people"} · ${formatMoney(Math.floor(total / ids.length), currency)} each`
        : "Select at least one person";
      splitStatus.classList.toggle("error", !ids.length);
    } else {
      clear(
        splitList,
        members.map((m) =>
          h(
            "div",
            { class: "split-row" },
            h("span", { class: "grow" }, m.name),
            h("md-outlined-text-field", {
              class: "exact-input",
              inputMode: "decimal",
              "aria-label": `${m.name} owes`,
              placeholder: "0",
              value: exact.has(m.id) ? toInput(exact.get(m.id)!, currency) : "",
              dataset: { testid: `split-exact-${m.name}` },
              oninput: (e: Event) => {
                const f = e.target as Field;
                const v = f.value.trim() ? parseMoney(f.value, currency) : 0;
                f.error = v === null;
                if (v === null) exact.delete(m.id);
                else exact.set(m.id, v);
                updateExactStatus();
              },
            }),
          ),
        ),
      );
      updateExactStatus();
    }
  }

  function updateExactStatus() {
    const total = amountMinor() ?? 0;
    const sum = [...exact.values()].reduce((a, b) => a + b, 0);
    const left = total - sum;
    splitStatus.textContent =
      left === 0 ? `All ${formatMoney(total, currency)} assigned` : left > 0 ? `${formatMoney(left, currency)} left to assign` : `${formatMoney(-left, currency)} over`;
    splitStatus.classList.toggle("error", left !== 0);
  }

  const saveBtn = h("md-filled-button", { onclick: () => save(), dataset: { testid: "bill-save" } }, "Save") as HTMLElement & { disabled: boolean };

  async function save() {
    formError.textContent = "";
    description.error = amount.error = false;
    const desc = description.value.trim() || (kind === "payment" ? "Payment" : "");
    if (!desc) {
      description.error = true;
      description.errorText = "Required";
      return description.focus();
    }
    const amt = amountMinor();
    if (!amt || amt <= 0) {
      amount.error = true;
      amount.errorText = "Enter an amount";
      return amount.focus();
    }
    let input: BillInput;
    if (kind === "payment") {
      if (paidBy.value === receiver.value) {
        formError.textContent = "From and To must be different people";
        return;
      }
      input = { kind, description: desc, amount: amt, paidBy: paidBy.value, date: date.value, split: { mode: "equal", members: [receiver.value] } };
    } else if (mode === "equal") {
      const ids = members.filter((m) => selected.has(m.id)).map((m) => m.id);
      if (!ids.length) {
        formError.textContent = "Select at least one person to share this bill";
        return;
      }
      input = { kind, description: desc, amount: amt, paidBy: paidBy.value, date: date.value, split: { mode: "equal", members: ids } };
    } else {
      const shares = members.map((m) => ({ memberId: m.id, amount: exact.get(m.id) ?? 0 })).filter((s) => s.amount > 0);
      if (shares.reduce((a, s) => a + s.amount, 0) !== amt) {
        formError.textContent = "Exact amounts must add up to the total";
        return;
      }
      input = { kind, description: desc, amount: amt, paidBy: paidBy.value, date: date.value, split: { mode: "exact", shares } };
    }
    saveBtn.disabled = true;
    try {
      if (bill) await api.updateBill(gid, bill.id, input);
      else await api.createBill(gid, input);
      changed = true;
      snackbar(bill ? "Bill updated" : kind === "payment" ? "Payment recorded" : "Bill added");
      dialog.close("saved");
    } catch (err) {
      formError.textContent = err instanceof ApiError ? err.message : "Could not save";
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function remove() {
    if (!bill) return;
    if (!(await confirmDialog("Delete bill?", `“${bill.description}” will be removed for everyone.`))) return;
    try {
      await api.deleteBill(gid, bill.id);
      changed = true;
      snackbar("Bill deleted");
      dialog.close("deleted");
    } catch (err) {
      formError.textContent = err instanceof ApiError ? err.message : "Could not delete";
    }
  }

  const title = bill ? (kind === "payment" ? "Edit payment" : "Edit bill") : kind === "payment" ? "Record payment" : "Add bill";

  const content =
    kind === "payment"
      ? h("div", { class: "stack" }, h("div", { class: "row wrap" }, paidBy, icon("arrow_forward"), receiver), amount, date, description, formError)
      : h(
          "div",
          { class: "stack" },
          description,
          h("div", { class: "row wrap" }, h("div", { class: "grow" }, amount), h("div", { class: "grow" }, date)),
          paidBy,
          h("div", { class: "split-head" }, h("span", { class: "md-typescale-title-small" }, "Split between"), h("md-chip-set", null, equalChip, exactChip)),
          splitList,
          splitStatus,
          formError,
        );

  const dialog = h(
    "md-dialog",
    { class: "bill-dialog", dataset: { testid: "bill-dialog" } },
    h("div", { slot: "headline" }, title),
    h("form", { slot: "content", id: "bill-form", novalidate: true, onsubmit: (e: Event) => { e.preventDefault(); save(); } }, content),
    h(
      "div",
      { slot: "actions" },
      bill && h("md-text-button", { class: "danger push-left", onclick: remove, dataset: { testid: "bill-delete" } }, "Delete"),
      h("md-text-button", { onclick: () => dialog.close("cancel"), dataset: { testid: "bill-cancel" } }, "Cancel"),
      saveBtn,
    ),
  ) as MdDialog;

  renderSplit();
  await openDialog(dialog);
  return changed;
}
