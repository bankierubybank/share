# Plan & Task Dispatch

Goal: bill-splitting web app (Splitwise / KittySplit style) on Cloudflare Workers. KittySplit model — no in-app
accounts; Cloudflare Access gates the site; possession of a group link (`/g/<id>`) = edit access to that group.

## Model tiers (how work is split)

| Tier | Use for | Examples in this repo |
|------|---------|-----------------------|
| **Opus** (main thread) | Architecture, contracts, money math, auth/security, migrations, UX, review of agent output | data model, `src/lib/money.ts`/`split.ts`, migrations, routes, all views |
| **Sonnet** (subagent) | Well-specified work against a written contract (API.md, a failing test, a module interface) | API test suites, pure UI modules, i18n string extraction + translation |
| **Haiku** | Mechanical, tiny-context edits | changelog / doc formatting (done inline so far) |

Rules that worked:
- Give Sonnet a **contract** (docs/API.md section, module signature) and a **fence** (which dirs it may edit).
  Ask it to *write failing tests for source bugs instead of fixing them* — every round it found real bugs.
- Never let two writers touch the same files at once; Sonnet works on tests / isolated modules while Opus builds UI.
- Opus reviews every hand-back (e.g. rejected "allow bodyless POST" — kept the CSRF guard, changed the client).

## Dispatch history

| Round | Opus | Sonnet | Bugs Sonnet's tests found |
|-------|------|--------|---------------------------|
| v0.1 (2026-10-22) | scaffold, schema, API, money math, UI, E2E, scripts, deploy | integration + system + security suites | `BASE_URL` clobbered by Vitest; share order |
| v0.2 (2026-10-26) | migration 0002, split/fx math, routes, cron, backup, UI for 20 items, E2E, a11y | PromptPay / CSV / image modules; v2 API suites | restore 415, receipt CSP overwritten, `limit=2.7` 500, actor not validated |
| v0.3 (2026-10-26) | migration 0003, social routes, UI for 9 items, E2E | v3 API suites; Thai/English i18n (348 keys) | **merge leaked source group id via activity**; emoji comment length |
| review (2026-10-27) | full code review + doc cross-check | — | (Opus) unbounded chunked bodies, runaway recurrences, scheduled steps coupled, stale group render over home, blob URL leak |
| v0.4 (2026-10-27) | membership (auth = Opus tier, kept inline): identity, migration 0004, gating, claim, UI, all test suites | — (auth change, not dispatched) | (prod E2E) home re-render wiped a half-typed form when "my trips" arrived |

## Product scope

See `README.md` → Features and `docs/PROGRESS.md` for what's done and the backlog.

## Default workflow

See `CLAUDE.md` → "Workflow": test local → deploy → test prod → update docs → commit (→ push once a remote exists).
