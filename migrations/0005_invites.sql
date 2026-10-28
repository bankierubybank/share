-- v0.6: invite links. One active invite per trip; only the SHA-256 of the token is stored (a DB read or backup
-- can't be turned into a working link). Additive only (no table rebuilds).

ALTER TABLE groups ADD COLUMN invite_hash TEXT;
ALTER TABLE groups ADD COLUMN invite_expires TEXT;
CREATE UNIQUE INDEX groups_invite_hash ON groups(invite_hash) WHERE invite_hash IS NOT NULL;
