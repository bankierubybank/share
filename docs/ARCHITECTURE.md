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
   └── else    → env.ASSETS (dist/, Vite build of web/) with SPA fallback
```

## Layout

| Path | What |
|------|------|
| `src/index.ts` | Worker entry, middleware, asset passthrough |
| `src/routes.ts` | API routes |
| `src/db.ts` | D1 queries (all parameterized) |
| `src/lib/money.ts` | Split + settlement math (pure, unit tested) |
| `src/lib/validate.ts` | Input validation (pure) |
| `src/lib/access.ts` | Cloudflare Access JWT verification (jose, JWKS) |
| `src/lib/ids.ts` | Random ids (base64url, 128-bit for groups) |
| `migrations/*.sql` | D1 schema migrations |
| `web/` | Frontend source (Vite root). `web/src/main.ts` app, `web/src/api.ts` client, `web/src/money.ts` formatting |
| `dist/` | Built assets (git-ignored) |
| `test/unit` | Pure logic (vitest, node) |
| `test/integration` | Worker + D1 in workerd (`@cloudflare/vitest-plugin`) |
| `test/system` | Full HTTP API flows vs running server (`TARGET_URL`) |
| `test/security` | Headers, injection, validation, auth, IDOR vs running server |
| `test/e2e` | Playwright UI flows (`fixtures.ts` attaches Access token to app origin only); projects = chromium, firefox, webkit, Pixel 7, iPhone 14 (compatibility) |
| `scripts/` | `test-local.sh`, `test-prod.sh`, `ship.sh` |

## Data model (D1 / SQLite)

- `groups(id PK, name, currency, created_at)`
- `members(id PK, group_id FK, name, created_at)` unique `(group_id, lower(name))`
- `bills(id PK, group_id FK, kind, description, amount, paid_by FK members, date, split_mode, created_at, updated_at)`
- `bill_shares(bill_id FK, member_id FK, amount)` PK `(bill_id, member_id)`

Shares are stored resolved (cents per member) so summary = simple aggregation.
Writes of bill + shares use `DB.batch()` (atomic).

## Security model

- Authentication/authorization: **Cloudflare Access** in front of the whole hostname. Inside the app,
  possession of the group link (128-bit random id) = access to that group (KittySplit model).
- Defense in depth: if `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` vars are set, Worker verifies
  `Cf-Access-Jwt-Assertion` (RS256 via team JWKS) on every request → 401 otherwise.
- Every member/bill lookup is scoped by `group_id` (no cross-group IDOR).
- Headers: strict CSP (self + Google Fonts), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`
  (group ids live in URLs), `X-Content-Type-Options: nosniff`, HSTS, Permissions-Policy.
- Writes require `Content-Type: application/json` (blocks simple-form CSRF), 32 KiB body cap.
- Frontend renders user text via `textContent` / Lit-free DOM building — no `innerHTML` with data.

## Decisions

- **Hono** for routing: tiny, Workers-native.
- **Material Web (`@material/web`)** = Google's official M3 web components; bundled with Vite.
- **Integer minor units** everywhere; formatting via `Intl.NumberFormat` per group currency.
- **No in-app accounts**: Access handles identity; keeps app simple.
- Worker name `share` → `https://share.bankierubybank.workers.dev` (the `xxx` in the brief).
