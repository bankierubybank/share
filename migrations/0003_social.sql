-- v0.3: bill comments, saved subgroups, read-only view links. Additive only (no table rebuilds).

ALTER TABLE groups ADD COLUMN view_id TEXT;
CREATE UNIQUE INDEX groups_view_id ON groups(view_id) WHERE view_id IS NOT NULL;

CREATE TABLE bill_comments (
  id               TEXT PRIMARY KEY,
  bill_id          TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  group_id         TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  author_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  actor            TEXT,
  body             TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX bill_comments_bill ON bill_comments(bill_id, created_at);

CREATE TABLE subgroups (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  member_ids TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX subgroups_group ON subgroups(group_id);
