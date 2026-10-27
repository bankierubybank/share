# Architecture

```
Browser (SPA, Material Web M3)
   │  HTTPS  share.bankierubybank.workers.dev
   ▼
Cloudflare Access  (configured manually by owner; service token for automated tests)
   ▼
Worker "share"  (src/index.ts, Hono)          run_worker_first = true
   ├── middleware: security headers, identity (Access JWT verify → email / svc:<id>), body limit, content-type
   ├── /api/*  → routes (src/routes.ts) → D1 (binding DB, database "share-db")
   │                                     → R2 RECEIPTS ("share-receipts": receipt photos)
   ├── else    → env.ASSETS (dist/, Vite build of web/) with SPA fallback
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
| `src/lib/actor.ts` | "Who did it" from Access headers (display only, sanitized) |
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

**Latency budget**: on prod every D1 round trip is ~100–200 ms (writes in batches can spike higher), so handlers
should batch statements and avoid per-item query loops (see `createOccurrences`).

Shares and payers are stored resolved (cents per member), so the summary is a simple aggregation; `split_json`
keeps the user's input (weights / percents / items) for editing. Writes of a bill + its children + activity
row use `DB.batch()` (atomic). Deletes are soft (`deleted_at`), purged after 30 days.

**Migrations that rebuild a table** (0002): dropping a parent table fires `ON DELETE CASCADE` into children
even with `PRAGMA defer_foreign_keys` — back the children up and restore them (see 0002). Always run
`bash scripts/verify-migration.sh` before applying such a migration remotely, and export prod first
(`npx wrangler d1 export share-db --remote --output backup-before-XXXX.sql`).

## Security model

- Authentication: **Cloudflare Access** in front of the whole hostname, and the Worker verifies
  `Cf-Access-Jwt-Assertion` (RS256 via team JWKS; `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` in `wrangler.jsonc`) on every
  request → 401 otherwise. Identity = JWT `email`, or `svc:<common_name>` for service tokens (`src/lib/identity.ts`).
  Headers like `Cf-Access-Authenticated-User-Email` are **never** trusted on prod; only with `DEV_IDENTITY=1`
  (local `wrangler dev --var`, integration config). Neither configured → identity null → trip routes 401 (fail closed).
- Authorization (v0.4): a trip is visible only to identities linked to one of its people (`members.email`).
  The group middleware does one query (`getGroupAccess`: group + my member id + "anyone linked?") per request.
  Pre-0.4 trips (nobody linked) are claimed by their first visitor (`POST …/me`, guarded against a race), after
  which they're locked too. The 22-char group id stays unguessable, but is no longer sufficient by itself.
  Move/merge check membership in both trips (404 otherwise). The last link can't be removed (no orphaned trips).
- Every member/bill lookup is scoped by `group_id` (no cross-group IDOR).
- Headers: strict CSP (`'self'` only — fonts/icons self-hosted, no third parties), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`
  (group ids live in URLs), `X-Content-Type-Options: nosniff`, HSTS, Permissions-Policy.
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
