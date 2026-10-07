ALTER TABLE event_progress_outboxes
ADD COLUMN next_reconcile_at_ms INTEGER NOT NULL DEFAULT 0
CHECK (next_reconcile_at_ms >= 0);

CREATE INDEX idx_event_progress_outboxes_reconcile
ON event_progress_outboxes (
  status, next_reconcile_at_ms, last_queued_at_ms, outbox_id
);

CREATE TRIGGER event_progress_outboxes_reset_reconciliation
AFTER UPDATE OF event_id, status, run_at_ms, last_queued_at_ms, record_json
ON event_progress_outboxes
WHEN OLD.event_id IS NOT NEW.event_id
  OR OLD.status IS NOT NEW.status
  OR OLD.run_at_ms IS NOT NEW.run_at_ms
  OR OLD.last_queued_at_ms IS NOT NEW.last_queued_at_ms
  OR OLD.record_json IS NOT NEW.record_json
BEGIN
  UPDATE event_progress_outboxes
  SET next_reconcile_at_ms = 0
  WHERE status = NEW.status AND outbox_id = NEW.outbox_id
    AND next_reconcile_at_ms != 0;
END;
