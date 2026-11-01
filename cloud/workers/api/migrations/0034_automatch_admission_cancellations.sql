CREATE TABLE automatch_admission_cancellations (
  admission_table TEXT NOT NULL CHECK (admission_table IN ('automatch_write_admissions', 'invite_source_write_admissions')),
  admission_id TEXT NOT NULL CHECK (length(admission_id) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL CHECK (length(operation_id) = 36),
  original_row_json TEXT NOT NULL CHECK (json_valid(original_row_json) AND json_type(original_row_json) = 'object'),
  original_row_digest TEXT NOT NULL CHECK (length(original_row_digest) = 64 AND original_row_digest NOT GLOB '*[^a-f0-9]*'),
  controls_json TEXT NOT NULL CHECK (json_valid(controls_json) AND json_type(controls_json) = 'object'),
  plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^a-f0-9]*'),
  source_audit_digest TEXT NOT NULL CHECK (length(source_audit_digest) = 64 AND source_audit_digest NOT GLOB '*[^a-f0-9]*'),
  historical_review_digest TEXT NOT NULL CHECK (length(historical_review_digest) = 64 AND historical_review_digest NOT GLOB '*[^a-f0-9]*'),
  revoked_at_ms INTEGER NOT NULL CHECK (revoked_at_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome = 'write-authority-revoked'),
  historical_outcome TEXT NOT NULL CHECK (historical_outcome = 'unknown-preserved'),
  PRIMARY KEY (admission_table, admission_id),
  CHECK (json_extract(original_row_json, '$.admission_id') IS admission_id),
  CHECK (json_extract(original_row_json, '$.backend') IS 'd1'),
  CHECK (json_extract(original_row_json, '$.kind') IN ('automatch-persistence-transaction', 'automatch-persistence-patch', 'session-receipt-expiry')),
  CHECK (revoked_at_ms >= json_extract(original_row_json, '$.created_at_ms')),
  CHECK (admission_table != 'automatch_write_admissions' OR (
    json_extract(original_row_json, '$.phase') IS 'prepared' AND
    json_type(original_row_json, '$.proof_json') IS 'null' AND
    json_extract(original_row_json, '$.audit_revision') IS 0 AND
    json_extract(original_row_json, '$.updated_at_ms') IS 0 AND
    json_type(original_row_json, '$.completed_at_ms') IS 'null'
  ))
) STRICT, WITHOUT ROWID;

CREATE TRIGGER automatch_cancellation_immutable_update
BEFORE UPDATE ON automatch_admission_cancellations
BEGIN SELECT RAISE(ABORT, 'admission-cancellation-immutable'); END;
CREATE TRIGGER automatch_cancellation_immutable_delete
BEFORE DELETE ON automatch_admission_cancellations
BEGIN SELECT RAISE(ABORT, 'admission-cancellation-immutable'); END;
CREATE TRIGGER automatch_cancellation_conflict
BEFORE INSERT ON automatch_admission_cancellations
WHEN EXISTS (
  SELECT 1 FROM automatch_admission_cancellations old
  WHERE old.admission_table = NEW.admission_table AND old.admission_id = NEW.admission_id
    AND (old.operation_id IS NOT NEW.operation_id
      OR old.original_row_json IS NOT NEW.original_row_json
      OR old.original_row_digest IS NOT NEW.original_row_digest
      OR old.controls_json IS NOT NEW.controls_json
      OR old.plan_digest IS NOT NEW.plan_digest
      OR old.source_audit_digest IS NOT NEW.source_audit_digest
      OR old.historical_review_digest IS NOT NEW.historical_review_digest
      OR old.revoked_at_ms IS NOT NEW.revoked_at_ms
      OR old.outcome IS NOT NEW.outcome
      OR old.historical_outcome IS NOT NEW.historical_outcome)
)
BEGIN SELECT RAISE(ABORT, 'admission-cancellation-conflict'); END;

CREATE TRIGGER automatch_cancellation_source_guard
BEFORE INSERT ON automatch_admission_cancellations
WHEN NOT EXISTS (
  SELECT 1 FROM automatch_admission_cancellations
  WHERE admission_table = NEW.admission_table AND admission_id = NEW.admission_id
)
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM application_data_control
    WHERE singleton = 1 AND generation = 1 AND data_epoch = 0 AND phase = 'active' AND migration_id IS NULL
  ) THEN 1 ELSE RAISE(ABORT, 'cancellation-source-generation-changed') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM application_data_control) = 1 AND EXISTS (
    SELECT 1 FROM application_data_control c
    WHERE c.singleton IS json_extract(NEW.controls_json, '$.application_data_control.singleton')
        AND c.generation IS json_extract(NEW.controls_json, '$.application_data_control.generation')
        AND c.data_epoch IS json_extract(NEW.controls_json, '$.application_data_control.data_epoch')
        AND c.phase IS json_extract(NEW.controls_json, '$.application_data_control.phase')
        AND c.migration_id IS json_extract(NEW.controls_json, '$.application_data_control.migration_id')
  ) THEN 1 ELSE RAISE(ABORT, 'cancellation-control-changed') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM automatch_runtime_control) = 1 AND EXISTS (
    SELECT 1 FROM automatch_runtime_control c
    WHERE c.singleton IS json_extract(NEW.controls_json, '$.automatch_runtime_control.singleton')
        AND c.backend IS json_extract(NEW.controls_json, '$.automatch_runtime_control.backend')
        AND c.state IS json_extract(NEW.controls_json, '$.automatch_runtime_control.state')
        AND c.epoch IS json_extract(NEW.controls_json, '$.automatch_runtime_control.epoch')
        AND c.freeze_generation IS json_extract(NEW.controls_json, '$.automatch_runtime_control.freeze_generation')
        AND c.staged_at_ms IS json_extract(NEW.controls_json, '$.automatch_runtime_control.staged_at_ms')
        AND c.candidate_version_id IS json_extract(NEW.controls_json, '$.automatch_runtime_control.candidate_version_id')
        AND c.imported_at_ms IS json_extract(NEW.controls_json, '$.automatch_runtime_control.imported_at_ms')
        AND c.source_digest IS json_extract(NEW.controls_json, '$.automatch_runtime_control.source_digest')
        AND c.import_digest IS json_extract(NEW.controls_json, '$.automatch_runtime_control.import_digest')
        AND c.activated_at_ms IS json_extract(NEW.controls_json, '$.automatch_runtime_control.activated_at_ms')
        AND c.metadata_json IS json_extract(NEW.controls_json, '$.automatch_runtime_control.metadata_json')
  ) THEN 1 ELSE RAISE(ABORT, 'cancellation-control-changed') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM invite_source_control) = 1 AND EXISTS (
    SELECT 1 FROM invite_source_control c
    WHERE c.singleton IS json_extract(NEW.controls_json, '$.invite_source_control.singleton')
        AND c.backend IS json_extract(NEW.controls_json, '$.invite_source_control.backend')
        AND c.state IS json_extract(NEW.controls_json, '$.invite_source_control.state')
        AND c.epoch IS json_extract(NEW.controls_json, '$.invite_source_control.epoch')
        AND c.freeze_generation IS json_extract(NEW.controls_json, '$.invite_source_control.freeze_generation')
        AND c.candidate_version_id IS json_extract(NEW.controls_json, '$.invite_source_control.candidate_version_id')
        AND c.source_digest IS json_extract(NEW.controls_json, '$.invite_source_control.source_digest')
        AND c.import_digest IS json_extract(NEW.controls_json, '$.invite_source_control.import_digest')
        AND c.verified_at_ms IS json_extract(NEW.controls_json, '$.invite_source_control.verified_at_ms')
        AND c.activated_at_ms IS json_extract(NEW.controls_json, '$.invite_source_control.activated_at_ms')
        AND c.metadata_json IS json_extract(NEW.controls_json, '$.invite_source_control.metadata_json')
  ) THEN 1 ELSE RAISE(ABORT, 'cancellation-control-changed') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM match_state_control) = 1 AND EXISTS (
    SELECT 1 FROM match_state_control c
    WHERE c.singleton IS json_extract(NEW.controls_json, '$.match_state_control.singleton')
        AND c.backend IS json_extract(NEW.controls_json, '$.match_state_control.backend')
        AND c.state IS json_extract(NEW.controls_json, '$.match_state_control.state')
        AND c.epoch IS json_extract(NEW.controls_json, '$.match_state_control.epoch')
        AND c.freeze_generation IS json_extract(NEW.controls_json, '$.match_state_control.freeze_generation')
        AND c.frozen_at_ms IS json_extract(NEW.controls_json, '$.match_state_control.frozen_at_ms')
        AND c.candidate_version_id IS json_extract(NEW.controls_json, '$.match_state_control.candidate_version_id')
        AND c.import_id IS json_extract(NEW.controls_json, '$.match_state_control.import_id')
        AND c.source_digest IS json_extract(NEW.controls_json, '$.match_state_control.source_digest')
        AND c.source_record_count IS json_extract(NEW.controls_json, '$.match_state_control.source_record_count')
        AND c.source_claim_count IS json_extract(NEW.controls_json, '$.match_state_control.source_claim_count')
        AND c.source_bundle_count IS json_extract(NEW.controls_json, '$.match_state_control.source_bundle_count')
        AND c.fence_digest IS json_extract(NEW.controls_json, '$.match_state_control.fence_digest')
        AND c.verified_digest IS json_extract(NEW.controls_json, '$.match_state_control.verified_digest')
        AND c.verified_at_ms IS json_extract(NEW.controls_json, '$.match_state_control.verified_at_ms')
        AND c.activated_at_ms IS json_extract(NEW.controls_json, '$.match_state_control.activated_at_ms')
        AND c.updated_at_ms IS json_extract(NEW.controls_json, '$.match_state_control.updated_at_ms')
  ) THEN 1 ELSE RAISE(ABORT, 'cancellation-control-changed') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM match_presentation_control) = 1 AND EXISTS (
    SELECT 1 FROM match_presentation_control c
    WHERE c.singleton IS json_extract(NEW.controls_json, '$.match_presentation_control.singleton')
        AND c.phase IS json_extract(NEW.controls_json, '$.match_presentation_control.phase')
        AND c.candidate_version_id IS json_extract(NEW.controls_json, '$.match_presentation_control.candidate_version_id')
        AND c.migration_id IS json_extract(NEW.controls_json, '$.match_presentation_control.migration_id')
        AND c.capture_started_at_ms IS json_extract(NEW.controls_json, '$.match_presentation_control.capture_started_at_ms')
        AND c.source_digest IS json_extract(NEW.controls_json, '$.match_presentation_control.source_digest')
        AND c.source_count IS json_extract(NEW.controls_json, '$.match_presentation_control.source_count')
        AND c.verification_digest IS json_extract(NEW.controls_json, '$.match_presentation_control.verification_digest')
        AND c.verified_at_ms IS json_extract(NEW.controls_json, '$.match_presentation_control.verified_at_ms')
        AND c.activated_at_ms IS json_extract(NEW.controls_json, '$.match_presentation_control.activated_at_ms')
  ) THEN 1 ELSE RAISE(ABORT, 'cancellation-control-changed') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM game_session_transitions WHERE status != 'completed')
    AND NOT EXISTS (SELECT 1 FROM game_session_transition_resources)
    AND NOT EXISTS (SELECT 1 FROM game_session_mutation_locks)
    THEN 1 ELSE RAISE(ABORT, 'cancellation-session-work-pending') END;
  SELECT CASE WHEN
    (NEW.admission_table = 'automatch_write_admissions'
      AND (SELECT COUNT(*) FROM json_each(NEW.original_row_json)) = 11
      AND EXISTS (SELECT 1 FROM automatch_write_admissions a WHERE a.admission_id IS json_extract(NEW.original_row_json, '$.admission_id')
        AND a.epoch IS json_extract(NEW.original_row_json, '$.epoch')
        AND a.freeze_generation IS json_extract(NEW.original_row_json, '$.freeze_generation')
        AND a.backend IS json_extract(NEW.original_row_json, '$.backend')
        AND a.kind IS json_extract(NEW.original_row_json, '$.kind')
        AND a.created_at_ms IS json_extract(NEW.original_row_json, '$.created_at_ms')
        AND a.phase IS json_extract(NEW.original_row_json, '$.phase')
        AND a.proof_json IS json_extract(NEW.original_row_json, '$.proof_json')
        AND a.audit_revision IS json_extract(NEW.original_row_json, '$.audit_revision')
        AND a.updated_at_ms IS json_extract(NEW.original_row_json, '$.updated_at_ms')
        AND a.completed_at_ms IS json_extract(NEW.original_row_json, '$.completed_at_ms')))
    OR (NEW.admission_table = 'invite_source_write_admissions'
      AND (SELECT COUNT(*) FROM json_each(NEW.original_row_json)) = 6
      AND EXISTS (SELECT 1 FROM invite_source_write_admissions a WHERE a.admission_id IS json_extract(NEW.original_row_json, '$.admission_id')
        AND a.backend IS json_extract(NEW.original_row_json, '$.backend')
        AND a.epoch IS json_extract(NEW.original_row_json, '$.epoch')
        AND a.freeze_generation IS json_extract(NEW.original_row_json, '$.freeze_generation')
        AND a.kind IS json_extract(NEW.original_row_json, '$.kind')
        AND a.created_at_ms IS json_extract(NEW.original_row_json, '$.created_at_ms')))
    THEN 1 ELSE RAISE(ABORT, 'cancellation-source-row-changed') END;
END;

CREATE TRIGGER automatch_write_admissions_cancelled_insert
BEFORE INSERT ON automatch_write_admissions
WHEN EXISTS (
  SELECT 1 FROM automatch_admission_cancellations
  WHERE admission_table = 'automatch_write_admissions' AND admission_id = NEW.admission_id
)
BEGIN SELECT RAISE(ABORT, 'admission-write-authority-revoked'); END;

CREATE TRIGGER automatch_write_admissions_cancelled_update
BEFORE UPDATE OF admission_id ON automatch_write_admissions
WHEN EXISTS (
  SELECT 1 FROM automatch_admission_cancellations
  WHERE admission_table = 'automatch_write_admissions' AND admission_id = NEW.admission_id
)
BEGIN SELECT RAISE(ABORT, 'admission-write-authority-revoked'); END;

CREATE TRIGGER automatch_write_admissions_cancel_after_archive
AFTER INSERT ON automatch_admission_cancellations
WHEN NEW.admission_table = 'automatch_write_admissions'
BEGIN
  DELETE FROM automatch_write_admissions WHERE admission_id IS json_extract(NEW.original_row_json, '$.admission_id')
    AND epoch IS json_extract(NEW.original_row_json, '$.epoch')
    AND freeze_generation IS json_extract(NEW.original_row_json, '$.freeze_generation')
    AND backend IS json_extract(NEW.original_row_json, '$.backend')
    AND kind IS json_extract(NEW.original_row_json, '$.kind')
    AND created_at_ms IS json_extract(NEW.original_row_json, '$.created_at_ms')
    AND phase IS json_extract(NEW.original_row_json, '$.phase')
    AND proof_json IS json_extract(NEW.original_row_json, '$.proof_json')
    AND audit_revision IS json_extract(NEW.original_row_json, '$.audit_revision')
    AND updated_at_ms IS json_extract(NEW.original_row_json, '$.updated_at_ms')
    AND completed_at_ms IS json_extract(NEW.original_row_json, '$.completed_at_ms');
  SELECT CASE WHEN changes() = 1 THEN 1 ELSE RAISE(ABORT, 'cancellation-source-delete-unconfirmed') END;
END;

CREATE TRIGGER invite_source_write_admissions_cancelled_insert
BEFORE INSERT ON invite_source_write_admissions
WHEN EXISTS (
  SELECT 1 FROM automatch_admission_cancellations
  WHERE admission_table = 'invite_source_write_admissions' AND admission_id = NEW.admission_id
)
BEGIN SELECT RAISE(ABORT, 'admission-write-authority-revoked'); END;

CREATE TRIGGER invite_source_write_admissions_cancelled_update
BEFORE UPDATE OF admission_id ON invite_source_write_admissions
WHEN EXISTS (
  SELECT 1 FROM automatch_admission_cancellations
  WHERE admission_table = 'invite_source_write_admissions' AND admission_id = NEW.admission_id
)
BEGIN SELECT RAISE(ABORT, 'admission-write-authority-revoked'); END;

CREATE TRIGGER invite_source_write_admissions_cancel_after_archive
AFTER INSERT ON automatch_admission_cancellations
WHEN NEW.admission_table = 'invite_source_write_admissions'
BEGIN
  DELETE FROM invite_source_write_admissions WHERE admission_id IS json_extract(NEW.original_row_json, '$.admission_id')
    AND backend IS json_extract(NEW.original_row_json, '$.backend')
    AND epoch IS json_extract(NEW.original_row_json, '$.epoch')
    AND freeze_generation IS json_extract(NEW.original_row_json, '$.freeze_generation')
    AND kind IS json_extract(NEW.original_row_json, '$.kind')
    AND created_at_ms IS json_extract(NEW.original_row_json, '$.created_at_ms');
  SELECT CASE WHEN changes() = 1 THEN 1 ELSE RAISE(ABORT, 'cancellation-source-delete-unconfirmed') END;
END;

