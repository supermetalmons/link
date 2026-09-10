CREATE TABLE anonymous_sessions (
  session_id TEXT PRIMARY KEY CHECK (length(session_id) = 36),
  uid TEXT UNIQUE CHECK (uid IS NULL OR length(uid) = 28),
  refresh_hash TEXT CHECK (refresh_hash IS NULL OR length(refresh_hash) = 64),
  revoke_hash TEXT NOT NULL CHECK (length(revoke_hash) = 64),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR revoked_at_ms > 0),
  CHECK ((uid IS NULL) = (refresh_hash IS NULL)),
  CHECK (uid IS NOT NULL OR revoked_at_ms IS NOT NULL)
) WITHOUT ROWID;
