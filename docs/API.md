# API Contract (v2 — app 0.2.0)

Base: same origin, prefix `/api`. JSON in/out. Money = **integer minor units** (cents). Dates = `YYYY-MM-DD` (UTC).

Write requests (`POST/PUT/PATCH`) with a body **must** send `Content-Type: application/json`, else `415`.
Body limit 32 KiB → `413`. Exception: receipt upload (`PUT …/receipt`) takes a raw `image/jpeg|png|webp` body ≤ 2 MiB.
Errors: `{ "error": { "code": string, "message": string } }`.

| Status | code |
|--------|------|
| 400 | `bad_request` / `validation` |
| 401 | `unauthorized` (Access JWT required/invalid, only when Access check enabled) |
| 404 | `not_found` |
| 405 | `method_not_allowed` |
| 409 | `conflict` (limits, duplicates, member in use) / `archived` (write to archived group) |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |

## Types

```ts
Group   = { id; name; currency; archived: boolean; createdAt }
Member  = { id; name; promptpay: string | null }        // normalized PromptPay id (10/13/15 digits)
Share   = { memberId: string; amount: number }
Category = 'food'|'groceries'|'lodging'|'transport'|'activities'|'shopping'|'utilities'|'other'
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

## Endpoints

| Method | Path | Body | 2xx |
|--------|------|------|-----|
| GET | `/api/health` | – | `{ ok, version }` |
| GET | `/api/me` | – | `{ actor: string \| null }` (Access email, `"service token"`, or null) |
| POST | `/api/groups` | `{ name, currency, members: string[] }` | `201 { group, members }` |
| GET | `/api/groups/:gid` | – | `{ group, members, bills }` (live bills, newest first; materializes due recurring bills) |
| PATCH | `/api/groups/:gid` | `{ name?, currency?, archived?: boolean }` | `{ group }` |
| DELETE | `/api/groups/:gid` | – | `204` hard delete incl. receipts |
| POST | `/api/groups/:gid/members` | `{ name, promptpay? }` | `201 { member }` |
| PATCH | `/api/groups/:gid/members/:mid` | `{ name?, promptpay?: string \| null }` | `{ member }` |
| DELETE | `/api/groups/:gid/members/:mid` | – | `204`; 409 if on a live bill or active recurring bill |
| POST | `/api/groups/:gid/bills` | Bill body | `201 { bill }` |
| PUT | `/api/groups/:gid/bills/:bid` | Bill body | `{ bill }` |
| DELETE | `/api/groups/:gid/bills/:bid` | – | `204` **soft delete** (purged after 30 days) |
| POST | `/api/groups/:gid/bills/:bid/restore` | – | `{ bill }`; 404 if not deleted |
| PUT | `/api/groups/:gid/bills/:bid/receipt` | raw image | `201 { ok }`; magic-byte checked; replaces previous |
| GET | `/api/groups/:gid/bills/:bid/receipt` | – | image (`Content-Security-Policy: default-src 'none'; sandbox`) |
| DELETE | `/api/groups/:gid/bills/:bid/receipt` | – | `204` |
| GET | `/api/groups/:gid/summary` | – | `{ balances, settlements, total, byCategory: Record<Category, number> }` |
| GET | `/api/groups/:gid/activity?limit=50&before=<iso>` | – | `{ activity: Activity[] }` newest first, limit 1–100 |
| GET | `/api/groups/:gid/recurring` | – | `{ recurring: Recurrence[] }` |
| POST | `/api/groups/:gid/recurring` | `{ frequency, startDate, bill: BillBody-without-date }` | `201 { recurring, created }` (creates bills due up to today) |
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
| POST | `/api/groups/:gid/bills/:bid/comments` | `{ body: 1–500 chars (newlines kept), memberId? }` | `201 { comment }`; ≤200 per bill (409) |
| DELETE | `/api/groups/:gid/bills/:bid/comments/:cid` | – | `204` |
| GET | `/api/groups/:gid/subgroups` | – | `{ subgroups }` |
| POST | `/api/groups/:gid/subgroups` | `{ name: 1–40, memberIds: string[] ≥1 }` | `201 { subgroup }`; ≤20 per group |
| PUT | `/api/groups/:gid/subgroups/:sid` | same | `{ subgroup }` |
| DELETE | `/api/groups/:gid/subgroups/:sid` | – | `204` (removing a member strips them from subgroups; empty subgroups are deleted) |
| GET | `/api/groups/:gid/view-link` | – | `{ viewId: string \| null }` |
| POST | `/api/groups/:gid/view-link` | `{}` | `201 { viewId }` — creates or **rotates** (old link stops working) |
| DELETE | `/api/groups/:gid/view-link` | – | `204` revoke (allowed even when archived) |
| GET | `/api/view/:viewId` | – | `{ group (no id), members (no promptpay), bills (no createdBy/receipt/recurrence), summary, readOnly: true }` |
| POST | `/api/groups/:gid/bills/:bid/move` | `{ targetGroupId, addMissingMembers?: boolean }` | `{ bill, targetGroupId, addedMembers }` |
| POST | `/api/groups/:gid/merge` | `{ sourceGroupId, addMissingMembers?: boolean }` | `{ moved, addedMembers, sourceArchived: true }` |

Move/merge rules: members matched **by name, case-insensitive**; same currency required (400); target archived → 409;
missing names → `409 { error: { code: "missing_members", missing: string[] } }` unless `addMissingMembers`.
Moved bills keep id, payers, shares, split (remapped), comments (author link dropped); `recurrenceId` cleared.
Merge moves all live bills from source → this group, stops the source's repeating bills, archives the source.
Soft-deleted bills stay in the source.

Activity actions added: `comment.add`, `viewlink.create|revoke`, `bill.moveOut|moveIn`, `group.merge`.

**Archived groups** are read-only: any write except `PATCH /groups/:gid` with `archived:false` (or delete group) → `409 archived`.

Activity actions: `group.create|rename|currency|archive|unarchive`, `member.add|rename|promptpay|remove`,
`bill.create|update|delete|restore|recurring`, `receipt.add|remove`, `recurring.create|stop`.

## Scheduled (daily 00:17 UTC)
1. Backup all tables → R2 `share-backups/backups/YYYY-MM-DD.json.gz` (keep 30 days). Restore: `scripts/restore-backup.mjs`.
2. Materialize due recurring bills (monthly keeps anchor day, clamped; weekly +7d). Invalid template → deactivated with `lastError`.
3. Purge bills soft-deleted > 30 days (and their receipts).

### Settlement algorithm
Greedy: sort creditors and debtors by |net| desc (tie → member id), match largest debtor with
largest creditor, repeat. Produces ≤ n−1 transfers; deterministic.
