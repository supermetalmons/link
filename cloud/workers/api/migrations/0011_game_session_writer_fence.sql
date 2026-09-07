ALTER TABLE game_session_mutation_locks
ADD COLUMN writer_generation INTEGER NOT NULL DEFAULT 0;

CREATE TABLE game_session_legacy_fence (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  enabled_at_ms INTEGER,
  candidate_version_id TEXT
);

INSERT INTO game_session_legacy_fence (singleton) VALUES (1);

CREATE TRIGGER game_session_legacy_acquire_fence
BEFORE INSERT ON game_session_mutation_locks
WHEN NEW.writer_generation != 2
  AND (SELECT enabled FROM game_session_legacy_fence WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'legacy-game-session-writer-disabled');
END;

CREATE TRIGGER game_session_legacy_refresh_fence
BEFORE UPDATE ON game_session_mutation_locks
WHEN NEW.writer_generation != 2
  AND (SELECT enabled FROM game_session_legacy_fence WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'legacy-game-session-writer-disabled');
END;

CREATE TABLE game_session_legacy_releases (
  lock_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  released_at_ms INTEGER NOT NULL,
  reconciled_at_ms INTEGER,
  evidence_digest TEXT,
  PRIMARY KEY (lock_id, owner_id)
) WITHOUT ROWID;

CREATE TRIGGER game_session_legacy_release_evidence
AFTER DELETE ON game_session_mutation_locks
WHEN OLD.writer_generation != 2
  AND (SELECT enabled FROM game_session_legacy_fence WHERE singleton = 1) = 1
BEGIN
  INSERT OR REPLACE INTO game_session_legacy_releases
    (lock_id, owner_id, operation_id, expires_at_ms, released_at_ms)
  VALUES (OLD.lock_id, OLD.owner_id, OLD.operation_id, OLD.expires_at_ms,
          CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
