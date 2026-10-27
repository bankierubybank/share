# Progress

_Last updated: 2026-10-27_

## Status: v0.3.1 live at https://share.bankierubybank.workers.dev (behind Cloudflare Access), local + prod tests green

| Area | State |
|------|-------|
| Data model + D1 migration `0001_init` | ✅ |
| API (groups, members, bills, summary, payments) | ✅ |
| Split math (equal w/ remainder, exact) + greedy settlement | ✅ |
| Security headers, CSRF content-type gate, body cap, optional Access JWT | ✅ |
| Material 3 SPA: home, group (bills/summary/people), bill dialog, settle-up | ✅ |
| Responsive: phone tabs + full-screen dialog; laptop 2-column | ✅ |
| Tests: unit 148, integration 158, system 31, security 106 (+1 prod-only), E2E 46×4 browsers (184) | ✅ local 2026-10-27 (v0.3.1) |
| Firefox compat | ⚠️ browser won't launch on this host (ISSUES #1) |
| Deploy to prod (D1 `share-db` fc72d57c…, APAC; version 5bffded5) | ✅ 2026-10-23 |
| Prod tests via Access service token: system 31, security 107, E2E 92 (one slow-save timeout passed on rerun) (Chromium + iPhone) | ✅ 2026-10-27 (v0.3.1, version 80b4a21f) |
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

## v0.3 feature status (second round)

| # | Item | State |
|---|------|-------|
| 4 | Comments on a bill | ✅ |
| 6 | "Everyone except…" + saved subgroups | ✅ (quick picks) |
| 8 | Partial settle + settle-up history | ✅ |
| 10 | Move bill / merge groups | ✅ |
| 11 | Trip stats | ✅ |
| 12 | Read-only share link | ✅ (/v/<id>) |
| 14 | Thai language | ✅ |
| 16 | Swipe / long-press / pull-to-refresh | ✅ (+ Duplicate button) |
| 17 | Onboarding (sample data + tips) | ✅ |
| 18 | Smaller bundle (lazy chunks) | ✅ home JS −32% |

## Next ideas (backlog)
- Not picked yet (round-2 list): #1 live FX rates, #2 receipt scan (Workers AI), #3 budgets, #5 bill templates,
  #7 reminders (email/LINE), #9 import Splitwise/KittySplit, #13 PWA/offline, #15 live refresh, #19 in-Worker Access JWT,
  #20 rate limiting, #21 staging, #22 git remote + CI, #23 error tracking/uptime, #24 restore drill, #25 Firefox in matrix.
- Live exchange rates (needs an external FX source).
