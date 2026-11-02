// v0.12 (#10): several receipt photos at once. Each is read in turn (the scan limit is 10 a minute: on 429 it waits
// and goes on), then reviewed one by one in the normal bill dialog — nothing is saved until Save there.
import { api, ApiError, type ReceiptScan } from "../api";
import { clear, h, icon } from "../dom";
import { openDialog, type MdDialog } from "../dialogs";
import { downscaleImage } from "../image";
import { formatMoney } from "../money";
import { t } from "../i18n";

export const SCAN_MAX_FILES = 10;

interface Row {
  file: File;
  state: "waiting" | "reading" | "ready" | "failed" | "added";
  scan?: ReceiptScan;
  image?: Blob;
}

/** `review` opens the bill dialog for one receipt; resolves true when it was saved. Resolves with how many were added. */
export async function scanQueueDialog(
  gid: string, currency: string, files: File[], review: (scan: ReceiptScan, image: Blob) => Promise<boolean>, wait = 60_000,
): Promise<number> {
  const rows: Row[] = files.slice(0, SCAN_MAX_FILES).map((file) => ({ file, state: "waiting" }));
  const list = h("div", { class: "stack-sm", dataset: { testid: "scanq-list" } });
  const note = h("p", { class: "md-typescale-body-small muted", role: "status", dataset: { testid: "scanq-note" } },
    files.length > SCAN_MAX_FILES ? t("scanq.tooMany", { n: SCAN_MAX_FILES }) : "");
  let open = true;
  let added = 0;

  const amountOf = (s: ReceiptScan) =>
    s.fx ? formatMoney(s.fx.amount, s.fx.currency) : s.amount ? formatMoney(s.amount, currency) : "";
  function label(r: Row, i: number) {
    const n = t("scanq.item", { n: i + 1 });
    const what = r.scan?.description || n;
    switch (r.state) {
      case "waiting": return `${n} · ${t("scanq.waiting")}`;
      case "reading": return `${n} · ${t("scan.reading")}`;
      case "failed": return `${n} · ${t("scanq.failed")}`;
      case "ready": return [what, amountOf(r.scan!)].filter(Boolean).join(" · ");
      case "added": return `${what} · ${t("scanq.added")}`;
    }
  }
  const render = () => clear(list, ...rows.map((r, i) =>
    h("div", { class: "row scanq-row", dataset: { testid: "scanq-row", state: r.state } },
      h("span", { class: "grow" }, label(r, i)),
      r.state === "ready" && h("md-outlined-button", { type: "button", dataset: { testid: "scanq-review" }, onclick: () => void doReview(r) }, t("scanq.review")),
      r.state === "added" && icon("check_circle", "icon"))));

  async function doReview(r: Row) {
    if (!r.scan || !r.image) return;
    if (await review(r.scan, r.image)) {
      r.state = "added";
      added++;
      render();
    }
  }

  async function run() {
    for (const r of rows) {
      if (!open) return;
      r.state = "reading";
      render();
      try {
        r.image = await downscaleImage(r.file);
        for (;;) {
          try {
            r.scan = (await api.scanReceipt(gid, r.image)).scan;
            break;
          } catch (e) {
            if (!(e instanceof ApiError && e.status === 429) || !open) throw e;
            note.textContent = t("scanq.limit");
            await new Promise((res) => setTimeout(res, wait));
            note.textContent = "";
          }
        }
        r.state = "ready";
      } catch {
        r.state = "failed";
      }
      render();
    }
  }

  const d = h("md-dialog", { dataset: { testid: "scanq-dialog" } },
    h("div", { slot: "headline" }, t("scanq.title")),
    h("div", { slot: "content", class: "stack" }, h("p", { class: "md-typescale-body-small muted" }, t("scanq.help")), note, list),
    h("div", { slot: "actions" }, h("md-text-button", { onclick: () => d.close("done"), dataset: { testid: "scanq-done" } }, t("common.close")))) as MdDialog;
  render();
  const closed = openDialog(d);
  void run();
  await closed;
  open = false;
  return added;
}
