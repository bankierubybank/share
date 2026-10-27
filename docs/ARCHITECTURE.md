# Architecture

```
Browser (SPA, Material Web M3)
   │  HTTPS  share.bankierubybank.workers.dev
   ▼
Cloudflare Access  (configured manually by owner; service token for automated tests)
   ▼
   ├── everything but /api/* → static assets from the edge (dist/, SPA fallback; headers: web/public/_headers)
   ▼
Worker "share"  (src/index.ts, Hono)    run_worker_first = ["/api/*"], placement = smart (runs near D1)
   ├── middleware: security headers, identity (Access JWT verify → email / svc:<id>), body limit, content-type,
   │               Server-Timing (D1 round trips + time)
   ├── /api/*  → routes (src/routes.ts) → D1 (binding DB, database "share-db", APAC primary)
   │                                     → R2 RECEIPTS ("share-receipts": receipt photos)
   └── scheduled (daily 00:17 UTC) → backup D1 → R2 BACKUPS ("share-backups"),
                                    materialize recurring bills, purge 30-day-old soft deletes
                                    (independent steps: one failing doesn't skip the others)
```

## Layout

| Path | What |
|------|------|
| `src/index.ts` | Worker entry, middleware, asset passthrough |
| `src/routes.ts` | API routes |
| `src/db.ts` | D1 queries (all parameterized) |
| `src/lib/money.ts` | Equal split, balances (multi-payer, payments), settlement (pure) |
| `src/lib/split.ts` | Largest-remainder allocation (shares/percent), itemized + service/VAT, fx conversion (BigInt) |
| `src/lib/identity.ts` | Verified identity (JWT email / `svc:<id>`), dev header identity, display label |
| `src/lib/summary.ts` | Trip summary (balances, settlements, totals) — shared by the Worker and the optimistic UI |
| `src/lib/dbtiming.ts` | Per-request D1 round-trip counter/timer (Server-Timing, slow-request log) |
| `src/lib/promptpay-id.ts` | PromptPay id normalization (shared with web) |
| `src/routes-social.ts`, `src/db-social.ts`, `src/lib/social.ts` | Comments, subgroups, read-only view links, move/merge |
| `src/lib/body.ts` | `readLimited()` — size-capped body reads (also for chunked uploads) |
| `src/backup.ts` | Nightly D1 → R2 gzip JSON backup + 30-day retention |
| `src/lib/validate.ts` | Input validation (pure) |
| `src/lib/access.ts` | Cloudflare Access JWT verification (jose, JWKS) |
| `src/lib/ids.ts` | Random ids (base64url, 128-bit for groups) |
| `migrations/*.sql` | D1 schema migrations |
| `web/` | Frontend source (Vite root). `main.ts` app, `api.ts` client, `money.ts` formatting, `icons.ts` (bundled SVG Material Symbols), `theme.ts`, `promptpay.ts` (QR), `export.ts` (CSV), `image.ts` (receipt downscale), `views/` |
| `web/src/views/` | `home.ts`, `group.ts` (also read-only `/v/` mode), `bill-dialog.ts`, `stats.ts`, `move.ts` |
| `web/src/` (others) | `i18n.ts` (TH/EN), `gestures.ts` (swipe/long-press/pull), `sample.ts` (onboarding), `categories.ts`, `dialogs.ts`, `dom.ts` (`h()`), `router.ts`, `store.ts` (recent groups) |
| `web/public/theme.js` | Tiny blocking script: applies saved light/dark before first paint |
| `web/public/_headers` | Security headers (CSP etc.) + immutable caching for static assets (the Worker no longer serves them) |
| `.github/workflows/` | CI (local gate) + deploy (backup → deploy → prod tests → rollback) — draft, see `docs/CI.md` |
| `dist/` | Built assets (git-ignored) |
| `test/unit` | Pure logic (vitest, node) |
| `test/integration` | Worker + D1 in workerd (`@cloudflare/vitest-plugin`) |
| `test/system` | Full HTTP API flows vs running server (`TARGET_URL`) |
| `test/security` | Headers, injection, validation, auth, IDOR vs running server |
| `test/e2e` | Playwright UI flows (`fixtures.ts` attaches Access token to app origin only); projects = chromium, firefox, webkit, Pixel 7, iPhone 14 (compatibility) |
| `scripts/` | `test-local.sh`, `test-prod.sh`, `ship.sh`, `verify-migration.sh` (+ `migration-seed.sql`), `restore-backup.mjs` |

## Data model (D1 / SQLite)

- `groups(id PK, name, currency, archived_at, created_at)`
- `members(id PK, group_id FK, name, promptpay, email, position, created_at)` unique `(group_id, lower(name))`,
  unique `(group_id, email)` where set; index on `email` (my trips). `email` = linked identity (0004).
- `bills(id PK, group_id FK, kind, description, amount, paid_by FK (first payer), date, split_mode, split_json,
  category, original_currency, original_amount, fx_rate, receipt_key, recurrence_id, created_by, deleted_at, created_at, updated_at)`
- `bill_shares(bill_id FK, member_id FK, amount)` PK `(bill_id, member_id)` — who owes what (resolved cents)
- `bill_payers(bill_id FK, member_id FK, amount)` PK `(bill_id, member_id)` — who paid what
- `activity(id, group_id FK, at, actor, action, entity_id, detail JSON)`
- `recurrences(id, group_id FK, frequency, anchor_day, next_date, template JSON, active, last_error, created_by)`
- `bill_comments(id, bill_id FK cascade, group_id FK, author_member_id FK set null, actor, body, created_at)`
- `subgroups(id, group_id FK, name, member_ids JSON)`
- `groups.view_id` (unique, nullable): read-only link id, separate from the edit id

Shares and payers are stored resolved (cents per member), so the summary is a simple aggregation; `split_json`
keeps the user's input (weights / percents / items) for editing. Writes of a bill + its children + activity
row use `DB.batch()` (atomic). Deletes are soft (`deleted_at`), purged after 30 days.

**Migrations that rebuild a table** (0002): dropping a parent table fires `ON DELETE CASCADE` into children
even with `PRAGMA defer_foreign_keys` — back the children up and restore them (see 0002). Always run
`bash scripts/verify-migration.sh` before applying such a migration remotely, and export prod first
(`npx wrangler d1 export share-db --remote --output backup-before-XXXX.sql`).

## Performance (v0.5)

Prod D1 has one primary (APAC, no read replicas); each round trip from the Worker costs tens of ms and write
batches far more (ISSUES #28). Rules:

- **Count round trips, not statements.** Every `/api/*` response has `Server-Timing: db;dur=<ms>;desc="<n> round
  trips", app;dur=<ms>` (`src/lib/dbtiming.ts` wraps the binding per request); requests over 800 ms log
  `slow request` (route shape only — ids are secrets) to Workers Logs. `test/integration/perf.test.ts` pins budgets.
- **A write reads its result back in the same `batch()`** (create/update bill, restore, create group, comment):
  the batch runs sequentially in one transaction, so the trailing SELECTs see the new rows.
- **Validation reads go in one batch** (`billWriteContext`: member ids + bill count + exists).
- **Activity rows that need the bill are `INSERT … SELECT json_object(…) FROM bills … AND changes() > 0`**, so
  delete/restore need no read first and log nothing when the update changed nothing.
- **The trip page is one request**, `GET /api/groups/:gid/full` (one batch of 8 SELECTs) instead of five.
- Budget per route (incl. the access check): add / edit bill ≤ 3, delete / restore ≤ 2, page ≤ 3, create trip 1.
- **Smart Placement** runs the Worker near D1; only `/api/*` runs the Worker (`run_worker_first`), so pages and
  bundles still come from the edge closest to the user.
- **Optimistic UI** (web): bill add/edit/delete show immediately (row marked "Saving…", totals recomputed with
  `src/lib/summary.ts` — the Worker's own code); the server answer replaces it, a failure rolls back with an
  "Edit" action that reopens what was typed. Recurring bills, moves, people and settings still wait for the server.
- Avoid per-item query loops (see `createOccurrences`).

## Security model

- Authentication: **Cloudflare Access** in front of the whole hostname, and the Worker verifies
  `Cf-Access-Jwt-Assertion` (RS256 via team JWKS; `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` in `wrangler.jsonc`) on every
  API request → 401 otherwise. Identity = JWT `email`, or `svc:<common_name>` for service tokens (`src/lib/identity.ts`).
  Headers like `Cf-Access-Authenticated-User-Email` are **never** trusted on prod; only with `DEV_IDENTITY=1`
  (local `wrangler dev --var`, integration config). Neither configured → identity null → trip routes 401 (fail closed).
- Authorization (v0.4): a trip is visible only to identities linked to one of its people (`members.email`).
  The group middleware does one query (`getGroupAccess`: group + my member id + "anyone linked?") per request.
  Pre-0.4 trips (nobody linked) are claimed by their first visitor (`POST …/me`, guarded against a race), after
  which they're locked too. The 22-char group id stays unguessable, but is no longer sufficient by itself.
  Move/merge check membership in both trips (404 otherwise). The last link can't be removed (no orphaned trips).
- Every member/bill lookup is scoped by `group_id` (no cross-group IDOR).
- Headers: strict CSP (`'self'` only — fonts/icons self-hosted, no third parties), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`
  (group ids live in URLs), `X-Content-Type-Options: nosniff`, HSTS, Permissions-Policy. Set by the Worker on
  `/api/*` and by `web/public/_headers` on static assets (since v0.5 the Worker doesn't serve them) — keep both in sync.
  Static assets are behind Access too, but no longer pass the in-Worker JWT check (they hold no data).
- Writes require `Content-Type: application/json` (blocks simple-form CSRF), 32 KiB body cap — even bodyless
  POSTs (restore) send `{}`. Receipt upload is the one exception: `image/jpeg|png|webp`, ≤ 2 MiB, magic-byte
  sniffed, served back with its own `Content-Security-Policy: default-src 'none'; sandbox` (not overwritten).
- Archived groups are read-only server-side (409 `archived`) — except revoking a read-only link.
- Read-only links: `GET /api/view/:viewId` is the only route keyed by the view id; it returns a trimmed snapshot
  without the group id (the edit secret), PromptPay ids, receipts, activity or actors. Rotating issues a new id.
- Never log another group's id anywhere readable (activity of the target after a merge logs only the name).
- Activity `actor` = the verified identity (service tokens shown as "service token"). Member emails are visible to
  people in the same trip only — never in view links, and never written into activity details.
- Frontend renders user text via `textContent` / Lit-free DOM building — no `innerHTML` with data.

## Decisions

- **Hono** for routing: tiny, Workers-native.
- **Material Web (`@material/web`)** = Google's official M3 web components; bundled with Vite.
  Icons: `@material-symbols/svg-400` per-icon SVGs (tree-shaken, ~0.5 KB each) instead of the 3+ MB icon font.
  Font: `@fontsource/roboto` (latin 400/500/700, ~66 KB), Thai falls back to system fonts.
- **Lazy chunks**: `main.ts` routes import `views/group` on demand; group view lazy-imports the bill dialog,
  stats, export, move. Group-only Material components are imported by `views/group.ts`, not `main.ts`.
- **i18n**: `web/src/i18n.ts` (`t()`, en + th dictionaries, th typed against en keys); Intl uses `locale()`.
- **Shared validation**: the bill dialog imports `src/lib/validate.ts` so its live preview equals the server result.
- `md-menu` uses `quick` (no animation): its close animation hung (scale(Infinity)) and the menu couldn't reopen.
- **Integer minor units** everywhere; formatting via `Intl.NumberFormat` per group currency.
- **No in-app accounts**: Access handles identity; a person in a trip is "linked" by putting their Access email on
  them (or by them claiming it). No invites/requests flow — someone in the trip adds your email.
- Worker name `share` → `https://share.bankierubybank.workers.dev` (the `xxx` in the brief).
