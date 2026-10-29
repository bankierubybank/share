# Changelog

## 0.8.0 — 2026-10-29

Owner picks from the backlog: #3, #4, #11 (PWA), #12, #22, #24 ("#1" was already done in 0.6 — skipped).

### Home: where I stand everywhere (#3) + my spending (#4)
- Each trip on home shows **You get ฿2,900.00 / You owe ¥1,800 / Settled**, in that trip's currency.
- **My spending** card: my share of expenses per month (this month first, ≤6 months), one line per month with each
  currency side by side (never added across currencies). Payments between friends don't count as spending.
- New `GET /api/me/overview` — SQL aggregation in one batch; matches each trip's own summary to the cent.
- On a new device (nothing cached) the trips move above the new-trip form once the server answers — unless you've
  started typing in the form.

### Live refresh (#12)
- An open trip polls a tiny `GET …/version` token every 15 s (and when you come back to the tab) and reloads when
  someone else changed something: "Updated with changes from others". Waits while a dialog is open or a save is
  pending. `/full` returns the token too, so your own saves never trigger a reload.

### Mark as paid (#22)
- Settle opens a payment whose main button reads **Mark as paid**; with a PromptPay QR it says to scan, pay, then
  tap it.

### Currency default (#24)
- A new trip defaults to the currency of your last trip; else **THB** if the app or browser language is Thai or the
  clock is Asia/Bangkok (an English browser on a Thai phone got USD before); else the browser region's currency.

### Installable app (#11)
- Manifest with PNG + maskable icons, Apple touch icon, a minimal service worker (bundles cache-first only), and an
  **Install app** button on home where the browser offers it. iOS: Share → Add to Home Screen.

## 0.7.0 — 2026-10-28

UI/UX review + revamp (owner: "review ui/ux — feel free to revamp").

### Review findings (before)
- The trip page never said where *you* stand: your balance and who you pay were only on Summary, and only after
  picking yourself in "View as" — although the app already knows who you are (v0.4).
- On a phone the first bill sat at the bottom of the first screen: a 4-bullet tips card and a lone "View as" box
  came first. On laptops the right column (summary, stats, people, activity) ran ~3× longer than the bills.
- "THB 17,430.00" everywhere; home said "group" while the rest said "trip"; returning users saw the create form
  before their trips; three people in a row read "No email — can't open this trip"; a fresh Add bill opened with
  a red "Enter an amount".

### Changed
- **Trip header** on every tab: "You get back ฿4,860.00" / "You owe …" / "You're all settled up", what you paid vs
  your share, one row per payment involving you ("Fern pays you ฿3,580.00", "Pay Ploy ฿1,280.00") with **Settle**,
  and trip total · bills · people. "View as" moved into it (the header then shows that person).
- **Tips** are one slim line (tap to expand), so bills start on the first screen.
- **Laptop layout**: two columns — bills + activity | summary + people.
- **Money** uses the narrow symbol for the trip's currency (฿, $, €); foreign amounts on fx bills keep the code
  (`USD 30.00 @ 36.25`) because narrow symbols are ambiguous.
- **Home**: your trips first when you have some (shorter hero); copy says "trip" throughout (EN + TH).
- People without a linked account show "Not joined yet" (the invite link sits right below).
- Add bill: no red error until something invalid was typed.
- Rounder cards, bolder amounts.

### Fixed
- Service tokens (test automation) now skip the API rate limit too unless a test opts in: the prod security suite
  outgrew 600 requests/min and its first 0.7 run failed with 429s (ISSUES #40). People are limited as before.

## 0.6.0 — 2026-10-28

Owner picks from round 3: #1 invite link, #16 rate limiting, #21 Firefox in the matrix.
Also since 0.5.0: GitHub remote `bankierubybank/share` (public), CI live; deploy workflow hardened for a public repo.

### Invite links (#1)
- People → **Invite link**: create a link (`/join/<token>`), copy or share it. Whoever opens it signs in, picks
  who they are in the trip (people already linked show "Already joined") or joins as a new person — nobody has to
  type their email. One link per trip, 14 days; **New link** rotates (old one dies), **Turn off** revokes.
- Only the token's SHA-256 is stored (migration `0005_invites`), so the link is shown once — after a reload the
  section says it's active until a date. Status comes with the trip page (`GET …/full`), still one request.
- The join page never sees the trip id, emails, PromptPay or bills until the person is in. Activity logs
  `invite.create|revoke` and "X joined by invite link".
- Access still gates the site: invitees must be allowed by the Access policy (docs/ACCESS.md has the options).
- API: `GET|POST|DELETE /api/groups/:gid/invite`, `GET|POST /api/join/:token` (docs/API.md → Invite links).

### Rate limiting (#16)
- Workers rate-limit binding, per verified identity: 600 requests/min on `/api`, 30/min on `/api/join/*` and
  `/api/view/*` (link guessing). Over → `429 rate_limited` + `Retry-After: 60`.
- Service tokens (test automation) skip the link limit unless a test opts in with `X-Test-Rate-Key`; locally
  nothing is limited without that header (parallel E2E shares one dev identity). New gate step `test:ratelimit`
  runs last locally and on prod (it trips the link limit on purpose). Rules + unit tests: `src/lib/ratelimit.ts`.
- First prod run of 0.6 (version 3f0fef43) failed 10 security tests with 429: the suites' own view-id brute-force
  checks used up the service token's link budget. Fixed forward (above) before committing (ISSUES #37).

### Firefox (#21)
- CI (Linux) installs Firefox and runs the E2E suite on it too; the dev Mac still skips it (ISSUES #1).

## 0.5.0 — 2026-10-27

Owner picks from round 3: #15 D1 write latency, #13 faster saves, #18 CI draft (+ repo name).

### Performance (#15)
- **Fewer D1 round trips.** A write now reads its result back in the same `batch()` (add/edit bill, restore,
  create trip, rename/archive, comment); validation reads are one batch (`billWriteContext`); delete/restore build
  their activity row in SQL (`INSERT … SELECT json_object(…) … AND changes() > 0`) instead of reading the bill
  first. Add / edit bill: 6–7 → 3 round trips; delete 4 → 2; restore 5 → 2; create trip 2 → 1.
- **One request for the trip page**: `GET /api/groups/:gid/full` (one 8-statement batch) replaces five parallel
  requests (each with its own Access check + 2–4 round trips).
- **Smart Placement** for the API, and only `/api/*` runs the Worker (`run_worker_first: ["/api/*"]`): pages and
  bundles come straight from the edge, with their security headers from `web/public/_headers` and
  `Cache-Control: immutable` on hashed `/assets/*`.
- **Server-Timing** on every API response (`db;dur;desc="N round trips", app;dur`) + a `slow request` log line
  (> 800 ms, route shape only). Budgets are pinned in `test/integration/perf.test.ts`.

### Faster saves (#13)
- **Optimistic bill add / edit / delete**: the dialog closes at once, the row shows "Saving…" and totals /
  balances / who-pays-whom update immediately (computed by `src/lib/summary.ts`, the Worker's own code). The
  server's answer replaces it; a failure rolls back and offers **Edit** to reopen what was typed. Opening a row
  that is still saving waits for it; Undo after a delete waits for the delete to land. Receipt upload follows
  the save; if only the photo fails, the bill stays and a message says so.
- Repeating bills, moves, people, settings and comments still wait for the server (they need its answer).

### Measured on prod (median of 6, before → after)
add bill 301 → 175 ms · edit 300 → 172 ms · delete 171 → 115 ms · create trip 1815 → 1066 ms · trip page
5 requests / 177 ms → 1 request / 188 ms. Perceived save time for bills: 0 ms (optimistic).

### Fixed (found while testing 0.5)
- Overlapping background refreshes could paint an older page over a newer one (ISSUES #32): newest load wins.
- E2E helpers wait for `[data-saving]` to clear (the save is confirmed and the page re-rendered) before the next step.

### CI (#18, draft)
- `.github/workflows/ci.yml` (local gate on every push/PR) and `deploy.yml` (prod D1 export → R2, deploy, prod
  tests, automatic `wrangler rollback` on failure). Inactive until a GitHub remote + secrets exist — `docs/CI.md`
  has the setup steps and repo-name ideas.

## 0.4.0 — 2026-10-27 (deployed, version f8bfa8f1)

Owner request: "limit view on trip you involved" — ABC on trip 1, CDE on trip 2 → A, B see trip 1; C sees both.

### Added
- **Trip membership**: people can carry an email (their Cloudflare Access login). A trip opens only for identities
  linked to one of its people; everyone else gets "Not your trip" (403 `not_member`) — the link alone is no longer enough.
- **My trips** on home from the server (`GET /api/me/groups`, works on any device); this-device-only entries stay
  listed as "on this device only" (e.g. trips not claimed yet).
- Creating a trip links you to the first person ("Ann (you)"); People shows each person's email / "No email",
  a "You" tag, an Email field in the edit dialog and "This is me" (move your link, `POST /api/groups/:gid/me`).
- **Pre-0.4 trips** (nobody linked): the first visitor picks who they are ("Which one are you?"), then the trip is locked.
- Guards: the last linked person can't be unlinked/removed (409 `last_link`); move/merge need you in both trips
  (404 otherwise); people added by move/merge get no email; view links and activity never show emails.
- Migration `0004_membership` (additive: `members.email` + indexes). API v4 (docs/API.md → Membership).

### Security
- In-Worker Cloudflare Access JWT verification is now **on** (`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` in wrangler.jsonc —
  was backlog #19): identity = verified JWT email, or `svc:<client id>` for service tokens. Identity headers are
  never trusted on prod; local dev/tests use `--var DEV_IDENTITY:1` (header-based, default `dev@example.com`).
- `src/lib/actor.ts` (unverified header/JWT read, display-only) replaced by `src/lib/identity.ts`.

### Fixed (found while testing 0.4)
- Home re-rendered the whole page when "my trips" arrived — on slow prod it wiped a group name being typed.
  Now only the list card is swapped.
- E2E: view-link test reopened the link before the revoke had saved; onboarding test needs a fresh identity
  (home is never empty for a shared test identity) and runs locally only.
- `scripts/test-local.sh` takes `PORT=…` (default 8787) when that port is taken.

### Tests
- New: integration `membership.test.ts` (the ABC/CDE scenario, every route gated, claim, links, move/merge),
  unit `identity.test.ts`, system `v4-membership.test.ts` (runs on prod), security `v4-security.test.ts`
  (outsider 403s, merge/move pulls, forged JWT, spoofed header on prod), E2E `v4.spec.ts` (second browser user).
- Older tests that used a second identity now link it first; local counts: unit 153, integration 168, system 32, security 110 (+2 prod-only), E2E 48×4 (192). Prod: system 32, security 108 (+4 local-only), E2E 92 (+4 local-only).

## 0.3.1 — 2026-10-27 (code review; deployed, version 80b4a21f)

Full review of the code base + cross-check of every .md against the code (routes, tables, scripts, conventions).

### Fixed
- Request bodies without Content-Length were buffered in full before size checks (JSON 32 KiB, receipts 2 MiB);
  now read with a hard cap (`src/lib/body.ts`).
- Repeating bills: start date limited to the last 92 days / next year; recurrences stop at the 5000-bill cap.
- Scheduled maintenance steps (backup, recurring, purge) no longer block each other.
- Group view: pull-to-refresh / late loads could re-render a group over the home page; receipt preview blob leak.

### Performance
- Repeating-bill catch-up: all due dates computed up front, one guarded claim + one batched insert (was ~8 D1 round
  trips per occurrence → 4.7 s for 3 months on prod). Concurrency test: two simultaneous runs create each bill once.
- Prod E2E gets 30 s expect / 120 s test timeouts, prod system/security (vitest) 120 s per test (prod D1 write
  batches spiked to seconds — ISSUES #28; the v3 system story timed out at 30 s on the first prod run).

### Docs
- README rewritten for v0.3 (features, all test commands, `db:verify`); PLAN.md now records model tiers and
  the per-round dispatch history; CLAUDE.md conventions (i18n, lazy chunks, bounded bodies, id secrecy, E2E waits);
  ARCHITECTURE layout of web modules; API limits; ISSUES sorted.
- New script `npm run db:verify`.

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
