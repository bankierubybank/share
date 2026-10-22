# Progress

_Last updated: 2026-10-22_

## Status: v0.1.0 built + locally green; NOT yet deployed (blocked, see ISSUES #2)

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
| Deploy to prod | ⛔ Cloudflare auth (ISSUES #2) |
| Prod tests via Access service token | ⏳ needs `.env.test` + deploy |
| Remote git | ⏳ owner to configure |

## Next ideas (backlog)
- Delete group / archive; cleanup of test groups created by prod tests (ISSUES #3).
- Percentage / shares-based splits; multiple payers per bill.
- Receipt photo upload (R2); CSV export; currency conversion.
- Offline/PWA caching (service worker).
