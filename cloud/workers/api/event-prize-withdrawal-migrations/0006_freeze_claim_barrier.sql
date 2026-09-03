CREATE TRIGGER event_prize_withdrawals_reject_frozen_processing_insert
BEFORE INSERT ON event_prize_withdrawals
WHEN json_extract(NEW.record_json, '$.status') = 'processing'
AND EXISTS (
  SELECT 1
  FROM event_prize_withdrawal_runtime_control
  WHERE singleton = 1 AND storage_mode = 'frozen'
)
AND NOT EXISTS (
  SELECT 1
  FROM event_prize_withdrawals AS current
  WHERE current.event_id = NEW.event_id
    AND current.prize_id = NEW.prize_id
    AND json_extract(current.record_json, '$.status') = 'processing'
    AND json_type(current.record_json, '$.leaseId') = 'text'
    AND length(json_extract(current.record_json, '$.leaseId')) > 0
    AND json_extract(NEW.record_json, '$.leaseId')
      IS json_extract(current.record_json, '$.leaseId')
)
BEGIN
  SELECT RAISE(ABORT, 'event prize withdrawal storage is frozen');
END;

CREATE TRIGGER event_prize_withdrawals_reject_frozen_lease_update
BEFORE UPDATE OF record_json ON event_prize_withdrawals
WHEN json_extract(NEW.record_json, '$.status') IN ('processing', 'submitted')
AND EXISTS (
  SELECT 1
  FROM event_prize_withdrawal_runtime_control
  WHERE singleton = 1 AND storage_mode = 'frozen'
)
AND NOT COALESCE(
  (
    (
      json_extract(OLD.record_json, '$.status') = 'processing'
      AND json_extract(NEW.record_json, '$.status') IN ('processing', 'submitted')
    )
    OR (
      json_extract(OLD.record_json, '$.status') = 'submitted'
      AND json_extract(NEW.record_json, '$.status') = 'submitted'
    )
  )
    AND json_type(OLD.record_json, '$.leaseId') = 'text'
    AND length(json_extract(OLD.record_json, '$.leaseId')) > 0
    AND json_extract(NEW.record_json, '$.leaseId')
      IS json_extract(OLD.record_json, '$.leaseId'),
  0
)
BEGIN
  SELECT RAISE(ABORT, 'event prize withdrawal storage is frozen');
END;
