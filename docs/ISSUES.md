# Issues

| # | Status | Type | Summary |
|---|--------|------|---------|
| 1 | open | env | Playwright Firefox (Nightly 1555) fails to launch on this Mac (Darwin 27): `Could not find profile folder`. Same with sandbox disabled / custom TMPDIR. Excluded from `test:local` default matrix (`COMPAT_PROJECTS` env overrides). Retry after Playwright update. |
| 2 | fixed 2026-10-23 | blocker | Deploy blocked: wrangler OAuth login only had account `daf82c7c…`. Fixed by owner: `CLOUDFLARE_API_TOKEN` for account `d20bca6d…` in `.env` (git-ignored). |
| 3 | open | chore | Prod system/security/E2E runs create test groups in prod D1 (unguessable, harmless, but accumulate). Add delete-group endpoint + test cleanup. |
| 4 | fixed | bug | Bill shares returned in DB order, not member order. Fixed in `src/db.ts` (ORDER BY members.position). |
| 5 | fixed | test | Vitest forces `process.env.BASE_URL="/"`; tests now use `TARGET_URL`. |
| 6 | note | policy | Org hooks on this machine block `rm -rf` and shell commands containing SQL-injection-like strings; use Write/Edit tools. |
| 7 | fixed 2026-10-26 | bug | Balances `paid`/`owed` counted settle-up payments (net was right). Fixed in `computeBalances`. |
| 8 | fixed 2026-10-26 | ui | Phone balance rows clipped amounts ("THB 3,250.…"); laptop FAB overlapped People card. |
| 9 | fixed 2026-10-26 / **action: rotate token** | security | E2E config leaked Access service token to Google Fonts hosts (prod runs 2026-10-23 + 26). Fixed via per-origin route fixture. Owner should rotate service token `share-tests` and update `.env.test`. |
