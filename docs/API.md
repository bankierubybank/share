# API Contract (v8 — app 0.11.2)

Base: same origin, prefix `/api`. JSON in/out. Money = **integer minor units** (cents). Dates = `YYYY-MM-DD` (UTC).
Every response carries `Server-Timing: db;dur=<ms>;desc="<n> round trips", app;dur=<ms>` (0.5; diagnostics only).

Write requests (`POST/PUT/PATCH`) with a body **must** send `Content-Type: application/json`, else `415`.
Body limit 32 KiB → `413` (also enforced for chunked bodies without Content-Length). Exceptions: receipt upload (`PUT …/receipt`) and receipt scan (`POST …/scan`, 0.11) take a raw `image/jpeg|png|webp` body ≤ 2 MiB.
Errors: `{ "error": { "code": string, "message": string } }`.

| Status | code |
|--------|------|
| 400 | `bad_request` / `validation` |
| 401 | `unauthorized` (no valid Access identity) |
| 403 | `not_member` (you're not linked to anyone in this trip) / `claim_required` (pre-0.4 trip, nobody linked yet) / `email_locked` (0.10) |
| 404 | `not_found` / `push_off` (0.11, notifications not configured) |
| 405 | `method_not_allowed` |
| 409 | `conflict` (limits, duplicates, member in use) / `archived` (write to archived group) / `last_link` / `missing_members` (move/merge) / `others_linked` (0.10, delete forever) / `limit` (0.11, categories) / `stale` (0.11, `ifUpdatedAt`) |
| 410 | `trip_deleted` (0.10) — the trip is in the bin: every `/groups/:gid/**` route except `POST …/restore` and `DELETE /groups/:gid`; body has `deletedAt`. Non-members get `404` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |
| 429 | `rate_limited` (0.6) + `Retry-After: 60` — per identity: 600 `/api` requests a minute; 30 a minute on `/api/join/*` + `/api/view/*`; (0.11) 10 scans a minute |
| 500 | `internal` |
| 502 | `scan_failed` (0.11, the model gave no usable answer) |

## Types

```ts
Group   = { id; name; currency; archived: boolean; createdAt; budget: number | null; // 0.9: trip budget, minor units
            startDate: string | null; endDate: string | null }          // 0.11: trip dates YYYY-MM-DD
Member  = { id; name; promptpay: string | null;        // normalized PromptPay id (10/13/15 digits)
            email: string | null }                      // linked identity: who may open the trip as this person
MyGroup = Group & { memberId; memberName }              // a trip I'm linked to
Share   = { memberId: string; amount: number }
Category = 'food'|'groceries'|'lodging'|'transport'|'activities'|'shopping'|'utilities'|'other'
         | `c:${string}`                                // 0.11: one of the trip's own categories
Split   = { mode: 'equal';    members: string[] }                         // remainder → first in order
        | { mode: 'exact';    shares: Share[] }                           // sum == amount
        | { mode: 'shares';   weights: { memberId; weight: int 0..10000 }[] }   // ≥1 weight > 0
        | { mode: 'percent';  percents: { memberId; bp: int 0..10000 }[] }      // sum bp == 10000 (100%)
        | { mode: 'itemized'; items: { description; amount; members: string[] }[];  // ≤100 items
                              serviceBp?: int 0..10000; taxBp?: int 0..10000 }      // service then tax, compounding
Fx      = { currency: string; amount: number /* minor units of fx.currency */; rate: string /* "36.25", ≤8 dp */ }
Bill    = { id; kind: 'expense'|'payment'; description; amount; paidBy /* first payer */; payers: Share[];
            date; category: Category; splitMode; split: Split /* normalized, for editing */; shares: Share[];
            fx: Fx | null; hasReceipt: boolean; recurrenceId: string | null; createdBy: string | null;
            createdAt; updatedAt }
Balance = { memberId; paid; owed; net }   // paid/owed = expenses only; net also includes payments
Settlement = { from; to; amount }
Activity = { id; at; actor: string | null; action; entityId: string | null; detail: object | null; restorable: boolean }
Recurrence = { id; frequency: 'weekly'|'monthly'; nextDate; active; lastError: string | null;
               template: BillBody-without-date; createdBy; createdAt }
```

### Bill body (POST / PUT)
```ts
{ kind?: 'expense'|'payment', description, date, category?: Category, split: Split,
  amount?: number,                       // required unless computed (itemized / fx); if sent with computed, must match
  paidBy?: string | payers?: Share[],    // one of them; payers sum must == amount
  fx?: Fx }                              // amount = round_half_up(fx.amount × rate) converted between currency digits
```
- Itemized: amount = round_half_up(subtotal × (1+service) × (1+tax)); per-member subtotals (items split equally),
  then the total is spread proportionally (largest remainder). Itemized + fx → 400.
- shares/percent: largest-remainder allocation; ties → earlier entry. Zero shares are dropped.
- Payment: single payer, `split = { mode:'equal', members:[receiver] }`, receiver ≠ payer.
- `shares`/`payers` returned in member display order.

## Membership (v4 — app 0.4.0)

A trip is visible **only to identities linked to one of its people** (`members.email`, unique per trip).
Identity = the email in the verified Cloudflare Access JWT, or `svc:<client id>` for a service token
(shown as `"service token"`; locally `DEV_IDENTITY=1` reads the `Cf-Access-Authenticated-User-Email` header instead,
default `dev@example.com`). The group id is still unguessable, but no longer enough on its own.

- Every `/api/groups/:gid/**` route: no identity → `401`; not linked → `403 not_member` (nothing about the trip
  in the body); trip with nobody linked (created before 0.4) → `403 { error: { code: "claim_required", members: [{ id, name }] } }`
  until someone says who they are with `POST …/me` (only names are revealed before that; then the trip is locked).
- Creating a trip links the creator to `members[me]` (default 0).
- Any member may set/clear other people's `email`. The trip's **last** link can't be cleared or deleted (`409 last_link`).
- Move/merge: the other trip must also have you linked, else `404` (indistinguishable from "doesn't exist").
  People added by a move/merge get **no** email (a move must not grant access to the whole target trip).
- Read-only view links (`/api/view/:viewId`) stay an explicit, opt-in way to show a trip to non-members; no emails in them.
- Activity: `member.email` (`{ name, set }`, never the address), `member.link` (`{ name }`).

| Method | Path | Body | 2xx |
|--------|------|------|-----|
| GET | `/api/me/groups` | – | `{ groups: MyGroup[] }` newest first, ≤200 |
| POST | `/api/groups/:gid/me` | `{ memberId }` | `{ me }` — claim an unclaimed trip, or move my link to that (unlinked) person; 409 if linked to someone else (allowed while archived) |

## Invite links (v5 — app 0.6.0)

A trip member creates a link; whoever opens it (signed in through Cloudflare Access) picks who they are, or adds
themselves, and their identity is linked to that person — no email typing under People. One active link per trip,
**14 days**; creating again **rotates** (the old link stops working). The server stores only the token's SHA-256,
so the token is returned once (on create) and the trip page can't show it again. The join side never returns the
trip id until the caller is in the trip. Joining doesn't bypass Access: the invitee must still be allowed to sign
in to the site (Access policy, docs/ACCESS.md).

| Method | Path | Body | 2xx |
|--------|------|------|-----|
| GET | `/api/groups/:gid/invite` | – | `{ active: boolean, expiresAt: string \| null }` |
| POST | `/api/groups/:gid/invite` | `{}` | `201 { token, expiresAt }` — create or rotate; link = `/join/<token>`; 409 if archived |
| DELETE | `/api/groups/:gid/invite` | – | `204` turn off (allowed even when archived) |
| GET | `/api/join/:token` | – | not in the trip yet: `{ joined: false, group: { name, currency, archived }, members: [{ id, name, taken }], expiresAt }`; already in it: `{ joined: true, groupId, me, group }` |
| POST | `/api/join/:token` | `{ memberId }` **or** `{ name }` | `{ groupId, me }` (`201` when added as a new person); idempotent if already in the trip |

Errors: unknown / revoked / rotated / expired token → `404`; trip archived → `409 archived`; person already
linked to someone else, or name taken (case-insensitive) → `409 conflict`; member limit → `409`; no identity → `401`.
Both join routes share the stricter link rate limit. Activity: `invite.create`, `invite.revoke`,
`member.join` (`{ name }`, or `{ name, added: true }` for a new person).

## Endpoints

| Method | Path | Body | 2xx |
|--------|------|------|-----|
| GET | `/api/health` | – | `{ ok, version }` |
| GET | `/api/me` | – | `{ actor: string \| null }` (Access email, `"service token"`, or null) |
| GET | `/api/me/overview` | – | (0.8) `{ trips: [{ groupId, paid, owed, net, total, bills }], months: [{ month: "YYYY-MM", currency, owed }] }` — my position in every trip I'm linked to (same numbers as that trip's `summary` balance for me; `total`/`bills` = trip's expense total / live bills) and my share of expenses per month and currency (newest first, ≤36 rows; payments excluded; currencies never added together) |
| GET | `/api/groups/:gid/version` | – | (0.8) `{ v: string }` opaque token that changes when the trip does (activity or bill edits); the trip page polls it for live refresh. `/full` returns the same token as `version`. |
| POST | `/api/groups` | `{ name, currency, members: string[], me?: index }` | `201 { group, members, me }` (creator linked to `members[me]`) |
| GET | `/api/groups/:gid` | – | `{ group, members, bills, me }` (`me` = my member id; live bills, newest first; materializes due recurring bills) |
| GET | `/api/groups/:gid/full` | – | (0.5) the trip page in one request: `{ group, members, bills, me, summary, recurring, activity /* first 50 */, subgroups, invite /* 0.6: { active, expiresAt } */, version /* 0.8 */ }` — same values as the separate endpoints |
| PATCH | `/api/groups/:gid` | `{ name?, currency?, archived?: boolean, budget?: number \| null, startDate?, endDate? }` | `{ group }` — budget (0.9): positive integer ≤ 1e11 or null to clear; logs `group.budget` |
| DELETE | `/api/groups/:gid` | – | (0.10) `204` → **bin** for 30 days (then removed with receipts by the daily job). `?forever=1`: `204` removed at once incl. receipts, only when the caller is the only linked person, else `409 others_linked` |
| GET | `/api/groups/:gid/categories` | – | (0.11) `{ categories: [{ id, name, icon }] }` the trip's own; `/full` returns them as `categories` |
| POST | `/api/groups/:gid/categories` | `{ name: 1–24, icon }` | (0.11) `201 { category }`; icon from a fixed list; name unique per trip (409); ≤ 20 per trip (409 `limit`). A bill uses one as `category: "c:<id>"` |
| PATCH | `/api/groups/:gid/categories/:cid` | `{ name, icon }` | (0.11) `{ category }` |
| DELETE | `/api/groups/:gid/categories/:cid` | – | (0.11) `204`; bills keep `c:<id>` (shown as Other) |
| POST | `/api/groups/:gid/scan` | raw JPEG/PNG/WebP ≤ 2 MB | (0.11) `{ scan: { description?, amount?, date?, category?, fx?: { currency, amount }, items?: [{ description, amount }], serviceBp?, taxBp? } }` (0.11.1: items only when they rebuild the total) — suggestions only; 429 after 10/min; 502 `scan_failed` |
| GET | `/api/me/contacts` | – | (0.11) `{ contacts: [{ email, name }] }` people linked in my live trips (not me, not service tokens) |
| GET | `/api/push/key` | – | (0.11) `{ publicKey }` VAPID public key; 404 `push_off` when not configured |
| POST | `/api/me/push` | `{ endpoint, keys: { p256dh, auth }, lang? }` | (0.11) `201`; endpoint must be a browser push service (FCM, Mozilla, Apple, WNS); ≤ 10 devices per identity (oldest dropped) |
| DELETE | `/api/me/push` | `{ endpoint }` | (0.11) `204` |
| POST | `/api/groups/:gid/restore` | `{}` | (0.10) `{ group }` back from the bin (any of its people); `409` if not in the bin |
| GET | `/api/me/deleted` | – | (0.10) `{ trips: [{ id, name, currency, deletedAt, purgeAt, alone }] }` my trips in the bin |
| POST | `/api/groups/:gid/members` | `{ name, promptpay?, email? }` | `201 { member }` |
| PATCH | `/api/groups/:gid/members/:mid` | `{ name?, promptpay?: string \| null, email?: string \| null }` | `{ member }`; email lowercased, unique per trip (409); 409 `last_link`; (0.10) `403 email_locked` when changing someone else's email after they've opened the trip |
| DELETE | `/api/groups/:gid/members/:mid` | – | `204`; 409 if on a live bill or active recurring bill, or `last_link` |
| POST | `/api/groups/:gid/bills` | Bill body + optional `clientRef` | `201 { bill }`; (0.9) `clientRef` = 8–64 of `[A-Za-z0-9_-]`, unique per trip: if a bill with that key exists (even deleted) → `200 { bill, replayed: true }` with the first bill, nothing added (offline queue retries) |
| PUT | `/api/groups/:gid/bills/:bid` | Bill body + optional `ifUpdatedAt` | `{ bill }`; (0.11) with `ifUpdatedAt` ≠ the bill's `updatedAt` → `409 stale` (offline edits) |
| DELETE | `/api/groups/:gid/bills/:bid` | – | `204` **soft delete** (purged after 30 days) |
| POST | `/api/groups/:gid/bills/:bid/restore` | – | `{ bill }`; 404 if not deleted |
| PUT | `/api/groups/:gid/bills/:bid/receipt` | raw image | `201 { ok }`; magic-byte checked; replaces previous |
| GET | `/api/groups/:gid/bills/:bid/receipt` | – | image (`Content-Security-Policy: default-src 'none'; sandbox`) |
| DELETE | `/api/groups/:gid/bills/:bid/receipt` | – | `204` |
| GET | `/api/groups/:gid/summary` | – | `{ balances, settlements, total, byCategory: Record<Category, number> }` |
| GET | `/api/groups/:gid/activity?limit=50&before=<iso>` | – | `{ activity: Activity[] }` newest first, limit 1–100 |
| GET | `/api/groups/:gid/recurring` | – | `{ recurring: Recurrence[] }` |
| POST | `/api/groups/:gid/recurring` | `{ frequency, startDate (today −92 … +366 days), bill: BillBody-without-date }` | `201 { recurring, created }` (creates bills due up to today) |
| DELETE | `/api/groups/:gid/recurring/:rid` | – | `204` stop (bills already created stay) |

### v3 (app 0.3.0)

```ts
Comment  = { id; billId; authorMemberId: string | null; actor: string | null; body; createdAt }
Subgroup = { id; name; memberIds: string[] }
Bill.commentCount: number
```

| Method | Path | Body | 2xx |
|--------|------|------|-----|
| GET | `/api/groups/:gid/bills/:bid/comments` | – | `{ comments }` oldest first |
| POST | `/api/groups/:gid/bills/:bid/comments` | `{ body: 1–500 chars (newlines kept) }` | `201 { comment }`; ≤200 per bill (409); (0.10) author = the caller's own person (a `memberId` in the body is validated but ignored) |
| DELETE | `/api/groups/:gid/bills/:bid/comments/:cid` | – | `204` |
| GET | `/api/groups/:gid/subgroups` | – | `{ subgroups }` |
| POST | `/api/groups/:gid/subgroups` | `{ name: 1–40, memberIds: string[] ≥1 }` | `201 { subgroup }`; ≤20 per group |
| PUT | `/api/groups/:gid/subgroups/:sid` | same | `{ subgroup }` |
| DELETE | `/api/groups/:gid/subgroups/:sid` | – | `204` (removing a member strips them from subgroups; empty subgroups are deleted) |
| GET | `/api/groups/:gid/view-link` | – | `{ viewId: string \| null }` |
| POST | `/api/groups/:gid/view-link` | `{}` | `201 { viewId }` — creates or **rotates** (old link stops working) |
| DELETE | `/api/groups/:gid/view-link` | – | `204` revoke (allowed even when archived) |
| GET | `/api/view/:viewId` | – | `{ group (no id), members (no promptpay/email), bills (no createdBy/receipt/recurrence), summary, readOnly: true }` |
| POST | `/api/groups/:gid/bills/:bid/move` | `{ targetGroupId, addMissingMembers?: boolean }` | `{ bill, targetGroupId, addedMembers }` |
| POST | `/api/groups/:gid/merge` | `{ sourceGroupId, addMissingMembers?: boolean }` | `{ moved, addedMembers, sourceArchived: true }` |

Move/merge rules: members matched **by name, case-insensitive**; same currency required (400); target archived → 409;
missing names → `409 { error: { code: "missing_members", missing: string[] } }` unless `addMissingMembers`.
Moved bills keep id, payers, shares, split (remapped), comments (author link dropped); `recurrenceId` cleared.
Merge moves all live bills from source → this group, stops the source's repeating bills, archives the source.
Soft-deleted bills stay in the source.

Activity actions added: `comment.add`, `viewlink.create|revoke`, `bill.moveOut|moveIn`, `group.merge`.

**Archived groups** are read-only: any write except `PATCH /groups/:gid` with `archived:false` (or delete group) → `409 archived`.

Activity actions: `group.create|rename|currency|archive|unarchive|budget|dates|delete|restore`, `member.add|rename|promptpay|email|link|remove|join`,
`bill.create|update|delete|restore|recurring`, `receipt.add|remove`, `recurring.create|stop`, `invite.create|revoke`, `category.add` (0.11), `category.update|remove` (0.11.2; `{ name }`).

## Scheduled (daily 00:17 UTC)
1. Backup all tables → R2 `share-backups/backups/YYYY-MM-DD.json.gz` (keep 30 days). Restore: `scripts/restore-backup.mjs`.
2. Materialize due recurring bills (monthly keeps anchor day, clamped; weekly +7d; ≤60 per run each). Invalid template
   or the group at 5000 bills → deactivated with `lastError`.
3. Purge bills soft-deleted > 30 days (and their receipts).
4. (0.10) Remove trips in the bin > 30 days, with their receipts.

### Settlement algorithm
Greedy: sort creditors and debtors by |net| desc (tie → member id), match largest debtor with
largest creditor, repeat. Produces ≤ n−1 transfers; deterministic.
