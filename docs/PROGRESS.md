# Progress

_Last updated: 2026-10-27_

## Status: v0.5.0 (faster saves, fewer D1 round trips) live at https://share.bankierubybank.workers.dev (behind Cloudflare Access, version ab697568)

Local 2026-10-27 (0.5.0): unit 157, integration 175, system 32, security 110 (+2 prod-only), E2E 53×4 (212) — green.

| Area | State |
|------|-------|
| Data model + D1 migration `0001_init` | ✅ |
| API (groups, members, bills, summary, payments) | ✅ |
| Split math (equal w/ remainder, exact) + greedy settlement | ✅ |
| Security headers, CSRF content-type gate, body cap, in-Worker Access JWT (identity) | ✅ |
| Trip membership: only linked people (member email = Access login) see a trip; my-trips list; claim pre-0.4 trips | ✅ v0.4.0 |
| Material 3 SPA: home, group (bills/summary/people), bill dialog, settle-up | ✅ |
| Responsive: phone tabs + full-screen dialog; laptop 2-column | ✅ |
| Tests: unit 153, integration 168, system 32, security 110 (+2 prod-only), E2E 48×4 browsers (192) | ✅ local 2026-10-27 (v0.4.0) |
| Firefox compat | ⚠️ browser won't launch on this host (ISSUES #1) |
| Deploy to prod (D1 `share-db` fc72d57c…, APAC; version 5bffded5) | ✅ 2026-10-23 |
| Prod tests via Access service token: system 32, security 108 (+4 local-only), E2E 92 (Chromium + iPhone) | ✅ 2026-10-27 (v0.4.0, version f8bfa8f1) |
| R2 buckets `share-receipts`, `share-backups`; daily scheduled job 00:17 UTC | ✅ |
| Demo trip "Phuket trip" on prod (link kept out of the repo: ids are secrets) | ✅ |
| Access gate: unauthenticated → 302 to bankierubybank.cloudflareaccess.com | ✅ |
| In-Worker Access JWT check (`ACCESS_TEAM_DOMAIN`/`ACCESS_AUD`) | ✅ v0.4.0 (required for membership) |
| Remote git | ⏳ owner to configure |

## Pending on owner
- **Open "Phuket trip" and pick who you are** (v0.4: pre-0.4 trips are unclaimed; first visitor claims, then only
  linked people can open it). "Khao Sok" was claimed 2026-10-27 as "Bank". Then add the others' emails under People.
- Stop the orphaned `wrangler dev` on :8787 (ISSUES #31).
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

## v0.5 status (round 3 picks)

| # | Item | State |
|---|------|-------|
| 15 | D1 write latency: fewer round trips, one-request trip page, Smart Placement, Server-Timing | ✅ |
| 13 | Faster saves: optimistic bill add/edit/delete with rollback | ✅ |
| 18 | Git remote + CI | 📝 drafted (`.github/workflows/`, `docs/CI.md`); needs owner: GitHub repo + secrets |

## Next ideas (backlog)
- Round 3, not picked: #1 invite link / join request, #2 email autocomplete, #3 per-person balance on home,
  #4 "my spending" across trips, #5 live FX, #6 receipt scan (Workers AI), #7 budgets, #8 bill templates,
  #9 reminders, #10 import Splitwise/KittySplit, #11 PWA/offline, #12 live refresh, #14 leave trip,
  #16 rate limiting, #17 staging env, #19 error tracking/uptime, #20 restore drill, #21 Firefox in matrix.
- If writes are still slow after 0.5: D1 read replication (Sessions API) only helps reads; next step would be a
  Durable Object per trip (writes local to the object).
