// Receipt-scan prompt lab: renders sample receipts (below) to images, sends each to the lab worker and scores what
// comes back against the known answer. Start the lab first:
//   npx wrangler dev -c scripts/scan-lab/wrangler.jsonc --port 8798
//   node scripts/scan-lab/run.mjs [name…]
import { chromium } from "@playwright/test";

const LAB = process.env.LAB_URL ?? "http://localhost:8798";
const style = "font:17px/1.5 'Courier New',monospace;padding:22px;background:#fff;color:#111;width:380px";
const line = (l, r) => `<div style="display:flex;justify-content:space-between"><span>${l}</span><span>${r}</span></div>`;

/** html, trip currency, and the right answer (what normalizeScan should return). */
export const RECEIPTS = {
  "th-street": {
    currency: "THB",
    html: `<h2 style="text-align:center;margin:0">BAAN SOM TAM</h2><p style="text-align:center">Chiang Mai · 28/10/2026 19:42</p><hr>
      ${line("Som tam thai", "80.00")}${line("Gai yang", "150.00")}${line("Sticky rice x2", "40.00")}${line("Singha beer", "90.00")}<hr>
      ${line("<b>TOTAL THB</b>", "<b>360.00</b>")}<p style="text-align:center">Thank you · ขอบคุณค่ะ</p>`,
    expect: { description: "BAAN SOM TAM", amount: 36000, date: "2026-10-28", category: "food", items: 4 },
  },
  "th-restaurant-be": {
    currency: "THB",
    html: `<h2 style="text-align:center;margin:0">ครัวคุณยาย</h2><p style="text-align:center">สาขาสุขุมวิท 33<br>วันที่ 27/10/2569 13:05</p><hr>
      ${line("ต้มยำกุ้ง", "250.00")}${line("ผัดไทย", "120.00")}${line("น้ำมะพร้าว 2 x 60", "120.00")}<hr>
      ${line("รวม", "490.00")}${line("Service charge 10%", "49.00")}${line("VAT 7%", "37.73")}<hr>
      ${line("<b>ยอดสุทธิ</b>", "<b>576.73</b>")}`,
    expect: { description: "ครัวคุณยาย", amount: 57673, date: "2026-10-27", category: "food", items: 3, serviceBp: 1000, taxBp: 700 },
  },
  "jp-ramen": {
    currency: "THB",
    html: `<h2 style="text-align:center;margin:0">一蘭 渋谷店</h2><p style="text-align:center">2026年10月26日 21:10</p><hr>
      ${line("天然とんこつラーメン", "¥980")}${line("替玉", "¥210")}${line("生ビール", "¥790")}<hr>
      ${line("<b>合計</b>", "<b>¥1,980</b>")}<p>(内消費税 ¥180)</p>`,
    expect: { description: "一蘭 渋谷店", fx: { currency: "JPY", amount: 1980 }, date: "2026-10-26", category: "food" },
  },
  "us-diner": {
    currency: "USD",
    html: `<h2 style="text-align:center;margin:0">JOE'S DINER</h2><p style="text-align:center">Austin TX · 10/25/2026 8:14 PM</p><hr>
      ${line("Cheeseburger", "12.50")}${line("Fries", "4.00")}${line("Soda", "2.50")}<hr>
      ${line("Subtotal", "19.00")}${line("Tax 8.25%", "1.57")}${line("Tip", "3.80")}<hr>${line("<b>TOTAL</b>", "<b>$24.37</b>")}<p>VISA ****1234</p>`,
    expect: { description: "JOE'S DINER", amount: 2437, date: "2026-10-25", category: "food" },
  },
  "th-7eleven": {
    currency: "THB",
    html: `<h2 style="text-align:center;margin:0">7-ELEVEN</h2><p style="text-align:center">CP ALL · Store 01234<br>29/10/26 07:51</p><hr>
      ${line("น้ำดื่ม 600ml 2@7.00", "14.00")}${line("ข้าวกล้องหมู", "45.00")}${line("กาแฟ All Cafe", "39.00")}${line("Lays Classic", "20.00")}${line("ทิชชู่", "15.00")}<hr>
      ${line("<b>TOTAL</b>", "<b>133.00</b>")}${line("CASH", "200.00")}${line("CHANGE", "67.00")}<p>VAT INCLUDED</p>`,
    expect: { description: "7-ELEVEN", amount: 13300, date: "2026-10-29", category: "groceries", items: 5 },
  },
};

function score(exp, got) {
  const out = [];
  for (const [k, v] of Object.entries(exp)) {
    const g = k === "items" ? got.items?.length : got[k];
    const ok = JSON.stringify(g) === JSON.stringify(v) || (k === "description" && typeof g === "string" && g.toLowerCase().includes(String(v).toLowerCase().slice(0, 6)));
    out.push(`${ok ? "✓" : "✗"} ${k}=${JSON.stringify(g)}${ok ? "" : ` (want ${JSON.stringify(v)})`}`);
  }
  return out;
}

const only = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 440, height: 400 }, deviceScaleFactor: 2 });
let good = 0, total = 0;
for (const [name, r] of Object.entries(RECEIPTS)) {
  if (only.length && !only.includes(name)) continue;
  await page.setContent(`<body style="margin:0"><div style="${style}">${r.html}</div></body>`);
  const png = await page.locator("div").first().screenshot();
  const res = await fetch(`${LAB}/?currency=${r.currency}`, { method: "POST", headers: { "Content-Type": "image/png" }, body: png });
  const j = await res.json();
  const s = score(r.expect, j.scan);
  good += s.filter((x) => x.startsWith("✓")).length;
  total += s.length;
  console.log(`\n${name} (${j.ms} ms)\n  ${s.join("\n  ")}`);
  if (process.env.RAW) console.log("  raw:", JSON.stringify(j.raw));
}
await browser.close();
console.log(`\nscore ${good}/${total}`);
