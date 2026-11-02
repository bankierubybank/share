-- v0.12: a trip's favourite bills (#4) — one tap fills a new bill. Additive only.

-- `template` = the bill body without a date (JSON, validated on save and again when listed: a person removed
-- later makes it unusable, shown as such, never applied).
CREATE TABLE bill_templates (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  template   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX bill_templates_group_name ON bill_templates(group_id, lower(name));
