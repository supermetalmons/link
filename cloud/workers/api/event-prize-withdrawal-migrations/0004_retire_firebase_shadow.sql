DROP TRIGGER event_prize_withdrawal_shadow_insert;
DROP TRIGGER event_prize_withdrawal_shadow_update;
DROP TRIGGER event_prize_withdrawal_shadow_delete;

DROP TABLE event_prize_withdrawal_shadow_repairs;

CREATE TABLE event_prize_withdrawal_runtime_control_next (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  storage_mode TEXT NOT NULL CHECK (
    storage_mode IN ('frozen', 'd1')
  ),
  source_digest TEXT,
  source_record_count INTEGER CHECK (
    source_record_count IS NULL OR source_record_count >= 0
  ),
  source_exported_at_ms INTEGER CHECK (
    source_exported_at_ms IS NULL OR source_exported_at_ms > 0
  ),
  cutover_at_ms INTEGER CHECK (cutover_at_ms IS NULL OR cutover_at_ms > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms > 0),
  previous_storage_mode TEXT CHECK (
    previous_storage_mode IS NULL OR previous_storage_mode = 'd1'
  ),
  CHECK (
    (storage_mode = 'd1' AND previous_storage_mode IS NULL) OR
    (storage_mode = 'frozen' AND previous_storage_mode = 'd1')
  )
);

INSERT INTO event_prize_withdrawal_runtime_control_next (
  singleton,
  storage_mode,
  source_digest,
  source_record_count,
  source_exported_at_ms,
  cutover_at_ms,
  updated_at_ms,
  previous_storage_mode
)
SELECT
  singleton,
  CASE
    WHEN storage_mode = 'frozen' AND previous_storage_mode = 'd1'
      THEN 'frozen'
    WHEN storage_mode = 'd1' AND previous_storage_mode IS NULL
      THEN 'd1'
    WHEN storage_mode = 'firebase' AND previous_storage_mode IS NULL
      AND source_digest IS NULL
      AND source_record_count IS NULL
      AND source_exported_at_ms IS NULL
      AND cutover_at_ms IS NULL
      AND updated_at_ms = 1
      AND NOT EXISTS (SELECT 1 FROM event_prize_withdrawals)
      THEN 'd1'
    ELSE 'invalid'
  END,
  source_digest,
  source_record_count,
  source_exported_at_ms,
  cutover_at_ms,
  updated_at_ms,
  CASE
    WHEN storage_mode = 'frozen' AND previous_storage_mode = 'd1'
      THEN 'd1'
    ELSE NULL
  END
FROM event_prize_withdrawal_runtime_control
WHERE singleton = 1;

CREATE TABLE event_prize_withdrawal_runtime_control_guard (
  copied_rows INTEGER NOT NULL CHECK (copied_rows = 1)
);

INSERT INTO event_prize_withdrawal_runtime_control_guard (copied_rows)
SELECT COUNT(*) FROM event_prize_withdrawal_runtime_control_next;

DROP TABLE event_prize_withdrawal_runtime_control_guard;
DROP TABLE event_prize_withdrawal_runtime_control;
ALTER TABLE event_prize_withdrawal_runtime_control_next
RENAME TO event_prize_withdrawal_runtime_control;
