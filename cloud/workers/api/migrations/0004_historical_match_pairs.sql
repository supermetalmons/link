CREATE TABLE historical_match_pairs (
  invite_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (
    json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'
  ),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('rating', 'transition', 'backfill')
  ),
  finalized_at_ms INTEGER NOT NULL CHECK (finalized_at_ms >= 0),
  archived_at_ms INTEGER NOT NULL CHECK (archived_at_ms >= finalized_at_ms),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (invite_id, match_id)
) WITHOUT ROWID;
