# Issues

| # | Status | Type | Summary |
|---|--------|------|---------|
| 1 | open | env | Playwright Firefox (Nightly 1555) fails to launch on this Mac (Darwin 27): `Could not find profile folder`. Same with sandbox disabled / custom TMPDIR. Excluded from `test:local` default matrix (`COMPAT_PROJECTS` env overrides). Retry after Playwright update. |
| 2 | fixed 2026-10-23 | blocker | Deploy blocked: wrangler OAuth login only had account `daf82c7c…`. Fixed by owner: `CLOUDFLARE_API_TOKEN` for account `d20bca6d…` in `.env` (git-ignored). |
| 3 | fixed 2026-10-26 | chore | Prod test runs accumulated groups. 0.2 adds `DELETE /api/groups/:gid`; API suites (`cleanupGroups`) and the E2E fixture delete what they create (verified: prod 290 → 290 across a run). Leftovers cleaned 2026-10-26 with owner OK: 288 test groups (317 bills) deleted via `DELETE /api/groups/:gid` (all 204); kept "Phuket trip" + "Khao Sok". Prod now 2 groups / 5 bills, no orphan rows. |
| 4 | fixed | bug | Bill shares returned in DB order, not member order. Fixed in `src/db.ts` (ORDER BY members.position). |
| 5 | fixed | test | Vitest forces `process.env.BASE_URL="/"`; tests now use `TARGET_URL`. |
| 6 | note | policy | Org hooks on this machine block `rm -rf` and shell commands containing SQL-injection-like strings; use Write/Edit tools. |
| 7 | fixed 2026-10-26 | bug | Balances `paid`/`owed` counted settle-up payments (net was right). Fixed in `computeBalances`. |
| 8 | fixed 2026-10-26 | ui | Phone balance rows clipped amounts ("THB 3,250.…"); laptop FAB overlapped People card. |
| 9 | leak fixed 2026-10-26 / **rotation pending (owner, deferred)** | security | E2E config leaked Access service token to Google Fonts hosts (prod runs 2026-10-23 + 26). Fixed via per-origin route fixture. Owner to rotate service token `share-tests`, update `.env.test`, re-run `npm run test:prod`. Risk low: HTTPS to Google only; still needs a 22-char group link to read data. |
| 10 | fixed 2026-10-26 | data-loss (local only) | Migration 0002 draft: `DROP TABLE bills` cascaded into `bill_shares` despite `defer_foreign_keys`. Fixed (backup/restore shares) + `scripts/verify-migration.sh`. Prod exported first (`.tmp/prod-before-0002.sql`); prod counts unchanged after migrate (272 bills / 632 shares). |
| 11 | fixed 2026-10-26 | bug | Restore POST without body → 415 (CSRF guard). Client sends `{}`. |
| 12 | fixed 2026-10-26 | security | Receipt CSP `sandbox` overwritten by global headers. |
| 13 | fixed 2026-10-26 | bug | `activity?limit=2.7` → 500. |
| 14 | fixed 2026-10-26 | security | Actor (Access email header/JWT) not validated. |
| 15 | fixed 2026-10-26 | ui | Material buttons in `<form>` default to submit (steppers/"Several people paid" submitted the bill). |
| 16 | fixed 2026-10-26 | ui | Payment dialog lost its From select; PromptPay QR hidden until md-select first render. |
| 17 | fixed 2026-10-26 | ui | md-menu stuck after first use (close animation `scale(Infinity)`); menus/selects use `quick`. |
| 18 | note | test | WebKit: md-dialog needs `autofocus` attr (script focus doesn't stick). E2E waits for `data-ready` on dialogs and for the re-render after saves. |
| 19 | fixed 2026-10-26 | security | Merge put the source group's id (its edit secret) into the target's activity `entityId`. Now null. Regression test in `test/security/v3-security.test.ts`. |
| 20 | fixed 2026-10-26 | bug | Comment length counted UTF-16 units; now code points. |
| 21 | fixed 2026-10-26 | ui | Read-only view showed the laptop "Add bill" button; Duplicate stacked two dialogs. |
| 22 | note | design | Move/merge authorization = both group ids **and** (v0.4) being linked in both trips; members matched by name. |
| 23 | note | test | On prod, Cloudflare's edge answers some malformed URLs (e.g. `/api/view/%00`) with 400 before the Worker; tests accept 400 or 404 (never 2xx/5xx). |
| 24 | fixed 2026-10-27 | security | Chunked request bodies (no Content-Length) were fully buffered before the 32 KiB / 2 MiB checks → memory exhaustion. Now `readLimited()` stops at the cap. |
| 25 | fixed 2026-10-27 | bug | Repeating bills: no start-date bound (1990 weekly = 60 bills per page load) and auto-created bills ignored the 5000 cap. Now start ∈ [today−92d, today+366d]; materialize stops the recurrence at the cap. |
| 26 | fixed 2026-10-27 | robustness | Scheduled job: a failing backup skipped recurring + purge. Steps now run independently; failures logged and rethrown at the end. |
| 27 | fixed 2026-10-27 | ui | Pull-to-refresh stayed attached after leaving a group (pulling on home re-rendered the old group over it); slow loads could also paint after navigation. Detached on home + `stillHere()` guard. Receipt preview blob URLs now revoked. |
| 28 | mitigated 2026-10-27 | perf | Prod D1 (APAC primary, no read replicas): reads ~150 ms, but multi-statement write batches measured 0.7–7 s (spiky) on 2026-10-27; a middleware-only POST is ~70 ms, so it's the DB write path, not app code. Made prod E2E flaky (10 s waits). Mitigations: recurring catch-up now 1 claim + 1 batch (was ~8 round trips per occurrence; 4.7 s → see CHANGELOG), prod E2E timeouts 30 s / 120 s, prod vitest (system/security) 120 s per test + 300 s hooks, prod E2E 2 workers (more parallel saves queued past 30 s). Watch: if it persists, consider D1 read replication / Sessions API, fewer statements per write, or Durable Object per group. Idle probe 2026-10-27: create group 0.7–1.4 s, add bill 0.8–2 s, read 150 ms. Side effect: the 10 s cleanup hook timed out once → 47 test groups (26 bills) left on prod, deletion pending owner OK. |
| 29 | note | design | v0.4 membership: a trip is visible only to identities linked to its people (`members.email`). Pre-0.4 trips ("Phuket trip", "Khao Sok") are unclaimed until the owner opens them and picks who they are — first visitor wins, so open them soon. Service-token test runs see only their own trips. View links remain an opt-in way to show a trip to non-members. |
| 30 | note | security | Identity must come from the **verified** Access JWT. `DEV_IDENTITY=1` (header trust) is only passed by `wrangler dev --var` / the integration config — never put it in `wrangler.jsonc`. Without JWT vars and without DEV_IDENTITY the app fails closed (401 on trips). If Access JWKS can't be fetched, every request 401s. |
| 31 | note | env | A `wrangler dev` from an earlier gate run (started 2026-10-26, orphaned) still listens on :8787 and hot-reloads `src/` **without** `DEV_IDENTITY` — `test:local` would reuse it (health OK) and every trip call would 401. Workaround: `PORT=8797 npm run test:local`. Owner: stop that process (`lsof -iTCP:8787`). |
