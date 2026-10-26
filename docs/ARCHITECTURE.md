# Architecture

```
Browser (SPA, Material Web M3)
   │  HTTPS  share.bankierubybank.workers.dev
   ▼
Cloudflare Access  (configured manually by owner; service token for automated tests)
   ▼
Worker "share"  (src/index.ts, Hono)          run_worker_first = true
   ├── middleware: security headers, Access JWT verify (optional), body limit, content-type
   ├── /api/*  → routes (src/routes.ts) → D1 (binding DB, database "share-db")
   │                                     → R2 RECEIPTS ("share-receipts": receipt photos)
   ├── else    → env.ASSETS (dist/, Vite build of web/) with SPA fallback
   └── scheduled (daily 00:17 UTC) → backup D1 → R2 BACKUPS ("share-backups"),
                                    materialize recurring bills, purge 30-day-old soft deletes
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
| `src/backup.ts` | Nightly D1 → R2 gzip JSON backup + 30-day retention |
| `src/lib/validate.ts` | Input validation (pure) |
| `src/lib/access.ts` | Cloudflare Access JWT verification (jose, JWKS) |
| `src/lib/ids.ts` | Random ids (base64url, 128-bit for groups) |
| `migrations/*.sql` | D1 schema migrations |
| `web/` | Frontend source (Vite root). `main.ts` app, `api.ts` client, `money.ts` formatting, `icons.ts` (bundled SVG Material Symbols), `theme.ts`, `promptpay.ts` (QR), `export.ts` (CSV), `image.ts` (receipt downscale), `views/` |
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
- `members(id PK, group_id FK, name, promptpay, position, created_at)` unique `(group_id, lower(name))`
- `bills(id PK, group_id FK, kind, description, amount, paid_by FK (first payer), date, split_mode, split_json,
  category, original_currency, original_amount, fx_rate, receipt_key, recurrence_id, created_by, deleted_at, created_at, updated_at)`
- `bill_shares(bill_id FK, member_id FK, amount)` PK `(bill_id, member_id)` — who owes what (resolved cents)
- `bill_payers(bill_id FK, member_id FK, amount)` PK `(bill_id, member_id)` — who paid what
- `activity(id, group_id FK, at, actor, action, entity_id, detail JSON)`
- `recurrences(id, group_id FK, frequency, anchor_day, next_date, template JSON, active, last_error, created_by)`

Shares and payers are stored resolved (cents per member), so the summary is a simple aggregation; `split_json`
keeps the user's input (weights / percents / items) for editing. Writes of a bill + its children + activity
row use `DB.batch()` (atomic). Deletes are soft (`deleted_at`), purged after 30 days.

**Migrations that rebuild a table** (0002): dropping a parent table fires `ON DELETE CASCADE` into children
even with `PRAGMA defer_foreign_keys` — back the children up and restore them (see 0002). Always run
`bash scripts/verify-migration.sh` before applying such a migration remotely, and export prod first
(`npx wrangler d1 export share-db --remote --output backup-before-XXXX.sql`).

## Security model

- Authentication/authorization: **Cloudflare Access** in front of the whole hostname. Inside the app,
  possession of the group link (128-bit random id) = access to that group (KittySplit model).
- Defense in depth: if `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` vars are set, Worker verifies
  `Cf-Access-Jwt-Assertion` (RS256 via team JWKS) on every request → 401 otherwise.
- Every member/bill lookup is scoped by `group_id` (no cross-group IDOR).
- Headers: strict CSP (`'self'` only — fonts/icons self-hosted, no third parties), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`
  (group ids live in URLs), `X-Content-Type-Options: nosniff`, HSTS, Permissions-Policy.
- Writes require `Content-Type: application/json` (blocks simple-form CSRF), 32 KiB body cap — even bodyless
  POSTs (restore) send `{}`. Receipt upload is the one exception: `image/jpeg|png|webp`, ≤ 2 MiB, magic-byte
  sniffed, served back with its own `Content-Security-Policy: default-src 'none'; sandbox` (not overwritten).
- Archived groups are read-only server-side (409 `archived`).
- Activity `actor` comes from Access headers, validated as an email shape; it is display data, not auth.
- Frontend renders user text via `textContent` / Lit-free DOM building — no `innerHTML` with data.

## Decisions

- **Hono** for routing: tiny, Workers-native.
- **Material Web (`@material/web`)** = Google's official M3 web components; bundled with Vite.
  Icons: `@material-symbols/svg-400` per-icon SVGs (tree-shaken, ~0.5 KB each) instead of the 3+ MB icon font.
  Font: `@fontsource/roboto` (latin 400/500/700, ~66 KB), Thai falls back to system fonts.
- **Shared validation**: the bill dialog imports `src/lib/validate.ts` so its live preview equals the server result.
- `md-menu` uses `quick` (no animation): its close animation hung (scale(Infinity)) and the menu couldn't reopen.
- **Integer minor units** everywhere; formatting via `Intl.NumberFormat` per group currency.
- **No in-app accounts**: Access handles identity; keeps app simple.
- Worker name `share` → `https://share.bankierubybank.workers.dev` (the `xxx` in the brief).
