CREATE TABLE event_scheduled_recovery_cursor (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  start_at_ms INTEGER CHECK (start_at_ms IS NULL OR start_at_ms >= 0),
  event_id TEXT CHECK (event_id IS NULL OR event_id != ''),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK ((start_at_ms IS NULL) = (event_id IS NULL))
);

INSERT INTO event_scheduled_recovery_cursor (
  singleton, start_at_ms, event_id, revision, updated_at_ms
) VALUES (1, NULL, NULL, 0, 0);
