CREATE TABLE event_prize_withdrawals_canonical (
  event_id TEXT NOT NULL CHECK (event_id != '' AND instr(event_id, '/') = 0),
  prize_id TEXT NOT NULL CHECK (prize_id != '' AND instr(prize_id, '/') = 0),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) IS 'object'
    AND json_extract(record_json, '$.schemaVersion') IS 1
    AND json_extract(record_json, '$.eventId') IS event_id
    AND json_extract(record_json, '$.prizeId') IS prize_id
    AND json_type(record_json, '$.assetAddress') IS 'text'
    AND json_type(record_json, '$.assetStandard') IS 'text'
    AND json_extract(record_json, '$.assetStandard') IN ('core', 'compressed')
    AND json_type(record_json, '$.profileId') IS 'text'
    AND json_type(record_json, '$.entitledProfileId') IS 'text'
    AND json_type(record_json, '$.requesterUid') IS 'text'
    AND json_type(record_json, '$.recipientAddress') IS 'text'
    AND json_type(record_json, '$.place') IS 'integer'
    AND json_extract(record_json, '$.place') IN (1, 2, 3)
    AND json_type(record_json, '$.startedAtMs') IS 'integer'
    AND json_type(record_json, '$.updatedAtMs') IS 'integer'
    AND json_extract(record_json, '$.startedAtMs') BETWEEN 0 AND 9007199254740991
    AND json_extract(record_json, '$.updatedAtMs') BETWEEN json_extract(record_json, '$.startedAtMs') AND 9007199254740991
    AND (json_type(record_json, '$.leaseId') IS 'text' OR json_type(record_json, '$.leaseId') IS 'null')
    AND (json_type(record_json, '$.leaseExpiresAtMs') IS 'integer' OR json_type(record_json, '$.leaseExpiresAtMs') IS 'null')
    AND (json_type(record_json, '$.transactionSignature') IS 'text' OR json_type(record_json, '$.transactionSignature') IS 'null')
    AND (json_type(record_json, '$.signedTransactionBase64') IS 'text' OR json_type(record_json, '$.signedTransactionBase64') IS 'null')
    AND (json_type(record_json, '$.blockhash') IS 'text' OR json_type(record_json, '$.blockhash') IS 'null')
    AND (json_type(record_json, '$.lastValidBlockHeight') IS 'integer' OR json_type(record_json, '$.lastValidBlockHeight') IS 'null')
    AND (json_type(record_json, '$.submittedAtMs') IS 'integer' OR json_type(record_json, '$.submittedAtMs') IS 'null')
    AND (json_type(record_json, '$.completedAtMs') IS 'integer' OR json_type(record_json, '$.completedAtMs') IS 'null')
    AND (json_type(record_json, '$.observedOwner') IS 'text' OR json_type(record_json, '$.observedOwner') IS 'null')
    AND (json_type(record_json, '$.blockReason') IS 'text' OR json_type(record_json, '$.blockReason') IS 'null')
    AND (json_type(record_json, '$.blockedAtMs') IS 'integer' OR json_type(record_json, '$.blockedAtMs') IS 'null')
    AND (json_type(record_json, '$.sourceDigest') IS 'text' OR json_type(record_json, '$.sourceDigest') IS 'null')
    AND (json_type(record_json, '$.submittedAtMs') IS 'null' OR json_extract(record_json, '$.submittedAtMs') BETWEEN json_extract(record_json, '$.startedAtMs') AND json_extract(record_json, '$.updatedAtMs'))
    AND (json_type(record_json, '$.completedAtMs') IS 'null' OR json_extract(record_json, '$.completedAtMs') BETWEEN json_extract(record_json, '$.startedAtMs') AND json_extract(record_json, '$.updatedAtMs'))
    AND (json_type(record_json, '$.blockedAtMs') IS 'null' OR json_extract(record_json, '$.blockedAtMs') BETWEEN json_extract(record_json, '$.startedAtMs') AND json_extract(record_json, '$.updatedAtMs'))
    AND json_remove(record_json, '$.schemaVersion', '$.eventId', '$.prizeId', '$.assetAddress', '$.assetStandard', '$.entitledProfileId', '$.profileId', '$.place', '$.recipientAddress', '$.requesterUid', '$.startedAtMs', '$.updatedAtMs', '$.status', '$.leaseId', '$.leaseExpiresAtMs', '$.transactionSignature', '$.signedTransactionBase64', '$.blockhash', '$.lastValidBlockHeight', '$.submittedAtMs', '$.completedAtMs', '$.observedOwner', '$.blockReason', '$.blockedAtMs', '$.sourceDigest') = '{}'
    AND ((json_extract(record_json, '$.status') IS 'processing'
      AND json_type(record_json, '$.leaseId') IS 'text'
      AND json_type(record_json, '$.leaseExpiresAtMs') IS 'integer'
      AND json_type(record_json, '$.transactionSignature') IS 'null'
      AND json_type(record_json, '$.signedTransactionBase64') IS 'null'
      AND json_type(record_json, '$.blockhash') IS 'null'
      AND json_type(record_json, '$.lastValidBlockHeight') IS 'null'
      AND json_type(record_json, '$.submittedAtMs') IS 'null'
      AND json_type(record_json, '$.completedAtMs') IS 'null')
    OR (json_extract(record_json, '$.status') IS 'submitted'
      AND json_type(record_json, '$.leaseId') IS 'text'
      AND json_type(record_json, '$.leaseExpiresAtMs') IS 'integer'
      AND json_type(record_json, '$.transactionSignature') IS 'text'
      AND json_type(record_json, '$.signedTransactionBase64') IS 'text'
      AND json_type(record_json, '$.blockhash') IS 'text'
      AND json_type(record_json, '$.lastValidBlockHeight') IS 'integer'
      AND json_type(record_json, '$.submittedAtMs') IS 'integer'
      AND json_type(record_json, '$.completedAtMs') IS 'null')
    OR (json_extract(record_json, '$.status') IS 'completed'
      AND json_type(record_json, '$.leaseId') IS 'null'
      AND json_type(record_json, '$.leaseExpiresAtMs') IS 'null'
      AND json_type(record_json, '$.transactionSignature') IS 'text'
      AND json_type(record_json, '$.submittedAtMs') IS 'integer'
      AND json_type(record_json, '$.completedAtMs') IS 'integer')
    OR (json_extract(record_json, '$.status') IS 'blocked'
      AND json_type(record_json, '$.leaseId') IS 'null'
      AND json_type(record_json, '$.leaseExpiresAtMs') IS 'null'
      AND json_type(record_json, '$.completedAtMs') IS 'null'
      AND json_type(record_json, '$.blockedAtMs') IS 'integer'
      AND json_type(record_json, '$.blockReason') IS 'text'
      AND json_extract(record_json, '$.blockReason') IN ('asset-owner-mismatch', 'canonical-data-cutover')))
    AND (json_extract(record_json, '$.status') = 'blocked' OR (
      json_type(record_json, '$.observedOwner') IS 'null'
      AND json_type(record_json, '$.blockReason') IS 'null'
      AND json_type(record_json, '$.blockedAtMs') IS 'null'
      AND json_type(record_json, '$.sourceDigest') IS 'null'))
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (event_id, prize_id),
  CHECK (json_extract(record_json, '$.updatedAtMs') IS updated_at_ms)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER event_prize_withdrawals_completed_identity_canonical
BEFORE UPDATE ON event_prize_withdrawals_canonical
WHEN json_extract(OLD.record_json, '$.status') = 'completed' AND (
  json_extract(NEW.record_json, '$.status') IS NOT 'completed'
  OR json_extract(NEW.record_json, '$.assetAddress') IS NOT json_extract(OLD.record_json, '$.assetAddress')
  OR json_extract(NEW.record_json, '$.assetStandard') IS NOT json_extract(OLD.record_json, '$.assetStandard')
  OR json_extract(NEW.record_json, '$.recipientAddress') IS NOT json_extract(OLD.record_json, '$.recipientAddress')
  OR json_extract(NEW.record_json, '$.transactionSignature') IS NOT json_extract(OLD.record_json, '$.transactionSignature')
)
BEGIN
  SELECT RAISE(ABORT, 'completed withdrawal evidence is immutable');
END;

CREATE TRIGGER event_prize_withdrawals_completed_delete_canonical
BEFORE DELETE ON event_prize_withdrawals_canonical
WHEN json_extract(OLD.record_json, '$.status') = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'completed withdrawal evidence is permanent');
END;

CREATE TRIGGER event_prize_withdrawals_blocked_replay_canonical
BEFORE UPDATE ON event_prize_withdrawals_canonical
WHEN json_extract(OLD.record_json, '$.blockReason') = 'canonical-data-cutover'
  AND json_extract(NEW.record_json, '$.status') IS NOT 'blocked'
BEGIN
  SELECT RAISE(ABORT, 'migrated withdrawal requires manual review');
END;

CREATE TRIGGER event_prize_withdrawals_reject_frozen_processing_insert_canonical
BEFORE INSERT ON event_prize_withdrawals_canonical
WHEN json_extract(NEW.record_json, '$.status') = 'processing'
AND EXISTS (
  SELECT 1
  FROM event_prize_withdrawal_runtime_control
  WHERE singleton = 1 AND storage_mode = 'frozen'
)
AND NOT EXISTS (
  SELECT 1
  FROM event_prize_withdrawals_canonical AS current
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

CREATE TRIGGER event_prize_withdrawals_reject_frozen_lease_update_canonical
BEFORE UPDATE OF record_json ON event_prize_withdrawals_canonical
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
