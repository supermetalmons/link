ALTER TABLE event_runtime_control
ADD COLUMN freeze_generation INTEGER NOT NULL DEFAULT 0
CHECK (freeze_generation >= 0);

ALTER TABLE event_runtime_control
ADD COLUMN verified_import_generation INTEGER
CHECK (
  verified_import_generation IS NULL OR verified_import_generation > 0
);

CREATE TABLE event_write_admissions (
  admission_id TEXT PRIMARY KEY CHECK (
    admission_id != '' AND instr(admission_id, '/') = 0
  ),
  admitted_storage_mode TEXT NOT NULL CHECK (
    admitted_storage_mode IN ('firebase', 'd1')
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms)
) WITHOUT ROWID;

CREATE INDEX idx_event_write_admissions_expiry
ON event_write_admissions (expires_at_ms, admission_id);

DROP TRIGGER event_runtime_control_validate_transition;

CREATE TRIGGER event_runtime_control_validate_transition
BEFORE UPDATE OF storage_mode, previous_storage_mode, freeze_generation
ON event_runtime_control
WHEN NOT (
  (
    OLD.storage_mode = NEW.storage_mode
    AND OLD.previous_storage_mode IS NEW.previous_storage_mode
    AND OLD.freeze_generation = NEW.freeze_generation
  )
  OR (
    OLD.storage_mode = 'firebase'
    AND OLD.previous_storage_mode IS NULL
    AND NEW.storage_mode = 'frozen'
    AND NEW.previous_storage_mode = 'firebase'
    AND NEW.freeze_generation = OLD.freeze_generation + 1
    AND NEW.verified_import_generation IS NULL
  )
  OR (
    OLD.storage_mode = 'd1'
    AND OLD.previous_storage_mode IS NULL
    AND NEW.storage_mode = 'frozen'
    AND NEW.previous_storage_mode = 'd1'
    AND NEW.freeze_generation = OLD.freeze_generation + 1
    AND NEW.verified_import_generation IS NULL
  )
  OR (
    OLD.storage_mode = 'frozen'
    AND OLD.previous_storage_mode = 'firebase'
    AND NEW.storage_mode = 'firebase'
    AND NEW.previous_storage_mode IS NULL
    AND NEW.freeze_generation = OLD.freeze_generation
    AND NEW.verified_import_generation IS NULL
  )
  OR (
    OLD.storage_mode = 'frozen'
    AND OLD.previous_storage_mode = 'firebase'
    AND NEW.storage_mode = 'd1'
    AND NEW.previous_storage_mode IS NULL
    AND NEW.freeze_generation = OLD.freeze_generation
    AND NEW.freeze_generation > 0
    AND NEW.verified_import_generation IS NEW.freeze_generation
    AND NEW.source_digest IS NOT NULL
    AND NEW.source_event_count IS NOT NULL
    AND NEW.source_selection_count IS NOT NULL
    AND NEW.source_assignment_count IS NOT NULL
    AND NEW.source_exported_at_ms IS NOT NULL
    AND NEW.cutover_at_ms IS NOT NULL
  )
  OR (
    OLD.storage_mode = 'frozen'
    AND OLD.previous_storage_mode = 'd1'
    AND NEW.storage_mode = 'd1'
    AND NEW.previous_storage_mode IS NULL
    AND NEW.freeze_generation = OLD.freeze_generation
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid event storage transition');
END;

CREATE TRIGGER event_runtime_control_validate_verification
BEFORE UPDATE OF verified_import_generation ON event_runtime_control
WHEN NEW.verified_import_generation IS NOT NULL
AND NEW.verified_import_generation IS NOT OLD.verified_import_generation
AND NOT (
  NEW.storage_mode = 'frozen'
  AND NEW.previous_storage_mode = 'firebase'
  AND NEW.freeze_generation > 0
  AND NEW.verified_import_generation = NEW.freeze_generation
  AND NEW.source_digest IS NOT NULL
  AND NEW.source_exported_at_ms IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invalid event import verification');
END;

CREATE TRIGGER event_runtime_control_reject_write_admissions
BEFORE UPDATE OF storage_mode ON event_runtime_control
WHEN OLD.storage_mode != NEW.storage_mode
AND NEW.storage_mode IN ('frozen', 'd1')
AND EXISTS (
  SELECT 1 FROM event_write_admissions
)
BEGIN
  SELECT RAISE(ABORT, 'event write admissions are active');
END;

ALTER TABLE event_progress_outboxes
RENAME TO event_progress_outboxes_v1;

CREATE TABLE event_progress_outboxes (
  outbox_id TEXT NOT NULL CHECK (
    outbox_id != '' AND instr(outbox_id, '/') = 0
  ),
  event_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dead')),
  run_at_ms INTEGER CHECK (run_at_ms IS NULL OR run_at_ms >= 0),
  last_queued_at_ms INTEGER NOT NULL CHECK (last_queued_at_ms >= 0),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) = 'object'
  ),
  CHECK (status = 'dead' OR event_id IS NOT NULL),
  PRIMARY KEY (status, outbox_id),
  FOREIGN KEY (event_id) REFERENCES event_records(event_id) ON DELETE CASCADE
) WITHOUT ROWID;

INSERT INTO event_progress_outboxes (
  outbox_id,
  event_id,
  status,
  run_at_ms,
  last_queued_at_ms,
  record_json
)
SELECT
  outbox_id,
  event_id,
  status,
  run_at_ms,
  last_queued_at_ms,
  record_json
FROM event_progress_outboxes_v1;

DROP TABLE event_progress_outboxes_v1;

CREATE INDEX idx_event_progress_outboxes_due
ON event_progress_outboxes (status, last_queued_at_ms, outbox_id);

CREATE INDEX idx_event_progress_outboxes_event
ON event_progress_outboxes (event_id, status, outbox_id);

CREATE TRIGGER event_records_bump_profile_prize_revisions
BEFORE DELETE ON event_records
WHEN EXISTS (
  SELECT 1 FROM profile_event_prizes WHERE event_id = OLD.event_id
)
BEGIN
  INSERT INTO profile_event_prize_revisions (
    profile_id,
    revision,
    updated_at_ms
  )
  SELECT DISTINCT profile_id, 1, OLD.updated_at_ms
  FROM profile_event_prizes
  WHERE event_id = OLD.event_id
  ON CONFLICT (profile_id) DO UPDATE SET
    revision = profile_event_prize_revisions.revision + 1,
    updated_at_ms = MAX(
      profile_event_prize_revisions.updated_at_ms,
      excluded.updated_at_ms
    );
END;
