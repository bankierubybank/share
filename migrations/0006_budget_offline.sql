-- v0.9: trip budget (#4) and offline bill entry (#8). Additive only (no table rebuilds).

-- Optional spending target for the whole trip, in the trip currency's minor units (NULL = no budget).
ALTER TABLE groups ADD COLUMN budget INTEGER CHECK (budget IS NULL OR budget > 0);

-- Bills queued offline carry a client-made key: a retry after a lost response returns the first bill instead of
-- adding it twice. Unique per trip; NULL for bills made online.
ALTER TABLE bills ADD COLUMN client_ref TEXT;
CREATE UNIQUE INDEX bills_client_ref ON bills(group_id, client_ref) WHERE client_ref IS NOT NULL;
