# Progress

_Last updated: 2026-10-23_

## Status: v0.1.0 live at https://share.bankierubybank.workers.dev (behind Cloudflare Access), local + prod tests green

| Area | State |
|------|-------|
| Data model + D1 migration `0001_init` | ✅ |
| API (groups, members, bills, summary, payments) | ✅ |
| Split math (equal w/ remainder, exact) + greedy settlement | ✅ |
| Security headers, CSRF content-type gate, body cap, optional Access JWT | ✅ |
| Material 3 SPA: home, group (bills/summary/people), bill dialog, settle-up | ✅ |
| Responsive: phone tabs + full-screen dialog; laptop 2-column | ✅ |
| Tests: unit 30, integration 25, system 20, security 48 (+1 prod-only), E2E 9×4 browsers | ✅ local |
| Firefox compat | ⚠️ browser won't launch on this host (ISSUES #1) |
| Deploy to prod (D1 `share-db` fc72d57c…, APAC; version 5bffded5) | ✅ 2026-10-23 |
| Prod tests via Access service token: system 20, security 49, E2E 18 | ✅ |
| Access gate: unauthenticated → 302 to bankierubybank.cloudflareaccess.com | ✅ |
| In-Worker Access JWT check (`ACCESS_TEAM_DOMAIN`/`ACCESS_AUD`) | ⏳ optional, not enabled |
| Remote git | ⏳ owner to configure |

## Next ideas (backlog)
- Delete group / archive; cleanup of test groups created by prod tests (ISSUES #3).
- Percentage / shares-based splits; multiple payers per bill.
- Receipt photo upload (R2); CSV export; currency conversion.
- Offline/PWA caching (service worker).
