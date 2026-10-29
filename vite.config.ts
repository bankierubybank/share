import { defineConfig, type Plugin } from "vite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const outDir = fileURLToPath(new URL("./dist", import.meta.url));

/**
 * Writes this build's bundle list + id into dist/sw.js (v0.9, offline #8): the worker precaches them at install,
 * and a new build = a new sw.js = a fresh cache. Legacy .woff fonts are skipped (every browser here takes woff2).
 */
function swPrecache(): Plugin {
  return {
    name: "sw-precache",
    apply: "build",
    closeBundle() {
      const assets = readdirSync(`${outDir}/assets`).filter((f) => !f.endsWith(".woff")).sort().map((f) => `/assets/${f}`);
      const build = createHash("sha256").update(assets.join("\n")).digest("hex").slice(0, 12);
      const path = `${outDir}/sw.js`;
      const sw = readFileSync(path, "utf8");
      if (!sw.includes("/*__PRECACHE__*/")) throw new Error("sw.js: precache marker missing");
      writeFileSync(path, sw.replace("__BUILD__", build).replace("/*__PRECACHE__*/", assets.map((a) => `, ${JSON.stringify(a)}`).join("")));
    },
  };
}

export default defineConfig({
  root: "web",
  publicDir: "public",
  build: { outDir: "../dist", emptyOutDir: true, target: "es2022", sourcemap: false },
  plugins: [swPrecache()],
});
