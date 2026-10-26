# Changelog

## 0.3.0 — 2026-10-26 (deployed, version 0fc167c6)

Backlog picks #4, 6, 8, 10, 11, 12, 14, 16, 17, 18 (second round).

### Added
- **Comments on bills** (#4): thread per bill (500 chars, newlines kept), author = "View as" person or Access email,
  count shown in the bill list, activity entry.
- **Subgroups + quick picks** (#6): save "Couple", "Room 2"…; one tap in the equal split: Everyone / No one / subgroup.
- **Partial settle-up + history** (#8): Settle dialog has Full / Half and accepts any smaller amount (the rest stays
  in Who pays whom); Summary lists every payment ("Settle-up history").
- **Move a bill / merge groups** (#10): people matched by name (case-insensitive), missing people added on confirm,
  same currency required; merge moves all live bills, stops the source's repeating bills and archives it.
- **Trip stats** (#11): days, per day, per person per day, top payer, biggest bill, spend-per-day bars.
- **Read-only link** (#12): separate random view id (`/v/<id>`) — create / rotate / turn off in Group settings.
  View shows bills, balances, stats; never the edit id, PromptPay numbers, receipts, activity or who added what.
- **Thai / English** (#14): every UI string translated; switch on home and in the group menu; Thai by default for
  Thai browsers; dates and numbers formatted per language.
- **Gestures** (#16): swipe a bill left to delete (with Undo), long-press to duplicate, pull down to refresh; a
  Duplicate button covers the same for keyboard / screen-reader users.
- **Onboarding** (#17): "Try with sample data" on an empty home; dismissible quick tips on the first group visit.
- **Smaller bundle** (#18): group view, bill dialog, stats, export, move and sample are lazy chunks; group-only
  Material components moved out of the entry. Home JS 405 KB → 273 KB (gzip 92 → 62 KB).
- Migration `0003_social` (additive), API v3 (docs/API.md), backups include comments + subgroups.

### Fixed (found by tests / review)
- **Security:** merge logged the source group's id in the target's activity — anyone with the target link could
  learn the source's edit id. Now logged without an entity id (found by Sonnet's security suite).
- Comment length counted UTF-16 units (250 emoji max); now code points.
- Read-only view still showed the laptop "Add bill" button.
- Duplicate opened the new dialog while the old one was still closing (two dialogs on screen).
- Revoking a read-only link is allowed while the group is archived.

## 0.2.0 — 2026-10-26 (deployed, version f3e6d320)

Backlog items #1–15, 17, 20, 21, 23, 25 (see PROGRESS.md for the list).

### Added
- **Groups**: archive (read-only, server-enforced) / unarchive; delete group (type the name to confirm; removes receipts).
- **Splits**: shares (weights with stepper), percent (must total 100%), itemized bill (per-item people, service charge
  then VAT compounding), on top of equal / exact. Largest-remainder allocation, exact to the cent.
- **Multiple payers** per bill; **foreign currency** bills (amount + rate → group currency; last rate remembered).
- **Receipt photos** (R2, downscaled in browser to ≤1600 px JPEG, ≤2 MB, magic-byte checked, sandboxed when served).
- **Search & filter** bills (text, category, "only <person>"); **view as** a person (their position, their share per bill).
- **Categories** + "Spending by category" bar chart.
- **CSV export** (BOM, CRLF, formula-injection safe) and **Print / save as PDF** (print-only report).
- **Activity log** (who/what/when; actor from Cloudflare Access email) with **restore** of deleted bills;
  **Undo** snackbar after deleting (deletes are soft, purged after 30 days).
- **PromptPay QR** on Settle for THB groups (member PromptPay id; EMVCo payload with amount).
- **Repeating bills** (weekly / monthly, anchor day kept, backfills past dates) + daily scheduled run.
- **Quick add**: amount field first and focused; remembers last payer; "view as" person is the default payer.
- **Theme toggle** (system / light / dark), applied before first paint.
- **Accessibility**: skip link, landmarks/headings, labelled controls, focus rings, reduced-motion and forced-colors
  support; automated axe scans in E2E.
- **Self-hosted fonts & icons**: no Google Fonts; CSP now `'self'` only.
- **Nightly D1 → R2 backup** (`share-backups/backups/YYYY-MM-DD.json.gz`, 30 days) + `scripts/restore-backup.mjs`.
- API v2 (`docs/API.md`), migration `0002_features`, `scripts/verify-migration.sh`.
- Test suites: unit 97, integration 104, system 29, security 79 (+1 prod-only), E2E 31 per browser.
  Test helpers and the E2E fixture delete the groups they create (prod no longer accumulates test data).

### Fixed (found while building / by tests)
- Migration 0002 first draft **wiped `bill_shares`**: dropping `bills` cascades into children even with
  `defer_foreign_keys`. Now backs up and restores shares; verified by `verify-migration.sh` (local dev data affected only).
- Restore (Undo) POST had no body → 415 from the CSRF guard; client now sends `{}` (guard kept strict).
- Receipt responses lost their sandbox CSP (global header loop overwrote it).
- `activity?limit=2.7` → 500 (fraction in SQL LIMIT); now floored.
- Actor from Access headers was not validated (could echo markup); now strict email shape.
- Material buttons inside the bill form defaulted to `type=submit`: share steppers, "Several people paid",
  "Add item" etc. submitted the form. All set to `type=button` (also home "Add person").
- Payment dialog: the From select was moved into the hidden payers box → "paidBy must be a member".
- PromptPay QR didn't appear: `md-select.value` is empty until first render; previews refresh on open.
- Overflow menu stuck after first use (md-menu close animation computed `scale(Infinity)`); menu is `quick` now.
- E2E fixture routed `blob:` URLs (same origin) and broke downloads; routes only http(s) now.
- `md-outlined-select` 210 px min-width overflowed two-up rows on phones.

## 0.1.1 — 2026-10-26 (deployed, version 0461372b)

Found by exploratory prod test ("Phuket trip", iPhone + laptop).

### Fixed
- Summary `paid`/`owed` no longer include settle-up payments; payments affect `net` only (`src/lib/money.ts`).
  Before: after "Chai → Ann 212.62", Chai showed Paid 4,712.62 / Ann Share 5,325.25.
- Balance rows rebuilt as custom layout: amounts no longer cut off with "…" on phones.
- Laptop: "Add bill" moved into the Bills card header (FAB hidden ≥960px; overlapped People card).
- **Security**: Playwright sent the Access service token via `extraHTTPHeaders` to *all* hosts incl.
  fonts.googleapis.com / fonts.gstatic.com. Now attached per-origin in `test/e2e/fixtures.ts`.

### Added
- Unit tests for payments in balances; system test `test/system/payments.test.ts`;
  E2E: Paid/Share after settle + no clipping; "token never sent to third-party hosts".

## 0.1.0 deploy — 2026-10-23

### Deployed
- First prod deploy to `https://share.bankierubybank.workers.dev`; created D1 `share-db`
  (`fc72d57c-394e-4be1-b1b7-009f9c68fd4e`, APAC), id pinned in `wrangler.jsonc`; migration `0001_init` applied.
- Prod gate passed through Cloudflare Access service token (system, security incl. Access-block check, E2E).

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
