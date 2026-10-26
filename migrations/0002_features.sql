-- v0.2: archive, categories, soft delete, multi-payer, new split modes, multi-currency,
-- receipts, activity log, recurring bills, PromptPay ids.
PRAGMA defer_foreign_keys = true;

ALTER TABLE groups ADD COLUMN archived_at TEXT;
ALTER TABLE members ADD COLUMN promptpay TEXT;

-- Rebuild bills: widen split_mode CHECK and add columns (SQLite cannot alter CHECK constraints).
CREATE TABLE bills_v2 (
  id                TEXT PRIMARY KEY,
  group_id          TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('expense', 'payment')),
  description       TEXT NOT NULL,
  amount            INTEGER NOT NULL CHECK (amount > 0),
  paid_by           TEXT NOT NULL REFERENCES members(id),
  date              TEXT NOT NULL,
  split_mode        TEXT NOT NULL CHECK (split_mode IN ('equal', 'exact', 'shares', 'percent', 'itemized')),
  split_json        TEXT,
  category          TEXT NOT NULL DEFAULT 'other',
  original_currency TEXT,
  original_amount   INTEGER,
  fx_rate           TEXT,
  receipt_key       TEXT,
  recurrence_id     TEXT,
  created_by        TEXT,
  deleted_at        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO bills_v2 (id, group_id, kind, description, amount, paid_by, date, split_mode, created_at, updated_at)
  SELECT id, group_id, kind, description, amount, paid_by, date, split_mode, created_at, updated_at FROM bills;
-- Dropping bills runs ON DELETE CASCADE into bill_shares (defer_foreign_keys defers checks, not actions).
-- Keep a copy of the shares and restore it after the swap.
CREATE TABLE bill_shares_backup AS SELECT bill_id, member_id, amount FROM bill_shares;
DROP TABLE bills;
ALTER TABLE bills_v2 RENAME TO bills;
INSERT INTO bill_shares (bill_id, member_id, amount) SELECT bill_id, member_id, amount FROM bill_shares_backup;
DROP TABLE bill_shares_backup;
CREATE INDEX bills_group ON bills(group_id, date DESC, created_at DESC);
CREATE INDEX bills_deleted ON bills(deleted_at) WHERE deleted_at IS NOT NULL;

-- Who paid how much (single payer = one row). Backfilled from bills.paid_by.
CREATE TABLE bill_payers (
  bill_id   TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id),
  amount    INTEGER NOT NULL CHECK (amount > 0),
  PRIMARY KEY (bill_id, member_id)
);
CREATE INDEX bill_payers_member ON bill_payers(member_id);
INSERT INTO bill_payers (bill_id, member_id, amount) SELECT id, paid_by, amount FROM bills;

CREATE TABLE activity (
  id        TEXT PRIMARY KEY,
  group_id  TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor     TEXT,
  action    TEXT NOT NULL,
  entity_id TEXT,
  detail    TEXT
);
CREATE INDEX activity_group ON activity(group_id, at DESC);

CREATE TABLE recurrences (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  frequency  TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  anchor_day INTEGER NOT NULL,
  next_date  TEXT NOT NULL,
  template   TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX recurrences_due ON recurrences(active, next_date);
