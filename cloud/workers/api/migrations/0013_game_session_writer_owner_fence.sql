ALTER TABLE game_session_mutation_locks
ADD COLUMN writer_owner_id TEXT;

DROP TRIGGER game_session_legacy_acquire_fence;
DROP TRIGGER game_session_legacy_refresh_fence;
DROP TRIGGER game_session_legacy_release_evidence;

CREATE TRIGGER game_session_legacy_acquire_fence
BEFORE INSERT ON game_session_mutation_locks
WHEN (NEW.writer_generation != 2 OR (
    NEW.writer_owner_id IS NOT NEW.owner_id
    AND EXISTS (SELECT 1 FROM automatch_runtime_control WHERE singleton = 1 AND backend = 'rtdb')
  ))
  AND (SELECT enabled FROM game_session_legacy_fence WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'legacy-game-session-writer-disabled');
END;

CREATE TRIGGER game_session_legacy_refresh_fence
BEFORE UPDATE ON game_session_mutation_locks
WHEN (NEW.writer_generation != 2 OR (
    NEW.writer_owner_id IS NOT NEW.owner_id
    AND EXISTS (SELECT 1 FROM automatch_runtime_control WHERE singleton = 1 AND backend = 'rtdb')
  ))
  AND (SELECT enabled FROM game_session_legacy_fence WHERE singleton = 1) = 1
BEGIN
  SELECT RAISE(ABORT, 'legacy-game-session-writer-disabled');
END;

CREATE TRIGGER game_session_legacy_release_evidence
AFTER DELETE ON game_session_mutation_locks
WHEN (OLD.writer_generation != 2 OR (
    OLD.writer_owner_id IS NOT OLD.owner_id
    AND EXISTS (SELECT 1 FROM automatch_runtime_control WHERE singleton = 1 AND backend = 'rtdb')
  ))
  AND (SELECT enabled FROM game_session_legacy_fence WHERE singleton = 1) = 1
BEGIN
  INSERT OR REPLACE INTO game_session_legacy_releases
    (lock_id, owner_id, operation_id, expires_at_ms, released_at_ms)
  VALUES (OLD.lock_id, OLD.owner_id, OLD.operation_id, OLD.expires_at_ms,
          CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;
