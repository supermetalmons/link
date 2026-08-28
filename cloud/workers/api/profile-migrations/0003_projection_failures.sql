CREATE TABLE profile_projection_failures (
  profile_id TEXT PRIMARY KEY,
  source_update_seconds INTEGER NOT NULL,
  source_update_nanos INTEGER NOT NULL CHECK (
    source_update_nanos >= 0 AND source_update_nanos < 1000000000
  ),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms > 0)
) WITHOUT ROWID;
