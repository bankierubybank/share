import { api, ApiError, receiptUrl, type Bill, type BillInput, type BillKind, type Category, type Comment, type Group, type Member, type Split, type SplitMode, type Subgroup } from "../api";
import { clear, h, icon, snackbar } from "../dom";
import { openDialog, type MdDialog } from "../dialogs";
import { CURRENCIES, formatMoney, parseMoney, toInput } from "../money";
import { CATEGORY_META, CATEGORY_ORDER, categoryLabel } from "../categories";
import { locale, t, tn } from "../i18n";
import { parseBill, ValidationError } from "../../../src/lib/validate";
import { downscaleImage } from "../image";
import { promptPayPayload, renderQr } from "../promptpay";
import { pickGroupDialog, withMissingMembers } from "./move";

type Field = HTMLElement & { value: string; error: boolean; errorText: string; disabled: boolean; focus(): void; select(): void };
type Select = HTMLElement & { value: string };
type Chip = HTMLElement & { selected: boolean };
type Checkbox = HTMLElement & { checked: boolean };

export interface BillDialogOptions {
  group: Group;
  members: Member[];
  /** All live bills — for smart defaults (last fx rate per currency). */
  bills: Bill[];
  bill?: Bill;
  /** Prefill for a new payment (from a settlement suggestion). */
  payment?: { from: string; to: string; amount: number };
  /** "Viewing as" member: default payer for quick add. */
  viewAs?: string | null;
  /** Called after a delete (the caller offers Undo); `deleting` = the request, when it's still on its way. */
  onDeleted?: (bill: Bill, deleting?: Promise<unknown>) => void;
  /**
   * Optimistic saves: when set, Save/Delete close the dialog at once and hand over the request instead of
   * waiting for it (the caller shows the result immediately and rolls back on failure).
   */
  onSaving?: (op: PendingSave) => void;
  /** Prefill a NEW bill with everything, date included (reopening a save that failed). */
  draft?: Bill;
  /** Saved subgroups for one-tap "split between" picks. */
  subgroups?: Subgroup[];
  /** Prefill a NEW bill from an existing one (Duplicate / long-press). */
  template?: Bill;
  /** Edit mode: user asked to duplicate this bill (caller opens a new dialog with it as template). */
  onDuplicate?: (bill: Bill) => void;
}

export interface PendingSave {
  /** Bill id; "tmp-…" for a bill that doesn't exist yet. */
  id: string;
  /** What to show meanwhile; null = being deleted. */
  bill: Bill | null;
  /** Resolves with the saved bill (null for a delete); rejects with the server's error. */
  done: Promise<Bill | null>;
  /** New bills: what was sent (with `id` = "tmp-" + clientRef) — queued offline if the network was down (#8). */
  input?: BillInput;
  /** A receipt photo was attached (not kept when the bill is queued offline). */
  receipt?: boolean;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const lastPayerKey = (gid: string) => `share.lastPayer:${gid}`;
/** Comment deletes still on their way after a dialog closed, by bill id (a reopened dialog waits for them). */
const commentDeletes = new Map<string, Promise<unknown>>();
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

/** "12.5" → 1250 basis points (two decimals). */
const toBp = (s: string) => parseMoney(s, "USD");
const bpToInput = (bp: number) => toInput(bp, "USD").replace(/\.00$/, "");

const MODES: SplitMode[] = ["equal", "exact", "shares", "percent", "itemized"];

/** Opens add/edit dialog. Resolves true when something was saved or deleted. */
export async function openBillDialog(opts: BillDialogOptions): Promise<boolean> {
  const { group, members, bill } = opts;
  const src = bill ?? opts.draft ?? opts.template;
  const gid = group.id;
  const currency = group.currency;
  const memberIds = new Set(members.map((m) => m.id));
  const kind: BillKind = src?.kind ?? (opts.payment ? "payment" : "expense");
  let changed = false;

  // ---------- state ----------
  const s0 = src?.split;
  let mode: SplitMode = src?.splitMode ?? "equal";
  const equalSel = new Set<string>(s0?.mode === "equal" ? s0.members : members.map((m) => m.id));
  const exact = new Map<string, string>(s0?.mode === "exact" ? s0.shares.map((x) => [x.memberId, toInput(x.amount, currency)]) : []);
  const weights = new Map<string, number>(s0?.mode === "shares" ? s0.weights.map((w) => [w.memberId, w.weight]) : members.map((m) => [m.id, 1]));
  const percents = new Map<string, string>(s0?.mode === "percent" ? s0.percents.map((p) => [p.memberId, bpToInput(p.bp)]) : []);
  interface ItemState { description: string; amount: string; members: Set<string> }
  const items: ItemState[] = s0?.mode === "itemized"
    ? s0.items.map((it) => ({ description: it.description, amount: toInput(it.amount, currency), members: new Set(it.members) }))
    : [{ description: "", amount: "", members: new Set(members.map((m) => m.id)) }];
  let serviceStr = s0?.mode === "itemized" && s0.serviceBp ? bpToInput(s0.serviceBp) : "";
  let taxStr = s0?.mode === "itemized" && s0.taxBp ? bpToInput(s0.taxBp) : "";
  let category: Category = src?.category ?? "other";
  let multiPayer = (src?.payers.length ?? 1) > 1;
  const payerAmounts = new Map<string, string>(src && src.payers.length > 1 ? src.payers.map((p) => [p.memberId, toInput(p.amount, currency)]) : []);
  let fxOn = !!src?.fx;
  let repeat: "none" | "weekly" | "monthly" = "none";
  let pendingReceipt: Blob | null = null;
  let previewUrl: string | null = null;
  let removeReceipt = false;

  const defaultPayer =
    src?.paidBy ?? opts.payment?.from ?? (opts.viewAs && memberIds.has(opts.viewAs) ? opts.viewAs : null) ??
    (() => { const p = store.get(lastPayerKey(gid)); return p && memberIds.has(p) ? p : null; })() ?? members[0]?.id ?? "";

  // ---------- fields ----------
  const amount = h("md-outlined-text-field", {
    class: "amount-field",
    label: t("bill.amount"),
    inputMode: "decimal",
    value: src ? toInput(src.amount, currency) : opts.payment ? toInput(opts.payment.amount, currency) : "",
    oninput: () => (kind === "payment" ? renderQrBox() : update()),
    suffixText: currency,
    required: true,
    // Quick add: md-dialog focuses [autofocus] on open (script focus alone doesn't stick in Safari).
    autofocus: !bill && !opts.payment,
    dataset: { testid: "bill-amount" },
  }) as Field;

  const fxCurrency = h("md-outlined-select", { quick: true, label: t("bill.fxPaidIn"), dataset: { testid: "fx-currency" }, onchange: () => { prefillRate(); update(); } },
    CURRENCIES.filter((c) => c !== currency).map((c) =>
      h("md-select-option", { value: c, selected: c === (src?.fx?.currency ?? (currency === "USD" ? "EUR" : "USD")) }, h("div", { slot: "headline" }, c)),
    ),
  ) as Select;
  const fxAmount = h("md-outlined-text-field", {
    label: t("bill.fxAmount"), inputMode: "decimal", value: src?.fx ? toInput(src.fx.amount, src.fx.currency) : "",
    dataset: { testid: "fx-amount" }, oninput: () => update(),
  }) as Field;
  const fxRate = h("md-outlined-text-field", {
    label: t("bill.fxRate", { currency }), inputMode: "decimal", value: src?.fx?.rate ?? "",
    dataset: { testid: "fx-rate" }, oninput: () => update(),
  }) as Field;
  const fxResult = h("div", { class: "md-typescale-body-medium muted", dataset: { testid: "fx-result" }, "aria-live": "polite" });
  const fxBox = h("div", { class: "fx-box stack-sm", dataset: { testid: "fx-box" } },
    h("div", { class: "row wrap" }, h("div", { class: "grow" }, fxCurrency), h("div", { class: "grow" }, fxAmount)), fxRate, fxResult);
  function prefillRate() {
    if (fxRate.value.trim()) return;
    const last = opts.bills.find((b) => b.fx?.currency === fxCurrency.value);
    if (last?.fx) fxRate.value = last.fx.rate;
  }
  const fxChip = h("md-filter-chip", { label: t("bill.fxToggle"), selected: fxOn, dataset: { testid: "fx-toggle" } }) as Chip;
  fxChip.prepend(icon("currency_exchange", "icon"));
  fxChip.addEventListener("click", (e) => {
    e.preventDefault();
    fxOn = !fxOn;
    fxChip.selected = fxOn;
    if (fxOn) prefillRate();
    update();
  });

  const description = h("md-outlined-text-field", {
    label: t("bill.what"),
    placeholder: kind === "payment" ? t("bill.payment") : t("bill.whatPh"),
    value: src?.description ?? (kind === "payment" ? t("bill.payment") : ""),
    maxLength: 120,
    required: true,
    dataset: { testid: "bill-description" },
  }) as Field;

  const date = h("md-outlined-text-field", { label: t("bill.date"), type: "date", value: (bill ?? opts.draft)?.date ?? today(), required: true, dataset: { testid: "bill-date" } }) as Field;

  const memberOptions = (sel: string) =>
    members.map((m) => h("md-select-option", { value: m.id, selected: m.id === sel }, h("div", { slot: "headline" }, m.name)));
  const paidBy = h("md-outlined-select", { quick: true, label: kind === "payment" ? t("bill.from") : t("bill.paidBy"), dataset: { testid: "bill-paid-by" }, onchange: () => update() },
    memberOptions(defaultPayer)) as Select;
  const receiver = h("md-outlined-select", { quick: true, label: t("bill.to"), dataset: { testid: "bill-receiver" }, onchange: () => update() },
    memberOptions(src?.shares[0]?.memberId ?? opts.payment?.to ?? members.find((m) => m.id !== defaultPayer)?.id ?? "")) as Select;

  // Category chips (single select)
  const catChips = CATEGORY_ORDER.map((c) => {
    const chip = h("md-filter-chip", { label: categoryLabel(c), selected: c === category, dataset: { testid: `cat-${c}` } }) as Chip;
    chip.prepend(icon(CATEGORY_META[c].icon, "icon"));
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      category = c;
      catChips.forEach((x, i) => (x.selected = CATEGORY_ORDER[i] === c));
    });
    return chip;
  });
  const categorySet = h("md-chip-set", { class: "chip-scroll", "aria-label": t("bill.category") }, catChips);

  // Payers
  const payersBox = h("div", { class: "payers", dataset: { testid: "payers-box" } });
  const multiBtn = h("md-text-button", { type: "button", dataset: { testid: "multi-payer-toggle" }, onclick: () => { multiPayer = !multiPayer; renderPayers(); update(); } });
  function renderPayers() {
    multiBtn.textContent = multiPayer ? t("bill.onePayer") : t("bill.severalPaid");
    if (!multiPayer) return clear(payersBox, paidBy);
    clear(
      payersBox,
      h("div", { class: "md-typescale-title-small" }, t("bill.whoPaidHow")),
      h("div", { class: "split-list" }, members.map((m) =>
        h("div", { class: "split-row" }, h("span", { class: "grow" }, m.name),
          h("md-outlined-text-field", {
            class: "exact-input", inputMode: "decimal", placeholder: "0", "aria-label": t("bill.paidAria", { name: m.name }),
            value: payerAmounts.get(m.id) ?? "", dataset: { testid: `payer-${m.name}` },
            oninput: (e: Event) => { payerAmounts.set(m.id, (e.target as Field).value); update(); },
          })))),
    );
  }

  // Split mode chips
  const modeChips = MODES.map((m) => {
    const chip = h("md-filter-chip", { label: t(`mode.${m}`), selected: m === mode, dataset: { testid: `mode-${m}` } }) as Chip;
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      mode = m;
      modeChips.forEach((c, i) => (c.selected = MODES[i] === m));
      if (m === "itemized" && fxOn) { fxOn = false; fxChip.selected = false; }
      renderSplit();
      update();
    });
    return chip;
  });

  const splitList = h("div", { class: "split-list", dataset: { testid: "split-list" } });
  const pick = (ids: string[]) => {
    equalSel.clear();
    ids.forEach((id) => memberIds.has(id) && equalSel.add(id));
    renderSplit();
    update();
  };
  const quickPick = h("md-chip-set", { class: "chip-scroll", "aria-label": t("bill.quickSelect"), dataset: { testid: "quick-pick" } },
    h("md-assist-chip", { label: t("common.everyone"), dataset: { testid: "pick-everyone" }, onclick: () => pick(members.map((m) => m.id)) }),
    h("md-assist-chip", { label: t("common.noOne"), dataset: { testid: "pick-none" }, onclick: () => pick([]) }),
    (opts.subgroups ?? []).map((sg) =>
      h("md-assist-chip", { label: sg.name, dataset: { testid: `pick-sub-${sg.name}` }, onclick: () => pick(sg.memberIds) })));
  const itemsBox = h("div", { class: "stack-sm", dataset: { testid: "items-box" } });
  const splitStatus = h("div", { class: "split-status md-typescale-body-medium", dataset: { testid: "split-status" }, role: "status", "aria-live": "polite" });
  const formError = h("div", { class: "form-error md-typescale-body-medium", role: "alert" });
  const shareCells = new Map<string, HTMLElement>();
  const shareCell = (id: string) => {
    const el = h("span", { class: "muted tabular share-cell", dataset: { testid: `share-${members.find((m) => m.id === id)?.name ?? id}` } });
    shareCells.set(id, el);
    return el;
  };

  function renderSplit() {
    shareCells.clear();
    itemsBox.hidden = mode !== "itemized";
    quickPick.hidden = mode !== "equal";
    amount.disabled = mode === "itemized";
    if (mode === "itemized") renderItems();
    const row = (m: Member, control: Node | null) => h("div", { class: "split-row" }, control, h("span", { class: "grow" }, m.name), shareCell(m.id));
    const numField = (label: string, value: string, testid: string, on: (v: string) => void, cls = "exact-input") =>
      h("md-outlined-text-field", {
        class: cls, inputMode: "decimal", placeholder: "0", "aria-label": label, value, dataset: { testid },
        oninput: (e: Event) => { on((e.target as Field).value); update(); },
      });
    clear(
      splitList,
      members.map((m) => {
        switch (mode) {
          case "equal":
            return h("label", { class: "split-row" },
              h("md-checkbox", {
                checked: equalSel.has(m.id), "aria-label": t("bill.include", { name: m.name }), dataset: { testid: `split-check-${m.name}` },
                onchange: (e: Event) => { (e.target as Checkbox).checked ? equalSel.add(m.id) : equalSel.delete(m.id); update(); },
              }),
              h("span", { class: "grow" }, m.name), shareCell(m.id));
          case "exact":
            return h("div", { class: "split-row" }, h("span", { class: "grow" }, m.name),
              numField(t("bill.owesAria", { name: m.name }), exact.get(m.id) ?? "", `split-exact-${m.name}`, (v) => exact.set(m.id, v)));
          case "shares": {
            const val = h("span", { class: "weight tabular", dataset: { testid: `weight-${m.name}` }, "aria-live": "polite" }, String(weights.get(m.id) ?? 0));
            const step = (d: number) => {
              weights.set(m.id, Math.max(0, Math.min(99, (weights.get(m.id) ?? 0) + d)));
              val.textContent = String(weights.get(m.id));
              update();
            };
            return row(m, h("div", { class: "stepper", role: "group", "aria-label": t("bill.sharesAria", { name: m.name }) },
              h("md-icon-button", { type: "button", "aria-label": t("bill.fewerShares", { name: m.name }), onclick: () => step(-1), dataset: { testid: `weight-dec-${m.name}` } }, icon("remove")),
              val,
              h("md-icon-button", { type: "button", "aria-label": t("bill.moreShares", { name: m.name }), onclick: () => step(1), dataset: { testid: `weight-inc-${m.name}` } }, icon("add"))));
          }
          case "percent":
            return row(m, numField(t("bill.percentAria", { name: m.name }), percents.get(m.id) ?? "", `split-pct-${m.name}`, (v) => percents.set(m.id, v), "pct-input"));
          case "itemized":
            return row(m, null);
        }
      }),
    );
  }

  function renderItems() {
    clear(
      itemsBox,
      items.map((it, i) =>
        h("div", { class: "item-card", dataset: { testid: "item" } },
          h("div", { class: "row" },
            h("md-outlined-text-field", {
              class: "grow", label: t("bill.item", { n: i + 1 }), value: it.description, dataset: { testid: `item-desc-${i}` },
              oninput: (e: Event) => { it.description = (e.target as Field).value; update(); },
            }),
            h("md-outlined-text-field", {
              class: "exact-input", label: t("bill.price"), inputMode: "decimal", value: it.amount, dataset: { testid: `item-amount-${i}` },
              oninput: (e: Event) => { it.amount = (e.target as Field).value; update(); },
            }),
            items.length > 1 && h("md-icon-button", { type: "button", "aria-label": t("bill.removeItem", { n: i + 1 }), onclick: () => { items.splice(i, 1); renderItems(); update(); } }, icon("close")),
          ),
          h("md-chip-set", { "aria-label": t("bill.whoHadItem", { n: i + 1 }) }, members.map((m) => {
            const c = h("md-filter-chip", { label: m.name, selected: it.members.has(m.id), dataset: { testid: `item-${i}-${m.name}` } }) as Chip;
            c.addEventListener("click", (e) => {
              e.preventDefault();
              it.members.has(m.id) ? it.members.delete(m.id) : it.members.add(m.id);
              c.selected = it.members.has(m.id);
              update();
            });
            return c;
          })),
        ),
      ),
      h("md-text-button", { type: "button", dataset: { testid: "item-add" }, onclick: () => { items.push({ description: "", amount: "", members: new Set(members.map((m) => m.id)) }); renderItems(); update(); } },
        icon("add", "icon"), t("bill.addItem")),
      h("div", { class: "row wrap" },
        h("md-outlined-text-field", { class: "grow", label: t("bill.service"), suffixText: "%", inputMode: "decimal", value: serviceStr, dataset: { testid: "item-service" },
          oninput: (e: Event) => { serviceStr = (e.target as Field).value; update(); } }),
        h("md-outlined-text-field", { class: "grow", label: t("bill.tax"), suffixText: "%", inputMode: "decimal", value: taxStr, dataset: { testid: "item-tax" },
          oninput: (e: Event) => { taxStr = (e.target as Field).value; update(); } }),
      ),
    );
  }

  // ---------- build + preview (same validator as the server) ----------

  function buildSplit(): Split {
    switch (mode) {
      case "equal":
        return { mode, members: members.filter((m) => equalSel.has(m.id)).map((m) => m.id) };
      case "exact":
        return { mode, shares: members.map((m) => ({ memberId: m.id, amount: exact.get(m.id)?.trim() ? parseMoney(exact.get(m.id)!, currency) ?? -1 : 0 })) };
      case "shares":
        return { mode, weights: members.map((m) => ({ memberId: m.id, weight: weights.get(m.id) ?? 0 })) };
      case "percent":
        return { mode, percents: members.map((m) => ({ memberId: m.id, bp: percents.get(m.id)?.trim() ? toBp(percents.get(m.id)!) ?? -1 : 0 })) };
      case "itemized":
        return {
          mode,
          items: items.map((it) => ({ description: it.description.trim() || t("bill.itemDefault"), amount: parseMoney(it.amount, currency) ?? -1, members: members.filter((m) => it.members.has(m.id)).map((m) => m.id) })),
          serviceBp: serviceStr.trim() ? toBp(serviceStr) ?? -1 : 0,
          taxBp: taxStr.trim() ? toBp(taxStr) ?? -1 : 0,
        };
    }
  }

  function buildBody(): BillInput {
    if (kind === "payment")
      return { kind, description: description.value.trim() || t("bill.payment"), amount: parseMoney(amount.value, currency) ?? -1, paidBy: paidBy.value, date: date.value, category: "other", split: { mode: "equal", members: [receiver.value] } };
    const body: BillInput = { kind, description: description.value.trim() || "x", date: date.value, category, split: buildSplit() };
    if (mode !== "itemized") {
      if (fxOn) {
        body.fx = { currency: fxCurrency.value, amount: parseMoney(fxAmount.value, fxCurrency.value) ?? -1, rate: fxRate.value.trim() };
      } else body.amount = parseMoney(amount.value, currency) ?? -1;
    }
    if (multiPayer) body.payers = members.map((m) => ({ memberId: m.id, amount: payerAmounts.get(m.id)?.trim() ? parseMoney(payerAmounts.get(m.id)!, currency) ?? -1 : 0 })).filter((p) => p.amount !== 0);
    else body.paidBy = paidBy.value;
    return body;
  }

  /** Validates with the shared parser; for multi-payer previews, payers are checked after the amount is known. */
  function preview(): { ok: true; amount: number; shares: Map<string, number> } | { ok: false; error: string } {
    const body = buildBody();
    try {
      const payers = body.payers;
      const probe = { ...body, payers: undefined, paidBy: members[0]?.id };
      const r = parseBill(probe, memberIds, currency);
      if (payers) parseBill({ ...body, amount: r.amount, fx: body.fx }, memberIds, currency);
      return { ok: true, amount: r.amount, shares: new Map(r.shares.map((x) => [x.memberId, x.amount])) };
    } catch (e) {
      return { ok: false, error: e instanceof ValidationError ? humanize(e.message) : t("bill.err.check") };
    }
  }

  function humanize(msg: string): string {
    const sums = msg.match(/^(payers|shares) sum \((\d+)\) must equal amount \((\d+)\)/);
    if (sums)
      return t(sums[1] === "payers" ? "bill.err.sumPayers" : "bill.err.sumAmounts", { sum: formatMoney(+sums[2], currency), total: formatMoney(+sums[3], currency) });
    if (/computed amount|amount must be an integer|amount out of range|fx\.amount/.test(msg)) return t("bill.err.amount");
    if (/share amount|percent \(bp\)|item \d+ amount|payer amount|weight/.test(msg)) return t("bill.err.numbers");
    if (/fx\.rate/.test(msg)) return t("bill.err.rate");
    if (/split\.members must be a non-empty/.test(msg)) return t("bill.err.noPerson");
    if (/members must be a non-empty/.test(msg)) return t("bill.err.itemPerson");
    return msg.charAt(0).toUpperCase() + msg.slice(1);
  }

  function update() {
    if (kind === "payment") return renderQrBox();
    const p = preview();
    for (const [id, el] of shareCells) el.textContent = p.ok && p.shares.has(id) ? formatMoney(p.shares.get(id)!, currency) : "—";
    if (mode === "itemized" && p.ok) amount.value = toInput(p.amount, currency);
    fxBox.hidden = !fxOn || mode === "itemized";
    fxChip.hidden = mode === "itemized";
    amount.disabled = mode === "itemized" || fxOn;
    if (fxOn && p.ok) {
      amount.value = toInput(p.amount, currency);
      fxResult.textContent = `= ${formatMoney(p.amount, currency)}`;
    } else if (fxOn) fxResult.textContent = "";
    if (p.ok) {
      const n = p.shares.size;
      splitStatus.textContent = `${formatMoney(p.amount, currency)} · ${tn("people", n)}`;
      splitStatus.classList.remove("error");
    } else {
      splitStatus.textContent = p.error;
      // Not red before anything was typed: a fresh "Add bill" shouldn't open with an error.
      splitStatus.classList.toggle("error", !(p.error === t("bill.err.amount") && !amount.value.trim()));
    }
  }

  // ---------- payment: PromptPay QR ----------
  const qrBox = h("div", { class: "qr-box", dataset: { testid: "qr-box" }, hidden: true });
  let qrKey = "";
  function renderQrBox() {
    const to = members.find((m) => m.id === receiver.value);
    const amt = parseMoney(amount.value, currency);
    const can = currency === "THB" && !!to?.promptpay && !!amt && amt > 0;
    qrBox.hidden = !can;
    if (!can) return;
    const key = `${to!.promptpay}|${amt}`;
    if (key === qrKey) return;
    qrKey = key;
    const canvas = h("canvas", { width: 240, height: 240, role: "img", "aria-label": t("bill.qrAria", { name: to!.name, amount: formatMoney(amt!, currency) }), dataset: { testid: "qr-canvas" } });
    clear(qrBox,
      h("div", { class: "md-typescale-title-small" }, icon("qr_code_2"), " ", t("bill.qrTitle", { name: to!.name })),
      canvas,
      h("div", { class: "md-typescale-body-small muted" }, t("bill.qrHelp")),
      !bill && h("div", { class: "md-typescale-body-medium", dataset: { testid: "qr-then-mark" } }, t("bill.qrThenMark")));
    const payload = promptPayPayload(to!.promptpay!, amt!);
    qrBox.dataset.payload = payload;
    void renderQr(canvas, payload).catch(() => { qrBox.hidden = true; });
  }

  // ---------- more: repeat + receipt ----------
  const repeatSel = h("md-outlined-select", { quick: true, label: t("bill.repeat"), dataset: { testid: "bill-repeat" }, onchange: () => { repeat = repeatSel.value as typeof repeat; receiptBox.hidden = repeat !== "none"; } },
    h("md-select-option", { value: "none", selected: true }, h("div", { slot: "headline" }, t("bill.repeatNone"))),
    h("md-select-option", { value: "weekly" }, h("div", { slot: "headline" }, t("bill.repeatWeek"))),
    h("md-select-option", { value: "monthly" }, h("div", { slot: "headline" }, t("bill.repeatMonth")))) as Select;

  const fileInput = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp", class: "visually-hidden", "aria-label": t("bill.receiptChoose"), dataset: { testid: "receipt-input" } }) as HTMLInputElement;
  const receiptPreview = h("div", { class: "receipt-preview", dataset: { testid: "receipt-preview" } });
  const receiptBox = h("div", { class: "stack-sm" }, fileInput, receiptPreview);
  function renderReceipt() {
    const existing = bill?.hasReceipt && !removeReceipt;
    if (previewUrl) URL.revokeObjectURL(previewUrl); // release the previous preview's blob
    previewUrl = pendingReceipt ? URL.createObjectURL(pendingReceipt) : null;
    const src = previewUrl ?? (existing ? receiptUrl(gid, bill!.id, bill!.updatedAt) : null);
    clear(receiptPreview,
      src && h("a", { href: src, target: "_blank", rel: "noopener", class: "receipt-thumb", "aria-label": t("bill.receiptOpen") }, h("img", { src, alt: t("bill.receiptAlt"), dataset: { testid: "receipt-img" } })),
      h("div", { class: "row" },
        h("md-outlined-button", { type: "button", onclick: () => fileInput.click(), dataset: { testid: "receipt-add" } }, icon("photo_camera", "icon"), src ? t("bill.receiptReplace") : t("bill.receiptAdd")),
        src && h("md-text-button", { type: "button", class: "danger", dataset: { testid: "receipt-remove" }, onclick: () => { pendingReceipt = null; removeReceipt = !!bill?.hasReceipt; renderReceipt(); } }, t("common.remove"))));
  }
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    fileInput.value = "";
    if (!f) return;
    try {
      pendingReceipt = await downscaleImage(f);
      if (pendingReceipt.size > 2 * 1024 * 1024) throw new Error("too big");
      removeReceipt = false;
      renderReceipt();
    } catch {
      pendingReceipt = null;
      snackbar(t("bill.imageFailed"));
    }
  });

  // ---------- save / delete ----------
  // Recording a payment (Settle) is "Mark as paid" (#22): after paying by QR / bank, one tap records it.
  const saveBtn = h("md-filled-button", { onclick: () => save(), dataset: { testid: "bill-save" } },
    kind === "payment" && !bill ? t("bill.markPaid") : t("common.save")) as HTMLElement & { disabled: boolean };

  async function save() {
    formError.textContent = "";
    description.error = amount.error = false;
    if (kind === "expense" && !description.value.trim()) {
      description.error = true;
      description.errorText = t("bill.whatRequired");
      return description.focus();
    }
    if (kind === "payment" && paidBy.value === receiver.value) {
      formError.textContent = t("bill.sameFromTo");
      return;
    }
    const p = kind === "payment" ? null : preview();
    if (p && !p.ok) {
      formError.textContent = p.error;
      if (p.error === t("bill.err.amount") && !amount.disabled) { amount.error = true; amount.errorText = p.error; amount.focus(); }
      return;
    }
    const body = buildBody();
    if (kind === "payment" && !(body.amount! > 0)) {
      amount.error = true;
      amount.errorText = t("bill.err.amount");
      return amount.focus();
    }
    if (p?.ok && body.payers) {
      const sum = body.payers.reduce((a, x) => a + x.amount, 0);
      if (sum !== p.amount) {
        formError.textContent = t("bill.err.sumPayers", { sum: formatMoney(sum, currency), total: formatMoney(p.amount, currency) });
        return;
      }
    }
    if (opts.onSaving && repeat === "none") return saveOptimistic(body);
    saveBtn.disabled = true;
    try {
      let saved: Bill | null = null;
      if (!bill && repeat !== "none") {
        const { date: start, ...template } = body;
        const r = await api.createRecurring(gid, repeat, start, template);
        snackbar(r.created ? t("bill.repeatAdded", { n: r.created }) : t("bill.repeatScheduled"));
      } else {
        saved = bill ? (await api.updateBill(gid, bill.id, body)).bill : (await api.createBill(gid, body)).bill;
        if (pendingReceipt) await api.uploadReceipt(gid, saved.id, pendingReceipt);
        else if (removeReceipt && bill?.hasReceipt) await api.deleteReceipt(gid, bill.id);
        snackbar(bill ? t("bill.updated") : kind === "payment" ? t("bill.paymentRecorded") : t("bill.added"));
      }
      if (kind === "expense" && !multiPayer) store.set(lastPayerKey(gid), paidBy.value);
      changed = true;
      dialog.close("saved");
    } catch (err) {
      formError.textContent = err instanceof ApiError ? err.message : t("common.saveFailed");
    } finally {
      saveBtn.disabled = false;
    }
  }

  /** Closes now; the request runs on behind the scenes (see BillDialogOptions.onSaving). */
  function saveOptimistic(body: BillInput) {
    let parsed;
    try {
      parsed = parseBill(body, memberIds, currency); // the server's own validator: what it will store
    } catch (e) {
      formError.textContent = e instanceof ValidationError ? humanize(e.message) : t("bill.err.check");
      return;
    }
    const now = new Date().toISOString();
    const shown: Bill = {
      ...(bill ?? { hasReceipt: false, recurrenceId: null, createdBy: null, createdAt: now, commentCount: 0 }),
      id: bill?.id ?? `tmp-${crypto.randomUUID()}`,
      kind: parsed.kind, description: parsed.description, amount: parsed.amount, paidBy: parsed.payers[0].memberId,
      payers: parsed.payers, date: parsed.date, category: parsed.category, splitMode: parsed.splitMode,
      split: parsed.split as Split, shares: parsed.shares, fx: parsed.fx, updatedAt: now,
    };
    if (pendingReceipt || removeReceipt) shown.hasReceipt = !!pendingReceipt;
    const receipt = pendingReceipt;
    const dropReceipt = removeReceipt && !!bill?.hasReceipt;
    // New bills carry their temporary id as a retry key, so a resend (offline queue, #8) can't add a copy.
    const clientRef = bill ? undefined : shown.id.slice(4);
    const done = (async () => {
      const saved = bill ? (await api.updateBill(gid, bill.id, body)).bill : (await api.createBill(gid, { ...body, clientRef })).bill;
      try {
        if (receipt) await api.uploadReceipt(gid, saved.id, receipt);
        else if (dropReceipt) await api.deleteReceipt(gid, saved.id);
      } catch {
        snackbar(t("bill.receiptFailed")); // the bill itself is saved; only the photo didn't make it
      }
      return saved;
    })();
    if (kind === "expense" && !multiPayer) store.set(lastPayerKey(gid), paidBy.value);
    snackbar(bill ? t("bill.updated") : kind === "payment" ? t("bill.paymentRecorded") : t("bill.added"));
    opts.onSaving!({ id: shown.id, bill: shown, done, ...(bill ? {} : { input: body, receipt: !!receipt }) });
    dialog.close("saved");
  }

  async function remove() {
    if (!bill) return;
    // No "are you sure?" (#12): the bill is soft-deleted and the toast that follows offers Undo.
    if (opts.onSaving) {
      const deleting = api.deleteBill(gid, bill.id).then(() => null);
      opts.onSaving({ id: bill.id, bill: null, done: deleting });
      opts.onDeleted?.(bill, deleting);
      return dialog.close("deleted");
    }
    try {
      await api.deleteBill(gid, bill.id);
      changed = true;
      opts.onDeleted?.(bill);
      dialog.close("deleted");
    } catch (err) {
      formError.textContent = err instanceof ApiError ? err.message : t("common.deleteFailed");
    }
  }

  // ---------- comments (edit mode) ----------
  const commentsBox = h("section", { class: "comments stack-sm", "aria-label": t("bill.comments"), dataset: { testid: "comments" } });
  const nameOf = (id: string | null) => members.find((m) => m.id === id)?.name ?? null;
  // Deleting a comment (#12): the row turns into "Comment deleted · Undo" for a few seconds before it is really
  // deleted (a toast would sit under the modal dialog). Closing the dialog deletes the ones still waiting.
  const doomed = new Map<string, number>();
  let comments: Comment[] = [];
  const reallyDelete = async (cid: string) => {
    clearTimeout(doomed.get(cid));
    doomed.delete(cid);
    try {
      await api.deleteComment(gid, bill!.id, cid);
      comments = comments.filter((x) => x.id !== cid);
      changed = true;
    } catch {
      /* gone already, or offline: it stays */
    }
  };
  async function loadComments(fetch = true) {
    if (!bill) return;
    if (fetch) {
      try {
        await commentDeletes.get(bill.id); // reopened right after closing: let those deletes land first
        comments = (await api.comments(gid, bill.id)).comments;
      } catch {
        /* offline: show the box without history */
      }
    }
    const list = comments;
    const input = h("md-outlined-text-field", {
      type: "textarea", rows: 2, label: t("bill.commentAdd"), maxLength: 500,
      dataset: { testid: "comment-input" },
    }) as Field;
    const post = h("md-filled-tonal-button", { type: "button", dataset: { testid: "comment-post" }, onclick: async () => {
      const text = input.value.trim();
      if (!text) return;
      try {
        await api.addComment(gid, bill.id, text);
        changed = true;
        loadComments();
      } catch (e) {
        input.error = true;
        input.errorText = e instanceof Error ? e.message : t("bill.postFailed");
      }
    } }, t("bill.post"));
    clear(commentsBox,
      h("h3", { class: "md-typescale-title-small" }, `${t("bill.comments")}${list.length - doomed.size ? ` (${list.length - doomed.size})` : ""}`),
      h("ol", { class: "comment-list" }, list.map((c) => doomed.has(c.id)
        ? h("li", { class: "comment comment-gone row", dataset: { testid: "comment-deleted" } },
            h("span", { class: "grow md-typescale-body-medium muted" }, t("bill.commentDeleted")),
            h("md-text-button", { type: "button", dataset: { testid: "comment-undo" }, onclick: () => {
              clearTimeout(doomed.get(c.id));
              doomed.delete(c.id);
              void loadComments(false);
            } }, t("common.undo")))
        : h("li", { class: "comment", dataset: { testid: "comment" } },
          h("div", { class: "md-typescale-label-medium" }, nameOf(c.authorMemberId) ?? c.actor ?? t("bill.someone"),
            h("span", { class: "muted" }, ` · ${new Date(c.createdAt).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" })}`)),
          h("div", { class: "comment-body md-typescale-body-medium" }, c.body),
          h("md-icon-button", { type: "button", class: "comment-del", "aria-label": t("bill.commentDelete"), dataset: { testid: "comment-delete" }, onclick: () => {
            doomed.set(c.id, window.setTimeout(() => void reallyDelete(c.id).then(() => loadComments(false)), 5000));
            void loadComments(false);
          } }, icon("delete"))))),
      group.archived ? null : h("div", { class: "row comment-compose" }, h("div", { class: "grow" }, input), post));
  }

  async function moveBill() {
    if (!bill) return;
    const target = await pickGroupDialog(t("bill.moveTitle"), t("bill.moveHelp"), gid, currency);
    if (!target) return;
    try {
      const r = await withMissingMembers((add) => api.moveBill(gid, bill.id, target, add));
      if (!r) return;
      changed = true;
      snackbar(r.addedMembers.length ? t("bill.movedAdded", { names: r.addedMembers.join(", ") }) : t("bill.moved"));
      dialog.close("moved");
    } catch (e) {
      formError.textContent = e instanceof ApiError ? e.message : t("bill.moveFailed");
    }
  }

  // ---------- layout ----------
  const title = bill ? (kind === "payment" ? t("bill.editPayment") : t("bill.edit")) : kind === "payment" ? t("bill.recordPayment") : t("bill.add");
  const meta = bill?.createdBy ? h("div", { class: "md-typescale-body-small muted", dataset: { testid: "bill-created-by" } },
    bill.createdBy === "recurring" ? t("bill.addedAuto") : t("bill.addedBy", { name: bill.createdBy })) : null;

  const content =
    kind === "payment"
      ? h("div", { class: "stack" }, h("div", { class: "row wrap" }, paidBy, icon("arrow_forward"), receiver), amount,
          opts.payment && h("div", { class: "stack-sm" },
            h("md-chip-set", { "aria-label": t("bill.amount") },
              h("md-assist-chip", { label: t("bill.payFull", { amount: formatMoney(opts.payment.amount, currency) }), dataset: { testid: "pay-full" },
                onclick: () => { amount.value = toInput(opts.payment!.amount, currency); renderQrBox(); } }),
              h("md-assist-chip", { label: t("bill.payHalf"), dataset: { testid: "pay-half" },
                onclick: () => { amount.value = toInput(Math.round(opts.payment!.amount / 2), currency); renderQrBox(); } })),
            h("p", { class: "md-typescale-body-small muted" }, t("bill.payPartial"))),
          qrBox, date, description, bill && commentsBox, formError)
      : h("div", { class: "stack" },
          amount,
          h("div", { class: "row wrap tight-gap" }, fxChip),
          fxBox,
          description,
          categorySet,
          h("div", { class: "row wrap" }, h("div", { class: "grow" }, date), h("div", { class: "grow" }, payersBox)),
          h("div", { class: "row end" }, multiBtn),
          h("div", { class: "split-head" }, h("span", { class: "md-typescale-title-small", id: "split-label" }, t("bill.split")),
            h("md-chip-set", { class: "chip-scroll", "aria-labelledby": "split-label" }, modeChips)),
          itemsBox,
          quickPick,
          splitList,
          splitStatus,
          h("details", { class: "more" }, h("summary", { class: "md-typescale-title-small" }, t("bill.more")),
            h("div", { class: "stack" }, !bill && repeatSel, receiptBox,
              bill && !group.archived && h("div", { class: "row wrap" },
                h("md-outlined-button", { type: "button", dataset: { testid: "bill-duplicate" },
                  onclick: () => dialog.close("duplicate") }, icon("content_copy", "icon"), t("bill.duplicate")),
                h("md-outlined-button", { type: "button", dataset: { testid: "bill-move" }, onclick: moveBill }, icon("arrow_forward", "icon"), t("bill.moveBtn"))))),
          bill && commentsBox,
          meta,
          formError,
        );

  const dialog = h(
    "md-dialog",
    { class: "bill-dialog", dataset: { testid: "bill-dialog" } },
    h("div", { slot: "headline" }, title),
    h("form", { slot: "content", id: "bill-form", novalidate: true, onsubmit: (e: Event) => { e.preventDefault(); save(); } }, content),
    h("div", { slot: "actions" },
      bill && h("md-text-button", { class: "danger push-left", onclick: remove, dataset: { testid: "bill-delete" } }, t("common.delete")),
      h("md-text-button", { onclick: () => dialog.close("cancel"), dataset: { testid: "bill-cancel" } }, t("common.cancel")),
      saveBtn),
  ) as MdDialog;

  // Payment layout places `paidBy` itself; renderPayers would move it into the (expense-only) payers box.
  if (kind === "expense") renderPayers();
  renderSplit();
  renderReceipt();
  void loadComments();
  if (fxOn) prefillRate();
  update();
  // Quick add: amount first.
  dialog.addEventListener("opened", () => {
    update(); // md-select values exist only after first render (QR + previews need them)
    if (!bill && kind === "expense") amount.focus();
  }, { once: true });
  const closedWith = await openDialog(dialog);
  if (bill && doomed.size) {
    const deleting = Promise.all([...doomed.keys()].map(reallyDelete));
    commentDeletes.set(bill.id, deleting);
    await deleting;
    commentDeletes.delete(bill.id);
  }
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  if (closedWith === "duplicate" && bill) opts.onDuplicate?.(bill);
  return changed;
}
