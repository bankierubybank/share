# Share

Split bills with friends — Splitwise / KittySplit style. Cloudflare Workers + D1, Material Design 3 UI
(Google's `@material/web`), works on phones and laptops.

- Create a group, add people, share the link.
- Add bills: who paid, who shares (equal split or exact amounts).
- Summary: balances and the minimal "who pays whom" list; one tap to record a settlement.

## Run locally

```bash
npm install
npm run db:migrate:local
npm run dev            # http://localhost:8787
```

## Test

| Command | What |
|---------|------|
| `npm run test:unit` | Money/split/settlement + validation logic |
| `npm run test:integration` | Worker + D1 inside workerd |
| `npm run test:system` | API flows over HTTP (`TARGET_URL`) |
| `npm run test:security` | Headers, CSRF, injection, XSS, IDOR, limits, Access |
| `npm run test:e2e` | Playwright UI flows (Chromium) |
| `npm run test:compat` | E2E on Chromium, Firefox, WebKit, Pixel 7, iPhone 14 |
| `npm run test:local` | Everything above vs local `wrangler dev` |
| `npm run test:prod` | System + security + E2E vs prod (needs `.env.test`) |

## Deploy

`npm run deploy` — see `docs/ACCESS.md` for Cloudflare Access + service token setup, `CLAUDE.md` for the
standard workflow (`npm run ship`).

Docs: [architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [plan](docs/PLAN.md) ·
[progress](docs/PROGRESS.md) · [changelog](docs/CHANGELOG.md) · [issues](docs/ISSUES.md)
