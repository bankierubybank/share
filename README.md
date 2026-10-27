# Share

Split bills with friends — Splitwise / KittySplit style. Cloudflare Workers + D1 + R2, Material Design 3 UI
(Google's `@material/web`), Thai / English, works on phones and laptops.

Live: https://share.bankierubybank.workers.dev (behind Cloudflare Access).

## Features

- **Groups**: create, share the link, archive (read-only) or delete; merge two groups; read-only view links (`/v/<id>`).
- **Bills**: split equally, by exact amounts, by shares, by percent, or itemized (service charge + VAT);
  several payers; foreign currency with a rate; categories; receipt photos; comments; repeating weekly / monthly;
  move a bill to another group; duplicate.
- **Summary**: balances, the fewest "who pays whom" payments, Settle (full / partial, PromptPay QR for THB),
  settle-up history, spending by category, trip stats.
- **History**: activity log (who / what / when) with restore; Undo after delete (soft delete, 30-day purge).
- **Phone-friendly**: quick add (amount first), "View as" a person, search / filter, swipe to delete,
  long-press to duplicate, pull to refresh, light / dark theme, onboarding sample trip.
- **Ops**: nightly D1 → R2 backup with restore script; security headers / strict CSP; no third-party requests.

## Run locally

```bash
npm install
npm run db:migrate:local
npm run dev            # http://localhost:8787
```

## Test

| Command | What |
|---------|------|
| `npm run typecheck` | Worker + web TypeScript |
| `npm run test:unit` | Money / split / validation / i18n / CSV / PromptPay logic |
| `npm run test:integration` | Worker + D1 + R2 inside workerd |
| `npm run test:system` | API flows over HTTP (`TARGET_URL`, default `http://localhost:8787`) |
| `npm run test:security` | Headers, CSRF, injection, XSS, IDOR, limits, receipts, view links, Access |
| `npm run test:e2e` | Playwright UI flows (Chromium) |
| `npm run test:compat` | E2E on every project (Firefox currently can't launch on the dev Mac — see ISSUES #1) |
| `npm run test:local` | All of the above vs local `wrangler dev` (Chromium, WebKit, Pixel 7, iPhone 14) |
| `npm run test:prod` | System + security + E2E vs prod through Access (needs `.env.test`) |
| `npm run db:verify` | Apply migrations one by one on a seeded throwaway DB and check data survives |

## Deploy

`npm run deploy` (build → remote D1 migrations → `wrangler deploy`). Standard workflow (`npm run ship`) and
conventions: `CLAUDE.md`. Access + service-token setup: `docs/ACCESS.md`. Restore from a backup:
`scripts/restore-backup.mjs`.

Docs: [architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [plan & dispatch](docs/PLAN.md) ·
[progress](docs/PROGRESS.md) · [changelog](docs/CHANGELOG.md) · [issues](docs/ISSUES.md) · [access](docs/ACCESS.md)
