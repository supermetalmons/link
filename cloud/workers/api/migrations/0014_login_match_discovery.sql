CREATE TABLE login_match_discovery (
  login_uid TEXT NOT NULL CHECK (login_uid != ''),
  match_id TEXT NOT NULL CHECK (match_id != ''),
  match_sort_key TEXT NOT NULL CHECK (match_sort_key != ''),
  invite_id TEXT,
  resolution TEXT NOT NULL CHECK (resolution IN ('resolved', 'missing', 'ambiguous')),
  provenance TEXT NOT NULL CHECK (provenance IN ('capture', 'backfill')),
  indexed_at_ms INTEGER NOT NULL CHECK (indexed_at_ms >= 0),
  PRIMARY KEY (login_uid, match_id),
  CHECK ((resolution = 'resolved' AND invite_id IS NOT NULL AND invite_id != '') OR (resolution != 'resolved' AND invite_id IS NULL))
) WITHOUT ROWID;

CREATE UNIQUE INDEX idx_login_match_discovery_page
ON login_match_discovery (login_uid, match_sort_key);

CREATE TABLE login_match_discovery_guards (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
);

CREATE TRIGGER login_match_discovery_mapping_guard
BEFORE UPDATE OF invite_id, resolution ON login_match_discovery
WHEN OLD.resolution = 'resolved' AND (NEW.resolution != 'resolved' OR NEW.invite_id IS NOT OLD.invite_id)
BEGIN
  SELECT RAISE(ABORT, 'login-match-discovery-mapping-conflict');
END;
