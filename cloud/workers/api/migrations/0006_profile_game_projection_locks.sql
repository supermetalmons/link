CREATE TABLE profile_game_projection_locks (
  scope TEXT NOT NULL CHECK (scope IN ('invite', 'profile-link')),
  resource_id TEXT NOT NULL CHECK (resource_id != '' AND instr(resource_id, '/') = 0),
  owner_id TEXT NOT NULL CHECK (owner_id != ''),
  request_id TEXT,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
  PRIMARY KEY (scope, resource_id)
) WITHOUT ROWID;

CREATE INDEX idx_profile_game_projection_locks_expiry
ON profile_game_projection_locks (expires_at_ms, scope, resource_id);
