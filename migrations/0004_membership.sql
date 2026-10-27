-- v0.4: link people to Cloudflare Access identities (email, or "svc:<client id>" for service tokens).
-- A trip is visible only to identities linked to one of its people. Additive only (no table rebuilds).

ALTER TABLE members ADD COLUMN email TEXT;
CREATE UNIQUE INDEX members_group_email ON members(group_id, email) WHERE email IS NOT NULL;
CREATE INDEX members_email ON members(email) WHERE email IS NOT NULL;
