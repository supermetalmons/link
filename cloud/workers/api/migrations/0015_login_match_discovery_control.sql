CREATE TABLE login_match_discovery_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  discovery_backend TEXT NOT NULL DEFAULT 'rtdb' CHECK (discovery_backend IN ('rtdb', 'd1')),
  capture_enforced INTEGER NOT NULL DEFAULT 0 CHECK (capture_enforced IN (0, 1)),
  capture_version_id TEXT,
  capture_started_at_ms INTEGER,
  import_id TEXT,
  source_digest TEXT,
  source_player_count INTEGER,
  source_match_count INTEGER,
  imported_at_ms INTEGER,
  verified_at_ms INTEGER,
  verification_digest TEXT,
  activated_at_ms INTEGER,
  CHECK ((capture_enforced = 0 AND capture_version_id IS NULL AND capture_started_at_ms IS NULL)
    OR (capture_enforced = 1 AND capture_version_id IS NOT NULL AND capture_started_at_ms IS NOT NULL AND capture_started_at_ms >= 0)),
  CHECK (discovery_backend = 'rtdb' OR (capture_enforced = 1 AND verified_at_ms IS NOT NULL AND activated_at_ms IS NOT NULL))
);

INSERT INTO login_match_discovery_control (singleton) VALUES (1);
