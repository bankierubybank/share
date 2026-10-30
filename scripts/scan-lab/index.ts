// Receipt-scan prompt lab: POST an image (?currency=THB) → the model's raw answer + what normalizeScan makes of it,
// with exactly the app's request (src/lib/scan.ts). Local dev only (no auth): never deploy this.
import { normalizeScan, SCAN_MODEL, scanRequest } from "../../src/lib/scan";

export default {
  async fetch(req: Request, env: { AI: Ai }) {
    if (req.method !== "POST") return new Response("POST an image", { status: 405 });
    const url = new URL(req.url);
    const bytes = new Uint8Array(await req.arrayBuffer());
    const t0 = Date.now();
    const out = (await env.AI.run(SCAN_MODEL, scanRequest(bytes, req.headers.get("Content-Type") ?? "image/png") as never)) as { response?: unknown };
    const raw = out?.response ?? out;
    return Response.json({ ms: Date.now() - t0, raw, scan: normalizeScan(raw, url.searchParams.get("currency") ?? "THB", url.searchParams.get("today") ?? "2026-10-30") });
  },
} satisfies ExportedHandler<{ AI: Ai }>;
