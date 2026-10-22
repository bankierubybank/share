-- Initial schema. Money in integer minor units.
CREATE TABLE groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  currency   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE members (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX members_group_name ON members(group_id, lower(name));

CREATE TABLE bills (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('expense', 'payment')),
  description TEXT NOT NULL,
  amount      INTEGER NOT NULL CHECK (amount > 0),
  paid_by     TEXT NOT NULL REFERENCES members(id),
  date        TEXT NOT NULL,
  split_mode  TEXT NOT NULL CHECK (split_mode IN ('equal', 'exact')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX bills_group ON bills(group_id, date DESC, created_at DESC);

CREATE TABLE bill_shares (
  bill_id   TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id),
  amount    INTEGER NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (bill_id, member_id)
);
CREATE INDEX bill_shares_member ON bill_shares(member_id);
