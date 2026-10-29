-- v0.10: deleted trips go to a 30-day bin (restorable by anyone in them), and a person's sign-in email is theirs
-- once they've opened the trip. Additive only (no table rebuilds).

-- Set when someone deletes the trip; the daily job removes trips deleted more than 30 days ago.
ALTER TABLE groups ADD COLUMN deleted_at TEXT;
CREATE INDEX groups_deleted ON groups(deleted_at) WHERE deleted_at IS NOT NULL;

-- When the identity in `email` first opened the trip (NULL = not yet). While NULL, others may still fix or remove
-- an email they typed; after that only that person can change it.
ALTER TABLE members ADD COLUMN seen_at TEXT;
-- Existing links: we can't tell who has opened the trip, so treat every one as seen (the safe side).
UPDATE members SET seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE email IS NOT NULL;
