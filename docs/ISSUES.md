# Issues

| # | Status | Type | Summary |
|---|--------|------|---------|
| 1 | open | env | Playwright Firefox (Nightly 1555) fails to launch on this Mac (Darwin 27): `Could not find profile folder`. Same with sandbox disabled / custom TMPDIR. Excluded from `test:local` default matrix (`COMPAT_PROJECTS` env overrides). Retry after Playwright update. |
| 2 | open | blocker | Deploy blocked: wrangler OAuth login only has account `daf82c7c…` (NFR - TH - NTT). Target account `d20bca6d…` → `Authentication error [code: 10000]`. Fix: `npx wrangler login` as a user of that account, or put `CLOUDFLARE_API_TOKEN` in `.env` (template `.env.example`). |
| 3 | open | chore | Prod system/security/E2E runs create test groups in prod D1 (unguessable, harmless, but accumulate). Add delete-group endpoint + test cleanup. |
| 4 | fixed | bug | Bill shares returned in DB order, not member order. Fixed in `src/db.ts` (ORDER BY members.position). |
| 5 | fixed | test | Vitest forces `process.env.BASE_URL="/"`; tests now use `TARGET_URL`. |
| 6 | note | policy | Org hooks on this machine block `rm -rf` and shell commands containing SQL-injection-like strings; use Write/Edit tools. |
