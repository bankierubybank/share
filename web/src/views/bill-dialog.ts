import { api, ApiError, receiptUrl, type Bill, type BillInput, type BillKind, type Category, type Group, type Member, type Split, type SplitMode } from "../api";
import { clear, h, icon, snackbar } from "../dom";
import { confirmDialog, openDialog, type MdDialog } from "../dialogs";
import { CURRENCIES, formatMoney, parseMoney, toInput } from "../money";
import { CATEGORY_META, CATEGORY_ORDER } from "../categories";
import { parseBill, ValidationError } from "../../../src/lib/validate";
import { downscaleImage } from "../image";
import { promptPayPayload, renderQr } from "../promptpay";

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
  /** Called after a successful delete (the caller offers Undo). */
  onDeleted?: (bill: Bill) => void;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const lastPayerKey = (gid: string) => `share.lastPayer:${gid}`;
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

/** "12.5" → 1250 basis points (two decimals). */
const toBp = (s: string) => parseMoney(s, "USD");
const bpToInput = (bp: number) => toInput(bp, "USD").replace(/\.00$/, "");

const MODE_LABEL: Record<SplitMode, string> = {
  equal: "Equally", exact: "Amounts", shares: "Shares", percent: "Percent", itemized: "Items",
};

/** Opens add/edit dialog. Resolves true when something was saved or deleted. */
export async function openBillDialog(opts: BillDialogOptions): Promise<boolean> {
  const { group, members, bill } = opts;
  const gid = group.id;
  const currency = group.currency;
  const memberIds = new Set(members.map((m) => m.id));
  const kind: BillKind = bill?.kind ?? (opts.payment ? "payment" : "expense");
  let changed = false;

  // ---------- state ----------
  const s0 = bill?.split;
  let mode: SplitMode = bill?.splitMode ?? "equal";
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
  let category: Category = bill?.category ?? "other";
  let multiPayer = (bill?.payers.length ?? 1) > 1;
  const payerAmounts = new Map<string, string>(bill && bill.payers.length > 1 ? bill.payers.map((p) => [p.memberId, toInput(p.amount, currency)]) : []);
  let fxOn = !!bill?.fx;
  let repeat: "none" | "weekly" | "monthly" = "none";
  let pendingReceipt: Blob | null = null;
  let removeReceipt = false;

  const defaultPayer =
    bill?.paidBy ?? opts.payment?.from ?? (opts.viewAs && memberIds.has(opts.viewAs) ? opts.viewAs : null) ??
    (() => { const p = store.get(lastPayerKey(gid)); return p && memberIds.has(p) ? p : null; })() ?? members[0]?.id ?? "";

  // ---------- fields ----------
  const amount = h("md-outlined-text-field", {
    class: "amount-field",
    label: "Amount",
    inputMode: "decimal",
    value: bill ? toInput(bill.amount, currency) : opts.payment ? toInput(opts.payment.amount, currency) : "",
    suffixText: currency,
    required: true,
    // Quick add: md-dialog focuses [autofocus] on open (script focus alone doesn't stick in Safari).
    autofocus: !bill && !opts.payment,
    dataset: { testid: "bill-amount" },
    oninput: () => update(),
  }) as Field;

  const fxCurrency = h("md-outlined-select", { quick: true, label: "Paid in", dataset: { testid: "fx-currency" }, onchange: () => { prefillRate(); update(); } },
    CURRENCIES.filter((c) => c !== currency).map((c) =>
      h("md-select-option", { value: c, selected: c === (bill?.fx?.currency ?? (currency === "USD" ? "EUR" : "USD")) }, h("div", { slot: "headline" }, c)),
    ),
  ) as Select;
  const fxAmount = h("md-outlined-text-field", {
    label: "Amount paid", inputMode: "decimal", value: bill?.fx ? toInput(bill.fx.amount, bill.fx.currency) : "",
    dataset: { testid: "fx-amount" }, oninput: () => update(),
  }) as Field;
  const fxRate = h("md-outlined-text-field", {
    label: `Rate (1 unit → ${currency})`, inputMode: "decimal", value: bill?.fx?.rate ?? "",
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
  const fxChip = h("md-filter-chip", { label: "Foreign currency", selected: fxOn, dataset: { testid: "fx-toggle" } }) as Chip;
  fxChip.prepend(icon("currency_exchange", "icon"));
  fxChip.addEventListener("click", (e) => {
    e.preventDefault();
    fxOn = !fxOn;
    fxChip.selected = fxOn;
    if (fxOn) prefillRate();
    update();
  });

  const description = h("md-outlined-text-field", {
    label: "What for?",
    placeholder: kind === "payment" ? "Payment" : "Dinner, taxi, hotel…",
    value: bill?.description ?? (kind === "payment" ? "Payment" : ""),
    maxLength: 120,
    required: true,
    dataset: { testid: "bill-description" },
  }) as Field;

  const date = h("md-outlined-text-field", { label: "Date", type: "date", value: bill?.date ?? today(), required: true, dataset: { testid: "bill-date" } }) as Field;

  const memberOptions = (sel: string) =>
    members.map((m) => h("md-select-option", { value: m.id, selected: m.id === sel }, h("div", { slot: "headline" }, m.name)));
  const paidBy = h("md-outlined-select", { quick: true, label: kind === "payment" ? "From" : "Paid by", dataset: { testid: "bill-paid-by" }, onchange: () => update() },
    memberOptions(defaultPayer)) as Select;
  const receiver = h("md-outlined-select", { quick: true, label: "To", dataset: { testid: "bill-receiver" }, onchange: () => update() },
    memberOptions(bill?.shares[0]?.memberId ?? opts.payment?.to ?? members.find((m) => m.id !== defaultPayer)?.id ?? "")) as Select;

  // Category chips (single select)
  const catChips = CATEGORY_ORDER.map((c) => {
    const chip = h("md-filter-chip", { label: CATEGORY_META[c].label, selected: c === category, dataset: { testid: `cat-${c}` } }) as Chip;
    chip.prepend(icon(CATEGORY_META[c].icon, "icon"));
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      category = c;
      catChips.forEach((x, i) => (x.selected = CATEGORY_ORDER[i] === c));
    });
    return chip;
  });
  const categorySet = h("md-chip-set", { class: "chip-scroll", "aria-label": "Category" }, catChips);

  // Payers
  const payersBox = h("div", { class: "payers", dataset: { testid: "payers-box" } });
  const multiBtn = h("md-text-button", { type: "button", dataset: { testid: "multi-payer-toggle" }, onclick: () => { multiPayer = !multiPayer; renderPayers(); update(); } });
  function renderPayers() {
    multiBtn.textContent = multiPayer ? "One payer" : "Several people paid";
    if (!multiPayer) return clear(payersBox, paidBy);
    clear(
      payersBox,
      h("div", { class: "md-typescale-title-small" }, "Who paid how much"),
      h("div", { class: "split-list" }, members.map((m) =>
        h("div", { class: "split-row" }, h("span", { class: "grow" }, m.name),
          h("md-outlined-text-field", {
            class: "exact-input", inputMode: "decimal", placeholder: "0", "aria-label": `${m.name} paid`,
            value: payerAmounts.get(m.id) ?? "", dataset: { testid: `payer-${m.name}` },
            oninput: (e: Event) => { payerAmounts.set(m.id, (e.target as Field).value); update(); },
          })))),
    );
  }

  // Split mode chips
  const modeChips = (Object.keys(MODE_LABEL) as SplitMode[]).map((m) => {
    const chip = h("md-filter-chip", { label: MODE_LABEL[m], selected: m === mode, dataset: { testid: `mode-${m}` } }) as Chip;
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      mode = m;
      modeChips.forEach((c, i) => (c.selected = (Object.keys(MODE_LABEL) as SplitMode[])[i] === m));
      if (m === "itemized" && fxOn) { fxOn = false; fxChip.selected = false; }
      renderSplit();
      update();
    });
    return chip;
  });

  const splitList = h("div", { class: "split-list", dataset: { testid: "split-list" } });
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
                checked: equalSel.has(m.id), "aria-label": `Include ${m.name}`, dataset: { testid: `split-check-${m.name}` },
                onchange: (e: Event) => { (e.target as Checkbox).checked ? equalSel.add(m.id) : equalSel.delete(m.id); update(); },
              }),
              h("span", { class: "grow" }, m.name), shareCell(m.id));
          case "exact":
            return h("div", { class: "split-row" }, h("span", { class: "grow" }, m.name),
              numField(`${m.name} owes`, exact.get(m.id) ?? "", `split-exact-${m.name}`, (v) => exact.set(m.id, v)));
          case "shares": {
            const val = h("span", { class: "weight tabular", dataset: { testid: `weight-${m.name}` }, "aria-live": "polite" }, String(weights.get(m.id) ?? 0));
            const step = (d: number) => {
              weights.set(m.id, Math.max(0, Math.min(99, (weights.get(m.id) ?? 0) + d)));
              val.textContent = String(weights.get(m.id));
              update();
            };
            return row(m, h("div", { class: "stepper", role: "group", "aria-label": `${m.name} shares` },
              h("md-icon-button", { type: "button", "aria-label": `Fewer shares for ${m.name}`, onclick: () => step(-1), dataset: { testid: `weight-dec-${m.name}` } }, icon("remove")),
              val,
              h("md-icon-button", { type: "button", "aria-label": `More shares for ${m.name}`, onclick: () => step(1), dataset: { testid: `weight-inc-${m.name}` } }, icon("add"))));
          }
          case "percent":
            return row(m, numField(`${m.name} percent`, percents.get(m.id) ?? "", `split-pct-${m.name}`, (v) => percents.set(m.id, v), "pct-input"));
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
              class: "grow", label: `Item ${i + 1}`, value: it.description, dataset: { testid: `item-desc-${i}` },
              oninput: (e: Event) => { it.description = (e.target as Field).value; update(); },
            }),
            h("md-outlined-text-field", {
              class: "exact-input", label: "Price", inputMode: "decimal", value: it.amount, dataset: { testid: `item-amount-${i}` },
              oninput: (e: Event) => { it.amount = (e.target as Field).value; update(); },
            }),
            items.length > 1 && h("md-icon-button", { type: "button", "aria-label": `Remove item ${i + 1}`, onclick: () => { items.splice(i, 1); renderItems(); update(); } }, icon("close")),
          ),
          h("md-chip-set", { "aria-label": `Who had item ${i + 1}` }, members.map((m) => {
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
        icon("add", "icon"), "Add item"),
      h("div", { class: "row wrap" },
        h("md-outlined-text-field", { class: "grow", label: "Service charge", suffixText: "%", inputMode: "decimal", value: serviceStr, dataset: { testid: "item-service" },
          oninput: (e: Event) => { serviceStr = (e.target as Field).value; update(); } }),
        h("md-outlined-text-field", { class: "grow", label: "Tax / VAT", suffixText: "%", inputMode: "decimal", value: taxStr, dataset: { testid: "item-tax" },
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
          items: items.map((it) => ({ description: it.description.trim() || "Item", amount: parseMoney(it.amount, currency) ?? -1, members: members.filter((m) => it.members.has(m.id)).map((m) => m.id) })),
          serviceBp: serviceStr.trim() ? toBp(serviceStr) ?? -1 : 0,
          taxBp: taxStr.trim() ? toBp(taxStr) ?? -1 : 0,
        };
    }
  }

  function buildBody(): BillInput {
    if (kind === "payment")
      return { kind, description: description.value.trim() || "Payment", amount: parseMoney(amount.value, currency) ?? -1, paidBy: paidBy.value, date: date.value, category: "other", split: { mode: "equal", members: [receiver.value] } };
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
      return { ok: false, error: e instanceof ValidationError ? humanize(e.message) : "Check the amounts" };
    }
  }

  function humanize(msg: string): string {
    const sums = msg.match(/^(payers|shares) sum \((\d+)\) must equal amount \((\d+)\)/);
    if (sums)
      return `${sums[1] === "payers" ? "Payers" : "Amounts"} add up to ${formatMoney(+sums[2], currency)}, the bill is ${formatMoney(+sums[3], currency)}`;
    if (/computed amount|amount must be an integer|amount out of range|fx\.amount/.test(msg)) return "Enter an amount";
    if (/share amount|percent \(bp\)|item \d+ amount|payer amount|weight/.test(msg)) return "Check the numbers — only positive amounts with up to 2 decimals";
    if (/fx\.rate/.test(msg)) return "Enter an exchange rate, e.g. 36.25";
    if (/split\.members must be a non-empty/.test(msg)) return "Select at least one person";
    if (/members must be a non-empty/.test(msg)) return "Each item needs at least one person";
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
      splitStatus.textContent = `${formatMoney(p.amount, currency)} · ${n} ${n === 1 ? "person" : "people"}`;
      splitStatus.classList.remove("error");
    } else {
      splitStatus.textContent = p.error;
      splitStatus.classList.add("error");
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
    const canvas = h("canvas", { width: 240, height: 240, role: "img", "aria-label": `PromptPay QR code to pay ${to!.name} ${formatMoney(amt!, currency)}`, dataset: { testid: "qr-canvas" } });
    clear(qrBox,
      h("div", { class: "md-typescale-title-small" }, icon("qr_code_2"), ` Pay ${to!.name} with PromptPay`),
      canvas,
      h("div", { class: "md-typescale-body-small muted" }, "Scan with any Thai banking app, then tap Save to record the payment."));
    const payload = promptPayPayload(to!.promptpay!, amt!);
    qrBox.dataset.payload = payload;
    void renderQr(canvas, payload).catch(() => { qrBox.hidden = true; });
  }

  // ---------- more: repeat + receipt ----------
  const repeatSel = h("md-outlined-select", { quick: true, label: "Repeat", dataset: { testid: "bill-repeat" }, onchange: () => { repeat = repeatSel.value as typeof repeat; receiptBox.hidden = repeat !== "none"; } },
    h("md-select-option", { value: "none", selected: true }, h("div", { slot: "headline" }, "Doesn't repeat")),
    h("md-select-option", { value: "weekly" }, h("div", { slot: "headline" }, "Every week")),
    h("md-select-option", { value: "monthly" }, h("div", { slot: "headline" }, "Every month"))) as Select;

  const fileInput = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp", class: "visually-hidden", "aria-label": "Choose receipt photo", dataset: { testid: "receipt-input" } }) as HTMLInputElement;
  const receiptPreview = h("div", { class: "receipt-preview", dataset: { testid: "receipt-preview" } });
  const receiptBox = h("div", { class: "stack-sm" }, fileInput, receiptPreview);
  function renderReceipt() {
    const existing = bill?.hasReceipt && !removeReceipt;
    const src = pendingReceipt ? URL.createObjectURL(pendingReceipt) : existing ? receiptUrl(gid, bill!.id, bill!.updatedAt) : null;
    clear(receiptPreview,
      src && h("a", { href: src, target: "_blank", rel: "noopener", class: "receipt-thumb", "aria-label": "Open receipt photo" }, h("img", { src, alt: "Receipt photo", dataset: { testid: "receipt-img" } })),
      h("div", { class: "row" },
        h("md-outlined-button", { type: "button", onclick: () => fileInput.click(), dataset: { testid: "receipt-add" } }, icon("photo_camera", "icon"), src ? "Replace photo" : "Add receipt photo"),
        src && h("md-text-button", { type: "button", class: "danger", dataset: { testid: "receipt-remove" }, onclick: () => { pendingReceipt = null; removeReceipt = !!bill?.hasReceipt; renderReceipt(); } }, "Remove")));
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
      snackbar("Couldn't use that image — try a JPEG or PNG photo");
    }
  });

  // ---------- save / delete ----------
  const saveBtn = h("md-filled-button", { onclick: () => save(), dataset: { testid: "bill-save" } }, "Save") as HTMLElement & { disabled: boolean };

  async function save() {
    formError.textContent = "";
    description.error = amount.error = false;
    if (kind === "expense" && !description.value.trim()) {
      description.error = true;
      description.errorText = "What was it for?";
      return description.focus();
    }
    if (kind === "payment" && paidBy.value === receiver.value) {
      formError.textContent = "From and To must be different people";
      return;
    }
    const p = kind === "payment" ? null : preview();
    if (p && !p.ok) {
      formError.textContent = p.error;
      if (p.error === "Enter an amount" && !amount.disabled) { amount.error = true; amount.errorText = p.error; amount.focus(); }
      return;
    }
    const body = buildBody();
    if (kind === "payment" && !(body.amount! > 0)) {
      amount.error = true;
      amount.errorText = "Enter an amount";
      return amount.focus();
    }
    if (p?.ok && body.payers) {
      const sum = body.payers.reduce((a, x) => a + x.amount, 0);
      if (sum !== p.amount) {
        formError.textContent = `Payers add up to ${formatMoney(sum, currency)}, the bill is ${formatMoney(p.amount, currency)}`;
        return;
      }
    }
    saveBtn.disabled = true;
    try {
      let saved: Bill | null = null;
      if (!bill && repeat !== "none") {
        const { date: start, ...template } = body;
        const r = await api.createRecurring(gid, repeat, start, template);
        snackbar(r.created ? `Repeating bill added (${r.created} so far)` : "Repeating bill scheduled");
      } else {
        saved = bill ? (await api.updateBill(gid, bill.id, body)).bill : (await api.createBill(gid, body)).bill;
        if (pendingReceipt) await api.uploadReceipt(gid, saved.id, pendingReceipt);
        else if (removeReceipt && bill?.hasReceipt) await api.deleteReceipt(gid, bill.id);
        snackbar(bill ? "Bill updated" : kind === "payment" ? "Payment recorded" : "Bill added");
      }
      if (kind === "expense" && !multiPayer) store.set(lastPayerKey(gid), paidBy.value);
      changed = true;
      dialog.close("saved");
    } catch (err) {
      formError.textContent = err instanceof ApiError ? err.message : "Could not save";
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function remove() {
    if (!bill) return;
    if (!(await confirmDialog("Delete bill?", `“${bill.description}” will be removed. You can undo right after.`))) return;
    try {
      await api.deleteBill(gid, bill.id);
      changed = true;
      opts.onDeleted?.(bill);
      dialog.close("deleted");
    } catch (err) {
      formError.textContent = err instanceof ApiError ? err.message : "Could not delete";
    }
  }

  // ---------- layout ----------
  const title = bill ? (kind === "payment" ? "Edit payment" : "Edit bill") : kind === "payment" ? "Record payment" : "Add bill";
  const meta = bill?.createdBy ? h("div", { class: "md-typescale-body-small muted", dataset: { testid: "bill-created-by" } },
    bill.createdBy === "recurring" ? "Added automatically (repeating bill)" : `Added by ${bill.createdBy}`) : null;

  const content =
    kind === "payment"
      ? h("div", { class: "stack" }, h("div", { class: "row wrap" }, paidBy, icon("arrow_forward"), receiver), amount, qrBox, date, description, formError)
      : h("div", { class: "stack" },
          amount,
          h("div", { class: "row wrap tight-gap" }, fxChip),
          fxBox,
          description,
          categorySet,
          h("div", { class: "row wrap" }, h("div", { class: "grow" }, date), h("div", { class: "grow" }, payersBox)),
          h("div", { class: "row end" }, multiBtn),
          h("div", { class: "split-head" }, h("span", { class: "md-typescale-title-small", id: "split-label" }, "Split"),
            h("md-chip-set", { class: "chip-scroll", "aria-labelledby": "split-label" }, modeChips)),
          itemsBox,
          splitList,
          splitStatus,
          h("details", { class: "more" }, h("summary", { class: "md-typescale-title-small" }, "More options"),
            h("div", { class: "stack" }, !bill && repeatSel, receiptBox)),
          meta,
          formError,
        );

  const dialog = h(
    "md-dialog",
    { class: "bill-dialog", dataset: { testid: "bill-dialog" } },
    h("div", { slot: "headline" }, title),
    h("form", { slot: "content", id: "bill-form", novalidate: true, onsubmit: (e: Event) => { e.preventDefault(); save(); } }, content),
    h("div", { slot: "actions" },
      bill && h("md-text-button", { class: "danger push-left", onclick: remove, dataset: { testid: "bill-delete" } }, "Delete"),
      h("md-text-button", { onclick: () => dialog.close("cancel"), dataset: { testid: "bill-cancel" } }, "Cancel"),
      saveBtn),
  ) as MdDialog;

  // Payment layout places `paidBy` itself; renderPayers would move it into the (expense-only) payers box.
  if (kind === "expense") renderPayers();
  renderSplit();
  renderReceipt();
  if (fxOn) prefillRate();
  update();
  // Quick add: amount first.
  dialog.addEventListener("opened", () => {
    update(); // md-select values exist only after first render (QR + previews need them)
    if (!bill && kind === "expense") amount.focus();
  }, { once: true });
  await openDialog(dialog);
  return changed;
}
