# Share — agent guide

Bill-splitting app (Splitwise/KittySplit style). Cloudflare Worker (Hono) + D1 + R2 + Material Web SPA (TH/EN).
Prod: https://share.bankierubybank.workers.dev (behind Cloudflare Access), account `d20bca6d49889066d98d858a37f6837e`.

Read first: `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/PROGRESS.md`, `docs/ISSUES.md` (open items + lessons).

## Workflow (default for EVERY change)

1. Change code + add/adjust tests (unit / integration / system / security / E2E as relevant).
   New migration? `npm run db:verify` first; before applying remotely `npx wrangler d1 export share-db --remote --output .tmp/prod-before-XXXX.sql`.
2. **Test locally**: `npm run test:local` — must be fully green.
3. **Deploy**: `npm run deploy` (build → remote D1 migrations → `wrangler deploy`).
4. **Test prod**: `npm run test:prod` (needs `.env.test`, see `.env.test.example`).
5. **Update docs**: `docs/CHANGELOG.md` (what changed), `docs/PROGRESS.md` (status), `docs/ISSUES.md`
   (bugs found/fixed, open problems), `docs/ARCHITECTURE.md` / `docs/API.md` if design/contract changed.
6. **Commit** (Conventional Commits). **Push** to `origin` = https://github.com/bankierubybank/share (public):
   `GH_TOKEN=$(gh auth token -u bankierubybank) git push` (the active `gh` account is a work account without
   access). Commit email for this repo: `chatchai.wongdet@gmail.com` (never the work address — the repo is public).
   Pushing `main` runs `ci`, then `deploy` (see docs/CI.md) once its secrets exist.

Steps 2→3→4 = `npm run ship`. Never deploy if local fails; never commit if prod tests fail
(fix forward or `npx wrangler rollback`).

## Conventions

- Money = integer minor units everywhere. Never floats in storage/API.
- All SQL parameterized; every lookup scoped by `group_id`.
- Frontend: build DOM with `h()` (`web/src/dom.ts`); never `innerHTML` with user data.
- New UI elements get `data-testid` for E2E.
- Test env var for target URL is `TARGET_URL` (Vitest reserves `BASE_URL`).
- Org policy hooks block `rm -rf`, some SQL-looking strings and scheduling words (even the bare word "at", e.g. in
  a heredoc) in shell commands — put such edits in files via Write/Edit (or a script file) instead. Don't work around
  a block; relay only what its message says.
- Migrations that rebuild tables: run `bash scripts/verify-migration.sh`, and `wrangler d1 export … --remote`
  before applying remotely (see docs/ARCHITECTURE.md → Data model).
- Material buttons inside a `<form>` default to `type=submit` — always pass `type: "button"`.
- All UI text goes through `t()` (`web/src/i18n.ts`); add the key to `en` AND `th` (compile error otherwise).
  Keys ending `.one` / `.other` are plural pairs for `tn()` (never use them for anything else); both languages need
  the same `{params}`.
- Heavy UI (dialogs, stats, export, move) is lazy: `const loadX = () => import("./x")`. Group-only Material
  components are imported in `views/group.ts`, not `main.ts` (home stays small; E2E checks this).
- Request bodies: never `arrayBuffer()` an unbounded body — use `readLimited()` (`src/lib/body.ts`).
- Local dev / tests run `wrangler dev --local` (the Workers AI binding would otherwise open a remote session) with
  `SCAN_FAKE=1`. Secrets (`VAPID_PRIVATE_KEY`) only via `wrangler secret put`, never in the repo; push endpoints are
  capability URLs — never log them.
- Never write another group's id where this group's users can read it (activity, responses): ids are secrets.
- Every POST/PUT/PATCH must be `application/json` (CSRF guard) — bodyless actions send `{}`.
- E2E: wait for dialogs' `data-ready="1"` and for the re-render after a save; the fixture deletes created groups.
- `md-menu` / `md-outlined-select`: use `quick: true` (animations hang here).
- Authorization = membership (v0.4): trip routes need `c.get("identity")` linked to a member (`members.email`).
  Identity comes only from the verified Access JWT on prod (`src/lib/identity.ts`); tests/dev use
  `DEV_IDENTITY=1` + the `Cf-Access-Authenticated-User-Email` header (default `dev@example.com`). A test acting as
  a second person must link that email to a member first. Anything that looks up *another* trip (move/merge)
  must check membership there too (`otherGroup`).

## Dispatch guidance

See `docs/PLAN.md`. Sonnet: work with a written contract (API.md, failing test). Opus: money math, auth,
architecture, UX. Haiku: changelog/doc formatting.
