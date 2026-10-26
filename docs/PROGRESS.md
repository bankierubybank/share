# Progress

_Last updated: 2026-10-26_

## Status: v0.2.0 live at https://share.bankierubybank.workers.dev (behind Cloudflare Access), local + prod tests green

| Area | State |
|------|-------|
| Data model + D1 migration `0001_init` | ✅ |
| API (groups, members, bills, summary, payments) | ✅ |
| Split math (equal w/ remainder, exact) + greedy settlement | ✅ |
| Security headers, CSRF content-type gate, body cap, optional Access JWT | ✅ |
| Material 3 SPA: home, group (bills/summary/people), bill dialog, settle-up | ✅ |
| Responsive: phone tabs + full-screen dialog; laptop 2-column | ✅ |
| Tests: unit 97, integration 104, system 29, security 79 (+1 prod-only), E2E 31×4 browsers (124) | ✅ local 2026-10-26 |
| Firefox compat | ⚠️ browser won't launch on this host (ISSUES #1) |
| Deploy to prod (D1 `share-db` fc72d57c…, APAC; version 5bffded5) | ✅ 2026-10-23 |
| Prod tests via Access service token: system 29, security 80, E2E 62 (Chromium + iPhone) | ✅ 2026-10-26 (v0.2.0, version f3e6d320) |
| R2 buckets `share-receipts`, `share-backups`; daily scheduled job 00:17 UTC | ✅ |
| Demo trip "Phuket trip" on prod: /g/bT3gqiknUCsOAW1r_2za5A | ✅ |
| Access gate: unauthenticated → 302 to bankierubybank.cloudflareaccess.com | ✅ |
| In-Worker Access JWT check (`ACCESS_TEAM_DOMAIN`/`ACCESS_AUD`) | ⏳ optional, not enabled |
| Remote git | ⏳ owner to configure |

## Pending on owner
- **Rotate Access service token `share-tests`** (ISSUES #9). Old token was sent to Google Fonts hosts
  by the E2E setup (fixed in 0.1.1). Low risk; deferred by owner. After rotating: update `.env.test`,
  run `npm run test:prod` to confirm, then mark #9 closed.
- Configure git remote (then push).
## v0.2 feature status (backlog picks)

| # | Item | State |
|---|------|-------|
| 1 | Delete / archive group | ✅ |
| 2 | Split by shares / percent | ✅ |
| 3 | Multiple payers | ✅ |
| 4 | Itemized bill + service/VAT | ✅ |
| 5 | Multi-currency bills | ✅ (manual rate; last rate remembered) |
| 6 | Receipt photos (R2) | ✅ |
| 7 | Search / filter bills | ✅ |
| 8 | Per-person view | ✅ ("View as") |
| 9 | Categories + chart | ✅ |
| 10 | CSV / PDF export | ✅ (PDF via print) |
| 11 | Activity log | ✅ |
| 12 | Undo delete | ✅ (soft delete, 30-day purge) |
| 13 | PromptPay QR | ✅ (THB groups) |
| 14 | Recurring bills | ✅ (weekly/monthly; daily scheduled run + lazy) |
| 15 | Access identity on activity | ✅ (display only) |
| 17 | Quick add | ✅ |
| 20 | Theme toggle | ✅ |
| 21 | Accessibility pass | ✅ (axe: no serious/critical) |
| 23 | Self-host fonts | ✅ (+ SVG icons; CSP self-only) |
| 25 | Nightly D1 backup to R2 | ✅ (+ restore script) |

## Next ideas (backlog)
- Not picked yet: #16 PWA/offline, #18 Thai i18n, #19 live refresh, #22 in-Worker Access JWT, #24 rate limiting,
  #26 staging environment, #27 git remote + CI.
- Live exchange rates (needs an external FX source).
