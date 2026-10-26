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
| 19 | fixed 2026-10-26 | security | Merge put the source group's id (its edit secret) into the target's activity `entityId`. Now null. Regression test in `test/security/v3-security.test.ts`. |
| 20 | fixed 2026-10-26 | bug | Comment length counted UTF-16 units; now code points. |
| 21 | fixed 2026-10-26 | ui | Read-only view showed the laptop "Add bill" button; Duplicate stacked two dialogs. |
| 22 | note | design | Move/merge authorization = possession of both group ids (KittySplit model); members matched by name. |
| 23 | note | test | On prod, Cloudflare's edge answers some malformed URLs (e.g. `/api/view/%00`) with 400 before the Worker; tests accept 400 or 404 (never 2xx/5xx). |
| 18 | note | test | WebKit: md-dialog needs `autofocus` attr (script focus doesn't stick). E2E waits for `data-ready` on dialogs and for the re-render after saves. |
