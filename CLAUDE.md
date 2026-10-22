# Share — agent guide

Bill-splitting app (Splitwise/KittySplit style). Cloudflare Worker (Hono) + D1 + Material Web SPA.
Prod: https://share.bankierubybank.workers.dev (behind Cloudflare Access), account `d20bca6d49889066d98d858a37f6837e`.

Read first: `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/PROGRESS.md`, `docs/ISSUES.md`.

## Workflow (default for EVERY change)

1. Change code + add/adjust tests (unit / integration / system / security / E2E as relevant).
2. **Test locally**: `npm run test:local` — must be fully green.
3. **Deploy**: `npm run deploy` (build → remote D1 migrations → `wrangler deploy`).
4. **Test prod**: `npm run test:prod` (needs `.env.test`, see `.env.test.example`).
5. **Update docs**: `docs/CHANGELOG.md` (what changed), `docs/PROGRESS.md` (status), `docs/ISSUES.md`
   (bugs found/fixed, open problems), `docs/ARCHITECTURE.md` / `docs/API.md` if design/contract changed.
6. **Commit** (Conventional Commits). **Push** to remote once one is configured (none yet — skip).

Steps 2→3→4 = `npm run ship`. Never deploy if local fails; never commit if prod tests fail
(fix forward or `npx wrangler rollback`).

## Conventions

- Money = integer minor units everywhere. Never floats in storage/API.
- All SQL parameterized; every lookup scoped by `group_id`.
- Frontend: build DOM with `h()` (`web/src/dom.ts`); never `innerHTML` with user data.
- New UI elements get `data-testid` for E2E.
- Test env var for target URL is `TARGET_URL` (Vitest reserves `BASE_URL`).
- Org policy hooks block `rm -rf` and some SQL-looking shell strings — use Write/Edit tools for files.

## Dispatch guidance

See `docs/PLAN.md`. Sonnet: work with a written contract (API.md, failing test). Opus: money math, auth,
architecture, UX. Haiku: changelog/doc formatting.
