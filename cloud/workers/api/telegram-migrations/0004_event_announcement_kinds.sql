ALTER TABLE telegram_event_prize_announcements
ADD COLUMN announcement_kind TEXT NOT NULL DEFAULT 'prizes'
CHECK (announcement_kind IN ('prizes', 'reminder'));

DROP INDEX telegram_event_prize_announcements_event;

CREATE UNIQUE INDEX telegram_event_prize_announcements_event_kind
ON telegram_event_prize_announcements(event_id, announcement_kind)
WHERE event_id IS NOT NULL;
