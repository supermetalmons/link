CREATE TABLE application_admission_retirements (
  operation_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation > 0),
  data_epoch INTEGER NOT NULL CHECK (data_epoch IN (0, 1)),
  retirement_id TEXT NOT NULL CHECK (length(retirement_id) BETWEEN 1 AND 128),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^a-f0-9]*'),
  original_row_json TEXT NOT NULL CHECK (json_valid(original_row_json)),
  original_row_digest TEXT NOT NULL CHECK (length(original_row_digest) = 64 AND original_row_digest NOT GLOB '*[^a-f0-9]*'),
  armed_at_ms INTEGER NOT NULL CHECK (armed_at_ms > 0),
  CHECK (json_extract(original_row_json, '$.operation_id') IS operation_id
    AND json_extract(original_row_json, '$.generation') IS generation
    AND json_extract(original_row_json, '$.data_epoch') IS data_epoch
    AND json_extract(original_row_json, '$.kind') IS 'http'
    AND json_extract(original_row_json, '$.status') IS 'running'
    AND json_type(original_row_json, '$.failure_code') IS 'null'
    AND json_type(original_row_json, '$.parent_operation_id') IS 'null')
) STRICT;
CREATE TRIGGER application_admission_retirement_insert_guard
BEFORE INSERT ON application_admission_retirements
WHEN EXISTS (SELECT 1 FROM application_admission_retirements old WHERE old.operation_id = NEW.operation_id
  AND (old.generation IS NOT NEW.generation OR old.data_epoch IS NOT NEW.data_epoch
    OR old.retirement_id IS NOT NEW.retirement_id OR old.manifest_digest IS NOT NEW.manifest_digest
    OR old.original_row_json IS NOT NEW.original_row_json OR old.original_row_digest IS NOT NEW.original_row_digest
    OR old.armed_at_ms IS NOT NEW.armed_at_ms))
BEGIN SELECT RAISE(ABORT, 'application-retirement-conflict'); END;
CREATE TRIGGER application_admission_retirement_update_guard
BEFORE UPDATE ON application_admission_retirements
BEGIN SELECT RAISE(ABORT, 'application-retirement-immutable'); END;
CREATE TRIGGER application_admission_retirement_delete_guard
BEFORE DELETE ON application_admission_retirements
BEGIN SELECT RAISE(ABORT, 'application-retirement-immutable'); END;
CREATE TRIGGER application_retired_write_context_guard
BEFORE INSERT ON application_write_context
WHEN EXISTS (SELECT 1 FROM application_admission_retirements retired
  WHERE retired.operation_id = NEW.operation_id AND retired.generation = NEW.generation AND retired.data_epoch = NEW.data_epoch)
BEGIN SELECT RAISE(ABORT, 'application-admission-retired'); END;
CREATE TABLE application_admission_retirement_guards (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
) STRICT;
CREATE TABLE application_admission_retirement_receipts (
  retirement_id TEXT PRIMARY KEY,
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^a-f0-9]*'),
  original_rows_json TEXT NOT NULL CHECK (json_valid(original_rows_json) AND json_type(original_rows_json) = 'array' AND json_array_length(original_rows_json) = 5),
  replica_proof_json TEXT NOT NULL CHECK (json_valid(replica_proof_json) AND json_type(replica_proof_json) = 'array' AND json_array_length(replica_proof_json) = 6),
  replica_proof_digest TEXT NOT NULL CHECK (length(replica_proof_digest) = 64 AND replica_proof_digest NOT GLOB '*[^a-f0-9]*'),
  outcome TEXT NOT NULL CHECK (outcome = 'application-write-authority-retired-outcome-unknown'),
  accepted_independent_work_preserved INTEGER NOT NULL CHECK (accepted_independent_work_preserved = 1),
  successful_completion_claimed INTEGER NOT NULL CHECK (successful_completion_claimed = 0),
  invocation_termination_claimed INTEGER NOT NULL CHECK (invocation_termination_claimed = 0),
  completed_at_ms INTEGER NOT NULL CHECK (completed_at_ms > 0)
) STRICT;
CREATE TRIGGER application_admission_retirement_receipt_insert_guard
BEFORE INSERT ON application_admission_retirement_receipts
WHEN EXISTS (SELECT 1 FROM application_admission_retirement_receipts old WHERE old.retirement_id = NEW.retirement_id
  AND (old.manifest_digest IS NOT NEW.manifest_digest OR old.original_rows_json IS NOT NEW.original_rows_json
    OR old.replica_proof_json IS NOT NEW.replica_proof_json OR old.replica_proof_digest IS NOT NEW.replica_proof_digest
    OR old.outcome IS NOT NEW.outcome OR old.accepted_independent_work_preserved IS NOT NEW.accepted_independent_work_preserved
    OR old.successful_completion_claimed IS NOT NEW.successful_completion_claimed OR old.invocation_termination_claimed IS NOT NEW.invocation_termination_claimed
    OR old.completed_at_ms IS NOT NEW.completed_at_ms))
BEGIN SELECT RAISE(ABORT, 'application-retirement-receipt-conflict'); END;
CREATE TRIGGER application_admission_retirement_receipt_update_guard
BEFORE UPDATE ON application_admission_retirement_receipts
BEGIN SELECT RAISE(ABORT, 'application-retirement-receipt-immutable'); END;
CREATE TRIGGER application_admission_retirement_receipt_delete_guard
BEFORE DELETE ON application_admission_retirement_receipts
BEGIN SELECT RAISE(ABORT, 'application-retirement-receipt-immutable'); END;
CREATE TRIGGER application_retired_admission_insert_guard
BEFORE INSERT ON application_data_admissions
WHEN EXISTS (SELECT 1 FROM application_admission_retirements retired
  WHERE retired.operation_id = NEW.operation_id OR retired.operation_id = NEW.parent_operation_id)
BEGIN SELECT RAISE(ABORT, 'application-admission-retired'); END;
CREATE TRIGGER application_retired_admission_update_guard
BEFORE UPDATE ON application_data_admissions
WHEN EXISTS (SELECT 1 FROM application_admission_retirements retired WHERE retired.operation_id = OLD.operation_id)
BEGIN SELECT RAISE(ABORT, 'application-retired-admission-immutable'); END;
CREATE TRIGGER application_retired_admission_delete_guard
BEFORE DELETE ON application_data_admissions
WHEN EXISTS (SELECT 1 FROM application_admission_retirements retired WHERE retired.operation_id = OLD.operation_id)
  AND NOT EXISTS (SELECT 1 FROM application_admission_retirements retired
    JOIN application_admission_retirement_receipts receipt ON receipt.retirement_id = retired.retirement_id
    WHERE retired.operation_id = OLD.operation_id AND receipt.manifest_digest = retired.manifest_digest
      AND EXISTS (SELECT 1 FROM json_each(receipt.original_rows_json) row
        WHERE json_extract(row.value, '$.operation_id') IS OLD.operation_id
          AND json_extract(row.value, '$.generation') IS OLD.generation
          AND json_extract(row.value, '$.data_epoch') IS OLD.data_epoch
          AND json_extract(row.value, '$.kind') IS OLD.kind
          AND json_extract(row.value, '$.started_at_ms') IS OLD.started_at_ms
          AND json_extract(row.value, '$.status') IS OLD.status
          AND json_extract(row.value, '$.failure_code') IS OLD.failure_code
          AND json_extract(row.value, '$.parent_operation_id') IS OLD.parent_operation_id))
BEGIN SELECT RAISE(ABORT, 'application-retirement-receipt-required'); END;
