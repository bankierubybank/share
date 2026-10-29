-- v0.11: trip dates (#7), a trip's own categories (#12), Web Push subscriptions (#6). Additive only.

-- Optional trip dates (YYYY-MM-DD): the spending-per-day chart and the budget's daily pace.
ALTER TABLE groups ADD COLUMN start_date TEXT;
ALTER TABLE groups ADD COLUMN end_date TEXT;

-- A trip's own categories; a bill points at one as category = 'c:' || id. Deleting one leaves its bills
-- pointing at a missing id, which reads as "Other".
CREATE TABLE categories (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  icon       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX categories_group_name ON categories(group_id, lower(name));

-- One row per browser that turned notifications on, keyed by its push endpoint (a capability URL: never shown
-- to anyone). `identity` = who gets notified; `lang` = the language the message is written in.
CREATE TABLE push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  identity   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  lang       TEXT NOT NULL DEFAULT 'en',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX push_subscriptions_identity ON push_subscriptions(identity);
