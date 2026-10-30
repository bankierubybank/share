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
- Org policy hooks block `rm -rf`, some SQL-looking strings and scheduling words in shell commands — put such
  edits in files via Write/Edit (or a script file) instead.
- Migrations that rebuild tables: run `bash scripts/verify-migration.sh`, and `wrangler d1 export … --remote`
  before applying remotely (see docs/ARCHITECTURE.md → Data model).
- Material buttons inside a `<form>` default to `type=submit` — always pass `type: "button"`.
- All UI text goes through `t()` (`web/src/i18n.ts`); add the key to `en` AND `th` (compile error otherwise).
- Heavy UI (dialogs, stats, export, move) is lazy: `const loadX = () => import("./x")`. Group-only Material
  components are imported in `views/group.ts`, not `main.ts` (home stays small; E2E checks this).
- Request bodies: never `arrayBuffer()` an unbounded body — use `readLimited()` (`src/lib/body.ts`).
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

## macOS stability guard: screenshot / browser usage

This Mac (M1 MacBook Air, 8-core) crashed WindowServer on 2026-10-29 23:48 with
"IOSurface creation failed … system IOSurface limit reached". The crash logged the user out and
killed all running sessions. At the time, 3 Claude Code sessions were running and had made
~1,600 `computer` / `Claude_Browser` screenshot and browser actions between them.

Rules for this session:

1. **Text first, screenshots last.** To check page content, use `get_page_text`, `read_page`,
   `find`, or `javascript_tool` (DOM queries). Take a screenshot only when visual layout
   itself is what you need to verify, e.g. CSS alignment or overflow.
2. **No screenshot loops.** Never poll with repeated screenshots to wait for something.
   Wait on a DOM condition or use `computer_wait`. Max ~1 screenshot per verification step.
3. **Batch, don't spam.** Combine actions in one `browser_batch` and take a single
   screenshot at the end if needed, not after every click.
4. **Clean up.** Close tabs you opened when a task is done. Don't leave extra browser
   windows or tabs open.
5. **Playwright (if used):** run headless, prefer Chromium over WebKit, and always close the
   browser/context at the end of each test run (`await browser.close()`).
6. **Health check every ~30–45 minutes of browser work**, or before a long unattended stretch.
   Run:
   for p in $(pgrep -i "claude|chrome|webkit"); do n=$(basename "$(ps -o comm= -p $p)"); s=$(vmmap -summary $p 2>/dev/null | grep -E "^IOSurface " | awk '{print "res="$3, "regions="$NF}'); [ -n "$s" ] && echo "$p $n $s"; done
   If any single process shows IOSurface resident > 1 GB, or keeps rising across checks,
   STOP browser/screenshot work. Report the numbers to the user and wait for instructions.
7. **When unattended,** finish the current step and stop rather than starting new
   screenshot-heavy work.
