CREATE TABLE telegram_messages_canonical (
  message_key TEXT PRIMARY KEY CHECK (length(message_key) > 0 AND trim(message_key) = message_key),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) = 'object' AND
    COALESCE(json_type(record_json, '$.schemaVersion') = 'integer' AND json_extract(record_json, '$.schemaVersion') = 1, 0) AND
    (json_type(record_json, '$.desired') IS NULL OR (json_type(record_json, '$.desired') = 'object' AND COALESCE(json_extract(record_json, '$.desired.schemaVersion') = 2, 0))) AND
    (json_type(record_json, '$.delivery') IS NULL OR (json_type(record_json, '$.delivery') = 'object' AND COALESCE(json_extract(record_json, '$.delivery.status') IN ('pending', 'processing', 'retryable', 'delivered', 'terminal', 'uncertain'), 0)))
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms > 0)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER telegram_messages_canonical_fields_insert
BEFORE INSERT ON telegram_messages_canonical
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.record_json)
    WHERE key NOT IN ('schemaVersion', 'desired', 'delivery', 'applied', 'manualRecovery', 'manualRecoveryResult', 'automatchProjection')
  ) THEN RAISE(ABORT, 'unknown-telegram-message-field') END;
END;
CREATE TRIGGER telegram_messages_canonical_fields_update
BEFORE UPDATE ON telegram_messages_canonical
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.record_json)
    WHERE key NOT IN ('schemaVersion', 'desired', 'delivery', 'applied', 'manualRecovery', 'manualRecoveryResult', 'automatchProjection')
  ) THEN RAISE(ABORT, 'unknown-telegram-message-field') END;
END;

CREATE TABLE telegram_delivery_control_canonical (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) = 'object' AND
    COALESCE(json_type(record_json, '$.schemaVersion') = 'integer' AND json_extract(record_json, '$.schemaVersion') = 1, 0) AND
    (json_type(record_json, '$.retryNotBeforeMs') IS NULL OR (json_type(record_json, '$.retryNotBeforeMs') = 'integer' AND json_extract(record_json, '$.retryNotBeforeMs') >= 0)) AND
    (json_type(record_json, '$.apiGate') IS NULL OR json_type(record_json, '$.apiGate') = 'object')
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms > 0)
) STRICT;
CREATE TRIGGER telegram_delivery_control_canonical_fields_insert
BEFORE INSERT ON telegram_delivery_control_canonical
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.record_json) WHERE key NOT IN ('schemaVersion', 'retryNotBeforeMs', 'apiGate')
  ) THEN RAISE(ABORT, 'unknown-telegram-control-field') END;
END;
CREATE TRIGGER telegram_delivery_control_canonical_fields_update
BEFORE UPDATE ON telegram_delivery_control_canonical
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.record_json) WHERE key NOT IN ('schemaVersion', 'retryNotBeforeMs', 'apiGate')
  ) THEN RAISE(ABORT, 'unknown-telegram-control-field') END;
END;

CREATE TABLE telegram_event_prize_announcements_canonical (
  request_id TEXT PRIMARY KEY CHECK (length(request_id) > 0 AND trim(request_id) = request_id),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  announcement_kind TEXT NOT NULL CHECK (announcement_kind IN ('prizes', 'reminder')),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) > 0),
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'retryable', 'terminal', 'uncertain', 'blocked')),
  message_ids_json TEXT CHECK (message_ids_json IS NULL OR (json_valid(message_ids_json) AND json_type(message_ids_json) = 'array' AND json_array_length(message_ids_json) > 0)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms > 0),
  event_id TEXT CHECK (event_id IS NULL OR (length(event_id) > 0 AND trim(event_id) = event_id)),
  start_at_ms INTEGER CHECK (start_at_ms IS NULL OR start_at_ms > 0),
  run_at_ms INTEGER CHECK (run_at_ms IS NULL OR run_at_ms > 0),
  first_queued_at_ms INTEGER CHECK (first_queued_at_ms IS NULL OR first_queued_at_ms > 0),
  payload_json TEXT CHECK (payload_json IS NULL OR (json_valid(payload_json) AND json_type(payload_json) = 'object')),
  attempt_id TEXT CHECK (attempt_id IS NULL OR (length(attempt_id) > 0 AND trim(attempt_id) = attempt_id)),
  attempt_count INTEGER CHECK (attempt_count IS NULL OR attempt_count > 0),
  retry_at_ms INTEGER CHECK (retry_at_ms IS NULL OR retry_at_ms > 0),
  error_code TEXT CHECK (error_code IS NULL OR (length(error_code) > 0 AND trim(error_code) = error_code)),
  CHECK ((status = 'sent') = (message_ids_json IS NOT NULL)),
  CHECK ((status = 'retryable') = (retry_at_ms IS NOT NULL)),
  CHECK (status <> 'retryable' OR event_id IS NOT NULL),
  CHECK ((event_id IS NULL) = (start_at_ms IS NULL)),
  CHECK ((event_id IS NULL) = (run_at_ms IS NULL)),
  CHECK ((event_id IS NULL) = (first_queued_at_ms IS NULL)),
  CHECK ((event_id IS NULL) = (payload_json IS NULL)),
  CHECK ((event_id IS NULL) = (attempt_id IS NULL)),
  CHECK ((event_id IS NULL) = (attempt_count IS NULL))
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX telegram_event_prize_announcements_canonical_event_kind
ON telegram_event_prize_announcements_canonical(event_id, announcement_kind) WHERE event_id IS NOT NULL;
CREATE TRIGGER telegram_announcements_canonical_receipt_immutable
BEFORE UPDATE ON telegram_event_prize_announcements_canonical
WHEN OLD.status = 'sent' AND (
  NEW.status IS NOT OLD.status OR NEW.request_id IS NOT OLD.request_id OR
  NEW.payload_digest IS NOT OLD.payload_digest OR NEW.message_ids_json IS NOT OLD.message_ids_json OR
  NEW.event_id IS NOT OLD.event_id OR NEW.announcement_kind IS NOT OLD.announcement_kind OR
  NEW.payload_json IS NOT OLD.payload_json OR NEW.attempt_id IS NOT OLD.attempt_id
)
BEGIN SELECT RAISE(ABORT, 'telegram-announcement-receipt-immutable'); END;
CREATE TRIGGER telegram_announcements_canonical_blocked
BEFORE UPDATE ON telegram_event_prize_announcements_canonical
WHEN OLD.status = 'blocked' AND NEW.status <> 'blocked'
BEGIN SELECT RAISE(ABORT, 'telegram-announcement-manual-review-required'); END;
CREATE TRIGGER telegram_announcements_canonical_message_ids_insert
BEFORE INSERT ON telegram_event_prize_announcements_canonical
WHEN NEW.message_ids_json IS NOT NULL
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.message_ids_json) WHERE type <> 'integer' OR value <= 0)
  THEN RAISE(ABORT, 'invalid-telegram-message-id') END;
END;
CREATE TRIGGER telegram_announcements_canonical_message_ids_update
BEFORE UPDATE ON telegram_event_prize_announcements_canonical
WHEN NEW.message_ids_json IS NOT NULL
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.message_ids_json) WHERE type <> 'integer' OR value <= 0)
  THEN RAISE(ABORT, 'invalid-telegram-message-id') END;
END;
