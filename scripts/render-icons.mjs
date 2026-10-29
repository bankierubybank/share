// Renders the PWA PNG icons from the SVGs in web/public (run after changing an icon):
//   node scripts/render-icons.mjs
// icon.svg → icon-192.png, icon-512.png, apple-touch-icon.png (180, iOS adds its own corners: full-bleed source);
// icon-maskable.svg (glyph inside the 80% safe zone) → icon-maskable-512.png.
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const dir = new URL("../web/public/", import.meta.url);
const jobs = [
  ["icon.svg", 192, "icon-192.png"],
  ["icon.svg", 512, "icon-512.png"],
  ["icon-maskable.svg", 512, "icon-maskable-512.png"],
  ["icon-maskable.svg", 180, "apple-touch-icon.png"],
];

const browser = await chromium.launch();
try {
  for (const [src, size, out] of jobs) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const svg = readFileSync(new URL(src, dir), "utf8");
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: new URL(out, dir).pathname, omitBackground: true });
    await page.close();
    console.log(`${out} (${size}px)`);
  }
} finally {
  await browser.close();
}
