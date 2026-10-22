# Changelog

## 0.1.0 — 2026-10-22

### Added
- Worker API (Hono) on D1: groups, members, bills (equal / exact split, `payment` kind), summary
  with balances + minimal settlements. Contract in `docs/API.md`.
- Security: CSP + hardening headers on every response, `no-store` on API, JSON content-type gate
  (CSRF), 32 KiB body cap, group-scoped queries, optional Cloudflare Access JWT verification.
- Material 3 SPA (`@material/web`, Roboto, Material Symbols): create group, recent groups, bills list
  grouped by date, add/edit/delete bill dialog (full-screen on phones), summary with "Settle" →
  payment, people management, share link, group settings, light/dark theme.
- Test suites: unit, integration (vitest + `@cloudflare/vitest-plugin`), system, security, E2E +
  compatibility (Playwright: Chromium, WebKit, Pixel 7, iPhone 14; Firefox configured).
- Workflow scripts: `scripts/test-local.sh`, `scripts/test-prod.sh`, `scripts/ship.sh`.
- Docs: ARCHITECTURE, API, PLAN (task dispatch), ACCESS, PROGRESS, ISSUES, CLAUDE.md.

### Fixed (during build)
- Bill shares now returned in member display order (were in arbitrary DB order).
- Test target env var renamed `BASE_URL` → `TARGET_URL` (Vitest overwrites `BASE_URL` with `/`).
- Bills list "who shares" shown in member order; balance rows no longer wrap badly on phones.
