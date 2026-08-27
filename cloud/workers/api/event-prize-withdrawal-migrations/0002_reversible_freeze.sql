ALTER TABLE event_prize_withdrawal_runtime_control
ADD COLUMN previous_storage_mode TEXT CHECK (
  previous_storage_mode IS NULL OR
  previous_storage_mode IN ('firebase', 'd1')
);
