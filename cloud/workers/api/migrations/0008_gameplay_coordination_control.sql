ALTER TABLE match_timer_starts ADD COLUMN opponent_id TEXT;

CREATE TRIGGER match_timer_starts_opponent_insert
BEFORE INSERT ON match_timer_starts
WHEN NEW.opponent_id IS NOT NULL
  AND (NEW.opponent_id = '' OR instr(NEW.opponent_id, '/') != 0)
BEGIN
  SELECT RAISE(ABORT, 'invalid match timer opponent');
END;

CREATE TRIGGER match_timer_starts_opponent_update
BEFORE UPDATE OF opponent_id ON match_timer_starts
WHEN NEW.opponent_id IS NOT NULL
  AND (NEW.opponent_id = '' OR instr(NEW.opponent_id, '/') != 0)
BEGIN
  SELECT RAISE(ABORT, 'invalid match timer opponent');
END;

CREATE INDEX idx_match_timer_starts_reconciliation
ON match_timer_starts (updated_at_ms, player_id, match_id);

CREATE TABLE gameplay_coordination_control (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  authority TEXT NOT NULL CHECK (authority IN ('uninitialized', 'rtdb', 'd1')),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  source_digest TEXT CHECK (
    source_digest IS NULL OR (
      length(source_digest) = 64
      AND source_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  source_count INTEGER CHECK (source_count IS NULL OR source_count >= 0),
  source_version_id TEXT CHECK (
    source_version_id IS NULL OR (
      length(source_version_id) = 36
      AND substr(source_version_id, 9, 1) = '-'
      AND substr(source_version_id, 14, 1) = '-'
      AND substr(source_version_id, 19, 1) = '-'
      AND substr(source_version_id, 24, 1) = '-'
    )
  ),
  transitioned_at_ms INTEGER NOT NULL CHECK (transitioned_at_ms >= 0),
  CHECK (
    (
      authority = 'uninitialized'
      AND generation = 0
      AND source_digest IS NULL
      AND source_count IS NULL
      AND source_version_id IS NULL
      AND transitioned_at_ms = 0
    )
    OR
    (
      authority IN ('rtdb', 'd1')
      AND generation >= 1
      AND source_digest IS NOT NULL
      AND source_count IS NOT NULL
      AND source_version_id IS NOT NULL
    )
  )
) WITHOUT ROWID;

INSERT INTO gameplay_coordination_control (
  singleton,
  authority,
  generation,
  source_digest,
  source_count,
  source_version_id,
  transitioned_at_ms
) VALUES (1, 'uninitialized', 0, NULL, NULL, NULL, 0);

CREATE TRIGGER gameplay_coordination_control_no_insert
BEFORE INSERT ON gameplay_coordination_control
BEGIN
  SELECT RAISE(ABORT, 'gameplay coordination control already initialized');
END;

CREATE TRIGGER gameplay_coordination_control_no_delete
BEFORE DELETE ON gameplay_coordination_control
BEGIN
  SELECT RAISE(ABORT, 'gameplay coordination control cannot be deleted');
END;

CREATE TRIGGER gameplay_coordination_control_transition
BEFORE UPDATE ON gameplay_coordination_control
WHEN NEW.singleton != OLD.singleton
  OR (
    OLD.authority = 'uninitialized'
    AND NEW.authority != 'd1'
  )
  OR (
    OLD.authority = 'rtdb'
    AND NEW.authority != 'd1'
  )
  OR (
    OLD.authority = 'd1'
    AND NEW.authority != 'rtdb'
  )
  OR NEW.generation != OLD.generation + 1
  OR NEW.source_digest IS NULL
  OR NEW.source_count IS NULL
  OR NEW.source_version_id IS NULL
  OR NEW.transitioned_at_ms < OLD.transitioned_at_ms
BEGIN
  SELECT RAISE(ABORT, 'invalid gameplay coordination transition');
END;

CREATE TABLE gameplay_coordination_transition_guard (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1)
) WITHOUT ROWID;
