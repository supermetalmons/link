CREATE TABLE event_prize_withdrawal_shadow_repairs (
  event_id TEXT NOT NULL,
  prize_id TEXT NOT NULL,
  record_json TEXT CHECK (
    record_json IS NULL OR
    (json_valid(record_json) AND json_type(record_json) = 'object')
  ),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms > 0),
  PRIMARY KEY (event_id, prize_id)
) WITHOUT ROWID;

INSERT INTO event_prize_withdrawal_shadow_repairs (
  event_id,
  prize_id,
  record_json,
  updated_at_ms
)
SELECT event_id, prize_id, record_json, updated_at_ms
FROM event_prize_withdrawals;

CREATE TRIGGER event_prize_withdrawal_shadow_insert
AFTER INSERT ON event_prize_withdrawals
BEGIN
  INSERT INTO event_prize_withdrawal_shadow_repairs (
    event_id, prize_id, record_json, updated_at_ms
  ) VALUES (
    NEW.event_id, NEW.prize_id, NEW.record_json, NEW.updated_at_ms
  )
  ON CONFLICT (event_id, prize_id) DO UPDATE SET
    record_json = excluded.record_json,
    updated_at_ms = excluded.updated_at_ms;
END;

CREATE TRIGGER event_prize_withdrawal_shadow_update
AFTER UPDATE ON event_prize_withdrawals
BEGIN
  INSERT INTO event_prize_withdrawal_shadow_repairs (
    event_id, prize_id, record_json, updated_at_ms
  ) VALUES (
    NEW.event_id, NEW.prize_id, NEW.record_json, NEW.updated_at_ms
  )
  ON CONFLICT (event_id, prize_id) DO UPDATE SET
    record_json = excluded.record_json,
    updated_at_ms = excluded.updated_at_ms;
END;

CREATE TRIGGER event_prize_withdrawal_shadow_delete
AFTER DELETE ON event_prize_withdrawals
BEGIN
  INSERT INTO event_prize_withdrawal_shadow_repairs (
    event_id, prize_id, record_json, updated_at_ms
  ) VALUES (
    OLD.event_id, OLD.prize_id, NULL, OLD.updated_at_ms
  )
  ON CONFLICT (event_id, prize_id) DO UPDATE SET
    record_json = NULL,
    updated_at_ms = excluded.updated_at_ms;
END;
