ALTER TABLE telegram_event_prize_announcements ADD COLUMN event_id TEXT;
ALTER TABLE telegram_event_prize_announcements ADD COLUMN start_at_ms INTEGER CHECK (start_at_ms IS NULL OR start_at_ms > 0);
ALTER TABLE telegram_event_prize_announcements ADD COLUMN run_at_ms INTEGER CHECK (run_at_ms IS NULL OR run_at_ms > 0);
ALTER TABLE telegram_event_prize_announcements ADD COLUMN first_queued_at_ms INTEGER CHECK (first_queued_at_ms IS NULL OR first_queued_at_ms > 0);
ALTER TABLE telegram_event_prize_announcements ADD COLUMN payload_json TEXT CHECK (payload_json IS NULL OR (json_valid(payload_json) AND json_type(payload_json) = 'object'));
ALTER TABLE telegram_event_prize_announcements ADD COLUMN attempt_id TEXT;
ALTER TABLE telegram_event_prize_announcements ADD COLUMN attempt_count INTEGER CHECK (attempt_count IS NULL OR attempt_count > 0);
ALTER TABLE telegram_event_prize_announcements ADD COLUMN retry_at_ms INTEGER CHECK (retry_at_ms IS NULL OR retry_at_ms > 0);
ALTER TABLE telegram_event_prize_announcements ADD COLUMN error_code TEXT;

CREATE UNIQUE INDEX telegram_event_prize_announcements_event
ON telegram_event_prize_announcements(event_id)
WHERE event_id IS NOT NULL;
