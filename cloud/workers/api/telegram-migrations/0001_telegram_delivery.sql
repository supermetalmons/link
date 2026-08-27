CREATE TABLE telegram_messages (
  message_key TEXT PRIMARY KEY,
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) = 'object'
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms > 0)
) WITHOUT ROWID;

CREATE TABLE telegram_delivery_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) = 'object'
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms > 0)
);

INSERT INTO telegram_delivery_control (
  singleton,
  record_json,
  version,
  updated_at_ms
) VALUES (1, '{}', 1, 1);

CREATE TABLE telegram_event_prize_announcements (
  request_id TEXT PRIMARY KEY,
  payload_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('sending', 'sent', 'missing', 'retryable', 'terminal', 'uncertain')
  ),
  message_ids_json TEXT CHECK (
    message_ids_json IS NULL OR json_valid(message_ids_json)
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms > 0)
) WITHOUT ROWID;

CREATE TABLE telegram_runtime_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  storage_mode TEXT NOT NULL CHECK (
    storage_mode IN ('firebase', 'frozen', 'd1')
  ),
  source_digest TEXT,
  source_message_count INTEGER CHECK (
    source_message_count IS NULL OR source_message_count >= 0
  ),
  source_announcement_count INTEGER CHECK (
    source_announcement_count IS NULL OR source_announcement_count >= 0
  ),
  source_exported_at_ms INTEGER CHECK (
    source_exported_at_ms IS NULL OR source_exported_at_ms > 0
  ),
  cutover_at_ms INTEGER CHECK (cutover_at_ms IS NULL OR cutover_at_ms > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms > 0)
);

INSERT INTO telegram_runtime_control (
  singleton,
  storage_mode,
  updated_at_ms
) VALUES (1, 'firebase', 1);
