// Trip summary as one picture (v0.9, #10): totals, everyone's balance and who pays whom, drawn on a canvas so it can
// be posted to a group chat. Lazy chunk. Always the light palette (a chat shows it on any background).
// Text is drawn with fillText — user data never becomes markup.

export interface SummaryImage {
  trip: string;
  /** "Total ฿12,300.00 · 8 bills · 4 people" */
  subtitle: string;
  /** "Budget ฿20,000.00 · ฿7,700.00 left", or null. */
  budget: string | null;
  /** 0…1+ share of the budget spent (bar), when there is a budget. */
  budgetUsed: number | null;
  balancesTitle: string;
  balances: { name: string; text: string; tone: "pos" | "neg" | "zero" }[];
  paysTitle: string;
  /** "Ben → Ann  ฿150.00"; empty = settled (then `settled` is shown). */
  pays: { text: string; amount: string }[];
  settled: string;
  footer: string;
}

const W = 1080;
const PAD = 64;
const C = { bg: "#f4fbf8", card: "#ffffff", head: "#006a60", onHead: "#ffffff", text: "#161d1c", muted: "#3f4947", pos: "#1b6c35", neg: "#ba1a1a", line: "#dae5e2", warn: "#8c5000" };
const FONT = `Roboto, "Noto Sans Thai", "Sukhumvit Set", Tahoma, system-ui, sans-serif`;

/** Cuts `s` with "…" so it fits `max` px in the current font. */
function fit(ctx: CanvasRenderingContext2D, s: string, max: number): string {
  if (ctx.measureText(s).width <= max) return s;
  const chars = [...s];
  while (chars.length > 1 && ctx.measureText(`${chars.join("")}…`).width > max) chars.pop();
  return `${chars.join("")}…`;
}

export function layoutHeight(d: SummaryImage): number {
  const rows = d.balances.length + Math.max(1, d.pays.length);
  return 240 + (d.budget ? 110 : 0) + 2 * 110 + rows * 64 + 120;
}

export async function summaryPng(d: SummaryImage): Promise<Blob> {
  await document.fonts?.ready.catch(() => undefined);
  const H = layoutHeight(d);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  const font = (px: number, weight = 400) => (ctx.font = `${weight} ${px}px ${FONT}`);

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  // Header band: trip name + totals.
  ctx.fillStyle = C.head;
  ctx.fillRect(0, 0, W, 220);
  ctx.fillStyle = C.onHead;
  ctx.textBaseline = "alphabetic";
  font(60, 700);
  ctx.fillText(fit(ctx, d.trip, W - 2 * PAD), PAD, 110);
  font(32);
  ctx.fillText(fit(ctx, d.subtitle, W - 2 * PAD), PAD, 172);

  let y = 240;
  if (d.budget && d.budgetUsed !== null) {
    const over = d.budgetUsed > 1;
    font(30, 500);
    ctx.fillStyle = over ? C.neg : d.budgetUsed >= 0.8 ? C.warn : C.text;
    ctx.fillText(fit(ctx, d.budget, W - 2 * PAD), PAD, y + 40);
    ctx.fillStyle = C.line;
    ctx.fillRect(PAD, y + 60, W - 2 * PAD, 16);
    ctx.fillStyle = over ? C.neg : d.budgetUsed >= 0.8 ? C.warn : C.head;
    ctx.fillRect(PAD, y + 60, (W - 2 * PAD) * Math.min(1, d.budgetUsed), 16);
    y += 110;
  }

  const section = (title: string, rows: { left: string; right: string; color: string }[]) => {
    const h = 90 + rows.length * 64;
    ctx.fillStyle = C.card;
    ctx.fillRect(PAD / 2, y, W - PAD, h);
    ctx.fillStyle = C.muted;
    font(30, 500);
    ctx.fillText(title, PAD, y + 56);
    rows.forEach((r, i) => {
      const ry = y + 90 + i * 64 + 40;
      if (i > 0) {
        ctx.fillStyle = C.line;
        ctx.fillRect(PAD, ry - 46, W - 2 * PAD, 2);
      }
      font(34, 500);
      const right = r.right;
      const rw = ctx.measureText(right).width;
      ctx.fillStyle = r.color;
      ctx.fillText(right, W - PAD - rw, ry);
      font(34);
      ctx.fillStyle = C.text;
      ctx.fillText(fit(ctx, r.left, W - 3 * PAD - rw), PAD, ry);
    });
    y += h + 20;
  };

  section(d.balancesTitle, d.balances.map((b) => ({ left: b.name, right: b.text, color: b.tone === "pos" ? C.pos : b.tone === "neg" ? C.neg : C.muted })));
  section(d.paysTitle, d.pays.length ? d.pays.map((p) => ({ left: p.text, right: p.amount, color: C.text })) : [{ left: d.settled, right: "", color: C.text }]);

  ctx.fillStyle = C.muted;
  font(26);
  ctx.fillText(fit(ctx, d.footer, W - 2 * PAD), PAD, H - 40);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not draw the image"))), "image/png"));
}
