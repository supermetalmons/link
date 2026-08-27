CREATE TABLE event_prize_withdrawals (
  event_id TEXT NOT NULL,
  prize_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) = 'object'
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms > 0),
  PRIMARY KEY (event_id, prize_id)
) WITHOUT ROWID;

CREATE TABLE event_prize_withdrawal_runtime_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  storage_mode TEXT NOT NULL CHECK (
    storage_mode IN ('firebase', 'frozen', 'd1')
  ),
  source_digest TEXT,
  source_record_count INTEGER CHECK (
    source_record_count IS NULL OR source_record_count >= 0
  ),
  source_exported_at_ms INTEGER CHECK (
    source_exported_at_ms IS NULL OR source_exported_at_ms > 0
  ),
  cutover_at_ms INTEGER CHECK (cutover_at_ms IS NULL OR cutover_at_ms > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms > 0)
);

INSERT INTO event_prize_withdrawal_runtime_control (
  singleton,
  storage_mode,
  updated_at_ms
) VALUES (1, 'firebase', 1);
