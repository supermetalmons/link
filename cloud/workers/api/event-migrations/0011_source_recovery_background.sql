CREATE TABLE event_profile_game_projection_outboxes_recovery3 (
  event_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL CHECK (request_id != ''),
  status TEXT NOT NULL CHECK (status IN ('pending', 'dead')),
  last_queued_at_ms INTEGER NOT NULL CHECK (last_queued_at_ms >= 0),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) = 'object'
  ),
  FOREIGN KEY (event_id) REFERENCES event_records(event_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_event_profile_game_projection_outboxes_due_recovery3
ON event_profile_game_projection_outboxes_recovery3 (status, last_queued_at_ms, event_id);

CREATE TABLE event_telegram_projection_outboxes_recovery3 (
  event_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL CHECK (request_id != ''),
  status TEXT NOT NULL CHECK (status IN ('pending', 'dead')),
  first_queued_at_ms INTEGER NOT NULL CHECK (first_queued_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= first_queued_at_ms),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) = 'object'
  ),
  FOREIGN KEY (event_id) REFERENCES event_records(event_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_event_telegram_projection_outboxes_due_recovery3
ON event_telegram_projection_outboxes_recovery3 (status, updated_at_ms, event_id);

CREATE TABLE event_progress_outboxes_recovery3 (
  outbox_id TEXT NOT NULL CHECK (
    outbox_id != '' AND instr(outbox_id, '/') = 0
  ),
  event_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dead')),
  run_at_ms INTEGER CHECK (run_at_ms IS NULL OR run_at_ms >= 0),
  last_queued_at_ms INTEGER NOT NULL CHECK (last_queued_at_ms >= 0),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) = 'object'
  ), next_reconcile_at_ms INTEGER NOT NULL DEFAULT 0
CHECK (next_reconcile_at_ms >= 0),
  CHECK (status = 'dead' OR event_id IS NOT NULL),
  PRIMARY KEY (status, outbox_id),
  FOREIGN KEY (event_id) REFERENCES event_records(event_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TRIGGER event_progress_outboxes_reset_reconciliation_recovery3
AFTER UPDATE OF event_id, status, run_at_ms, last_queued_at_ms, record_json
ON event_progress_outboxes_recovery3
WHEN OLD.event_id IS NOT NEW.event_id
  OR OLD.status IS NOT NEW.status
  OR OLD.run_at_ms IS NOT NEW.run_at_ms
  OR OLD.last_queued_at_ms IS NOT NEW.last_queued_at_ms
  OR OLD.record_json IS NOT NEW.record_json
BEGIN
  UPDATE event_progress_outboxes_recovery3
  SET next_reconcile_at_ms = 0
  WHERE status = NEW.status AND outbox_id = NEW.outbox_id
    AND next_reconcile_at_ms != 0;
END;

CREATE INDEX idx_event_progress_outboxes_due_recovery3
ON event_progress_outboxes_recovery3 (status, last_queued_at_ms, outbox_id);

CREATE INDEX idx_event_progress_outboxes_event_recovery3
ON event_progress_outboxes_recovery3 (event_id, status, outbox_id);

CREATE INDEX idx_event_progress_outboxes_reconcile_recovery3
ON event_progress_outboxes_recovery3 (
  status, next_reconcile_at_ms, last_queued_at_ms, outbox_id
);
