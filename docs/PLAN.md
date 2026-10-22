# Plan & Task Dispatch Assessment

Goal: bill-splitting web app (Splitwise / KittySplit style) on Cloudflare Workers.

## Product scope (v0.1)

KittySplit model — no user accounts inside the app. Cloudflare Access gates who can reach the site.

- Create a **group** ("trip", "flat") → gets unguessable share link `/g/<id>`.
- Add **members** (names) to group.
- Add **bill**: description, amount, date, who paid, who shares it.
  Split modes: `equal` among selected members, or `exact` amounts per member.
- Edit / delete bill.
- **Summary**: per-member balance + minimal "X pays Y amount" settlement list.
- Record **settlement payment** (a bill of kind `payment` from debtor → creditor).

## Tasks & who does them

Model tiers: **Opus** (me, main thread) = design/architecture/judgment-heavy; **Sonnet** = well-specified
routine code against a fixed contract; **Haiku** = mechanical, tiny-context work.

| # | Task | Owner | Why |
|---|------|-------|-----|
| 1 | Architecture, data model, API contract (`docs/ARCHITECTURE.md`, `docs/API.md`) | Opus | Sets contract everything else depends on |
| 2 | Scaffold: git, package.json, wrangler.jsonc, tsconfig, D1 migration | Opus | Small, but config errors cascade |
| 3 | Money/split/settlement logic (`src/lib/*`) + unit tests | Opus | Correctness-critical (rounding, cents) |
| 4 | Worker API (Hono routes, validation, security headers, Access JWT check) | Opus | Security-sensitive |
| 5 | Frontend SPA with Material Web (M3), responsive mobile + laptop | Opus | UX judgment, ties to API |
| 6 | Integration tests (vitest-pool-workers + D1) | Sonnet | Routine once API.md fixed |
| 7 | System + security test suites (HTTP vs running server) | Sonnet | Routine against contract; I review |
| 8 | E2E + compatibility tests (Playwright, 5 browser/device profiles) | Opus | Depends on exact DOM; flaky-prone |
| 9 | Test runner scripts (`scripts/*.sh`), Access token template | Opus | Small |
| 10 | Deploy (D1 create, migrate, wrangler deploy), prod test | Opus | Needs account auth, judgment on failures |
| 11 | Docs upkeep (CHANGELOG, PROGRESS, ISSUES) after each cycle | Haiku-capable | Mechanical, but main thread does it inline when context already loaded |

Rule of thumb for future agents: dispatch to Sonnet when the task has a written contract
(API.md, a failing test, a clear diff target). Keep on Opus anything touching money math, auth,
or architecture. Haiku only for doc formatting / changelog entries.

## Default workflow (every change)

See `CLAUDE.md` → "Workflow". Summary:
1. Change code + tests.
2. `npm run test:local` (typecheck, unit, integration, build, system/security/E2E vs `wrangler dev`).
3. Pass → `npm run deploy` → `npm run test:prod` (system/security/E2E vs prod, with Access service token).
4. Pass → update `docs/*.md` (CHANGELOG, PROGRESS, ISSUES, ARCHITECTURE if changed).
5. `git commit`; `git push` once remote configured (none yet).
