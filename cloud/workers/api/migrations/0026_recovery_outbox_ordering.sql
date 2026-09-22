DROP INDEX idx_automatch_telegram_projection_due;

CREATE INDEX idx_automatch_telegram_projection_due
ON automatch_telegram_projection_outbox (
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

DROP INDEX idx_game_session_projection_due;

CREATE INDEX idx_game_session_projection_due
ON game_session_projection_outbox (
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
