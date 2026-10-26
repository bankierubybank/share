# API Contract (v1)

Base: same origin, prefix `/api`. JSON in/out. Money = **integer minor units** (cents). Dates = `YYYY-MM-DD`.

Write requests (`POST/PUT/PATCH/DELETE`) with a body **must** send `Content-Type: application/json`, else `415`.
Body limit 32 KiB → `413`. Errors: `{ "error": { "code": string, "message": string } }`.

| Status | code |
|--------|------|
| 400 | `bad_request` / `validation` |
| 401 | `unauthorized` (Access JWT required/invalid, only when Access check enabled) |
| 404 | `not_found` |
| 405 | `method_not_allowed` |
| 409 | `conflict` (e.g. delete member still used by bills) |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |

## Types

```ts
Group   = { id: string; name: string; currency: string; createdAt: string }
Member  = { id: string; name: string }
Share   = { memberId: string; amount: number }           // minor units owed by member
Bill    = { id: string; kind: 'expense' | 'payment'; description: string; amount: number;
            paidBy: string; date: string; splitMode: 'equal' | 'exact'; shares: Share[]; createdAt: string }
Split   = { mode: 'equal'; members: string[] }            // >=1 member ids
        | { mode: 'exact'; shares: Share[] }              // sum(amount) === bill.amount
Balance = { memberId: string; paid: number; owed: number; net: number }
// paid/owed = expenses only; net = paid - owed + payments sent - payments received (+ = is owed money)
Settlement = { from: string; to: string; amount: number } // `from` pays `to`
```

Limits: group/member name 1–60 chars (trimmed), description 1–120, currency = 3 uppercase letters,
amount 1 … 100,000,000,000, members per group ≤ 50, bills per group ≤ 5000.

## Endpoints

| Method | Path | Body | 2xx response |
|--------|------|------|--------------|
| GET | `/api/health` | – | `200 { ok: true, version }` |
| POST | `/api/groups` | `{ name, currency, members: string[] }` (1–50 names, unique case-insensitive) | `201 { group, members }` |
| GET | `/api/groups/:gid` | – | `200 { group, members, bills }` (bills newest date first) |
| PATCH | `/api/groups/:gid` | `{ name?, currency? }` | `200 { group }` |
| POST | `/api/groups/:gid/members` | `{ name }` | `201 { member }` (409 if duplicate name) |
| PATCH | `/api/groups/:gid/members/:mid` | `{ name }` | `200 { member }` |
| DELETE | `/api/groups/:gid/members/:mid` | – | `204` (409 if member paid or shares any bill) |
| POST | `/api/groups/:gid/bills` | `{ kind?, description, amount, paidBy, date, split: Split }` | `201 { bill }` |
| PUT | `/api/groups/:gid/bills/:bid` | same as POST | `200 { bill }` |
| DELETE | `/api/groups/:gid/bills/:bid` | – | `204` |
| GET | `/api/groups/:gid/summary` | – | `200 { balances: Balance[], settlements: Settlement[], total: number }` |

`kind: 'payment'` = settle-up record: `paidBy` = payer, split must be exactly one member (the receiver) and
not the payer. `total` in summary = sum of `expense` bills only.

### Split rules
- Returned `bill.shares` are ordered by member display order (members' `position`).
- `equal`: amount ÷ n; remainder cents go one each to members in the order given in `split.members`
  (frontend sends them in member display order). Duplicates rejected.
- `exact`: each share ≥ 0, member ids unique and in group, sum == amount.
- Payer need not be in the split.

### Settlement algorithm
Greedy: sort creditors and debtors by |net| desc (tie → member id), match largest debtor with
largest creditor, repeat. Produces ≤ n−1 transfers; deterministic.
