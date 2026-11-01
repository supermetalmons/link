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
