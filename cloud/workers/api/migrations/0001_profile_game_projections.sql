CREATE TABLE profile_game_projections (
  profile_id TEXT NOT NULL,
  projection_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('game', 'event')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'waiting', 'active', 'ended', 'dismissed')),
  sort_bucket INTEGER NOT NULL,
  list_sort_at_ms INTEGER NOT NULL CHECK (list_sort_at_ms > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (profile_id, projection_id)
) WITHOUT ROWID;

CREATE INDEX idx_profile_game_projections_page
ON profile_game_projections (
  profile_id,
  sort_bucket ASC,
  list_sort_at_ms DESC,
  projection_id ASC
);

CREATE TABLE profile_game_projection_tombstones (
  profile_id TEXT NOT NULL,
  projection_id TEXT NOT NULL,
  deleted_at_ms INTEGER NOT NULL CHECK (deleted_at_ms > 0),
  PRIMARY KEY (profile_id, projection_id)
) WITHOUT ROWID;
