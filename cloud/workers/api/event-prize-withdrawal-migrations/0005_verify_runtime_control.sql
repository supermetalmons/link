CREATE TABLE event_prize_withdrawal_runtime_control_guard (
  verified_rows INTEGER NOT NULL CHECK (verified_rows = 1)
);

INSERT INTO event_prize_withdrawal_runtime_control_guard (verified_rows)
SELECT COUNT(*)
FROM event_prize_withdrawal_runtime_control
WHERE singleton = 1
  AND (
    (storage_mode = 'd1' AND previous_storage_mode IS NULL) OR
    (storage_mode = 'frozen' AND previous_storage_mode = 'd1')
  );

DROP TABLE event_prize_withdrawal_runtime_control_guard;
