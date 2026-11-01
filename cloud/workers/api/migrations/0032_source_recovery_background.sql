CREATE TABLE game_session_projection_outbox_recovery3 (
  record_key TEXT PRIMARY KEY NOT NULL CHECK (record_key != '' AND instr(record_key, '/') = 0),
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
, recovery_sort_rank INTEGER GENERATED ALWAYS AS (
  CASE json_type(payload_json, '$.lastQueuedAtMs')
    WHEN 'false' THEN 1 WHEN 'true' THEN 2
    WHEN 'integer' THEN 3 WHEN 'real' THEN 3 WHEN 'text' THEN 4
    WHEN 'array' THEN 5 WHEN 'object' THEN 5 ELSE 0
  END
) VIRTUAL, recovery_sort_value GENERATED ALWAYS AS (
  CASE WHEN recovery_sort_rank IN (3, 4)
    THEN json_extract(payload_json, '$.lastQueuedAtMs') END
) VIRTUAL, recovery_key_integer INTEGER GENERATED ALWAYS AS (
  CASE WHEN length((CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END)) BETWEEN 1 AND 10
    AND (CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END) NOT GLOB '*[^0-9]*'
    AND CAST(record_key AS INTEGER) BETWEEN -2147483648 AND 2147483647
    THEN CAST(record_key AS INTEGER) END
) VIRTUAL, recovery_key_rank INTEGER GENERATED ALWAYS AS (
  CASE WHEN recovery_key_integer IS NULL THEN 1 ELSE 0 END
) VIRTUAL, recovery_key_length INTEGER GENERATED ALWAYS AS (
  CASE WHEN recovery_key_integer IS NOT NULL THEN length(record_key) ELSE 0 END
) VIRTUAL) WITHOUT ROWID;

CREATE INDEX idx_game_session_projection_due_recovery3
ON game_session_projection_outbox_recovery3 (
  json_extract(payload_json, '$.lastQueuedAtMs'),
  CASE WHEN (CASE WHEN length((CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END)) BETWEEN 1 AND 10 AND (CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END) NOT GLOB '*[^0-9]*'
    AND CAST(record_key AS INTEGER) BETWEEN -2147483648 AND 2147483647
    THEN CAST(record_key AS INTEGER) END) IS NULL THEN 1 ELSE 0 END,
  (CASE WHEN length((CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END)) BETWEEN 1 AND 10 AND (CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END) NOT GLOB '*[^0-9]*'
    AND CAST(record_key AS INTEGER) BETWEEN -2147483648 AND 2147483647
    THEN CAST(record_key AS INTEGER) END),
  CASE WHEN (CASE WHEN length((CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END)) BETWEEN 1 AND 10 AND (CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END) NOT GLOB '*[^0-9]*'
    AND CAST(record_key AS INTEGER) BETWEEN -2147483648 AND 2147483647
    THEN CAST(record_key AS INTEGER) END) IS NOT NULL THEN length(record_key) ELSE 0 END,
  record_key COLLATE BINARY
)
WHERE payload_json IS NOT NULL;

CREATE INDEX idx_game_session_projection_recovery_recovery3
ON game_session_projection_outbox_recovery3 (
  recovery_sort_rank, recovery_sort_value,
  recovery_key_rank, recovery_key_integer, recovery_key_length,
  record_key COLLATE BINARY
)
WHERE payload_json IS NOT NULL;

CREATE TABLE automatch_telegram_projection_outbox_recovery3 (
  record_key TEXT PRIMARY KEY NOT NULL CHECK (record_key != '' AND instr(record_key, '/') = 0),
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
, recovery_sort_rank INTEGER GENERATED ALWAYS AS (
  CASE json_type(payload_json, '$.updatedAtMs')
    WHEN 'false' THEN 1 WHEN 'true' THEN 2
    WHEN 'integer' THEN 3 WHEN 'real' THEN 3 WHEN 'text' THEN 4
    WHEN 'array' THEN 5 WHEN 'object' THEN 5 ELSE 0
  END
) VIRTUAL, recovery_sort_value GENERATED ALWAYS AS (
  CASE WHEN recovery_sort_rank IN (3, 4)
    THEN json_extract(payload_json, '$.updatedAtMs') END
) VIRTUAL, recovery_key_integer INTEGER GENERATED ALWAYS AS (
  CASE WHEN length((CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END)) BETWEEN 1 AND 10
    AND (CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END) NOT GLOB '*[^0-9]*'
    AND CAST(record_key AS INTEGER) BETWEEN -2147483648 AND 2147483647
    THEN CAST(record_key AS INTEGER) END
) VIRTUAL, recovery_key_rank INTEGER GENERATED ALWAYS AS (
  CASE WHEN recovery_key_integer IS NULL THEN 1 ELSE 0 END
) VIRTUAL, recovery_key_length INTEGER GENERATED ALWAYS AS (
  CASE WHEN recovery_key_integer IS NOT NULL THEN length(record_key) ELSE 0 END
) VIRTUAL) WITHOUT ROWID;

CREATE INDEX idx_automatch_telegram_projection_due_recovery3
ON automatch_telegram_projection_outbox_recovery3 (
  json_extract(payload_json, '$.updatedAtMs'),
  CASE WHEN (CASE WHEN length((CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END)) BETWEEN 1 AND 10 AND (CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END) NOT GLOB '*[^0-9]*'
    AND CAST(record_key AS INTEGER) BETWEEN -2147483648 AND 2147483647
    THEN CAST(record_key AS INTEGER) END) IS NULL THEN 1 ELSE 0 END,
  (CASE WHEN length((CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END)) BETWEEN 1 AND 10 AND (CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END) NOT GLOB '*[^0-9]*'
    AND CAST(record_key AS INTEGER) BETWEEN -2147483648 AND 2147483647
    THEN CAST(record_key AS INTEGER) END),
  CASE WHEN (CASE WHEN length((CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END)) BETWEEN 1 AND 10 AND (CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END) NOT GLOB '*[^0-9]*'
    AND CAST(record_key AS INTEGER) BETWEEN -2147483648 AND 2147483647
    THEN CAST(record_key AS INTEGER) END) IS NOT NULL THEN length(record_key) ELSE 0 END,
  record_key COLLATE BINARY
)
WHERE payload_json IS NOT NULL;

CREATE INDEX idx_automatch_telegram_projection_recovery_recovery3
ON automatch_telegram_projection_outbox_recovery3 (
  recovery_sort_rank, recovery_sort_value,
  recovery_key_rank, recovery_key_integer, recovery_key_length,
  record_key COLLATE BINARY
)
WHERE payload_json IS NOT NULL;
