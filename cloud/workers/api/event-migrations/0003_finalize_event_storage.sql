INSERT INTO event_transaction_guards (singleton)
SELECT 0 WHERE NOT EXISTS (
  SELECT 1 FROM event_runtime_control
  WHERE singleton = 1
    AND storage_mode = 'frozen'
    AND previous_storage_mode = 'd1'
    AND freeze_generation > 0
    AND cutover_at_ms > 0
    AND length(source_digest) = 64
    AND source_digest NOT GLOB '*[^a-f0-9]*'
    AND source_event_count >= 0
    AND source_selection_count >= 0
    AND source_assignment_count >= 0
    AND source_exported_at_ms > 0
    AND NOT EXISTS (SELECT 1 FROM event_write_admissions)
    AND NOT EXISTS (
      SELECT 1 FROM event_leases
      WHERE expires_at_ms > CAST(
        (julianday('now') - 2440587.5) * 86400000 AS INTEGER
      )
    )
);

CREATE TABLE event_runtime_control_next (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  storage_mode TEXT NOT NULL CHECK (storage_mode IN ('frozen', 'd1')),
  freeze_generation INTEGER NOT NULL CHECK (freeze_generation >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);

INSERT INTO event_runtime_control_next (
  singleton, storage_mode, freeze_generation, updated_at_ms
)
SELECT singleton, storage_mode, freeze_generation, updated_at_ms
FROM event_runtime_control;

DROP TABLE event_runtime_control;
ALTER TABLE event_runtime_control_next RENAME TO event_runtime_control;

DROP TABLE event_write_admissions;
CREATE TABLE event_write_admissions (
  admission_id TEXT PRIMARY KEY CHECK (
    admission_id != '' AND instr(admission_id, '/') = 0
  ),
  freeze_generation INTEGER NOT NULL CHECK (freeze_generation >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms)
) WITHOUT ROWID;

CREATE INDEX idx_event_write_admissions_expiry
ON event_write_admissions (expires_at_ms, admission_id);

CREATE TRIGGER event_runtime_control_validate_transition
BEFORE UPDATE ON event_runtime_control
WHEN NOT (
  (
    NEW.storage_mode = OLD.storage_mode
    AND NEW.freeze_generation = OLD.freeze_generation
  ) OR (
    OLD.storage_mode = 'd1' AND NEW.storage_mode = 'frozen'
    AND NEW.freeze_generation = OLD.freeze_generation + 1
  ) OR (
    OLD.storage_mode = 'frozen' AND NEW.storage_mode = 'd1'
    AND NEW.freeze_generation = OLD.freeze_generation
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid event storage transition');
END;

CREATE TRIGGER event_runtime_control_reject_write_admissions
BEFORE UPDATE OF storage_mode ON event_runtime_control
WHEN OLD.storage_mode != NEW.storage_mode
AND EXISTS (SELECT 1 FROM event_write_admissions)
BEGIN
  SELECT RAISE(ABORT, 'event write admissions are active');
END;

CREATE TRIGGER event_runtime_control_reject_delete
BEFORE DELETE ON event_runtime_control
BEGIN
  SELECT RAISE(ABORT, 'event runtime control is permanent');
END;

CREATE TRIGGER event_runtime_control_reject_replace
BEFORE INSERT ON event_runtime_control
WHEN EXISTS (SELECT 1 FROM event_runtime_control)
BEGIN
  SELECT RAISE(ABORT, 'event runtime control is permanent');
END;

CREATE TRIGGER event_write_admissions_gate
BEFORE INSERT ON event_write_admissions
WHEN NOT EXISTS (
  SELECT 1 FROM event_runtime_control
  WHERE singleton = 1 AND storage_mode = 'd1'
    AND freeze_generation = NEW.freeze_generation
)
BEGIN
  SELECT RAISE(ABORT, 'event writes are disabled');
END;
