DROP TRIGGER application_admission_reconciliation_insert_guard;
DROP TRIGGER application_admission_reconciliation_apply;
DROP TRIGGER application_admission_reconciliation_update_guard;
DROP TRIGGER application_admission_reconciliation_delete_guard;
DROP TRIGGER application_reconciled_admission_update_guard;
DROP TRIGGER application_reconciled_admission_delete_guard;
DROP TRIGGER application_reconciled_admission_insert_guard;

CREATE TABLE application_admission_reconciliations_extended (
  operation_id TEXT PRIMARY KEY,
  original_row_json TEXT NOT NULL CHECK (json_valid(original_row_json)),
  original_row_digest TEXT NOT NULL CHECK (length(original_row_digest) = 64 AND original_row_digest NOT GLOB '*[^a-f0-9]*'),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^a-f0-9]*'),
  outcome TEXT NOT NULL CHECK (outcome = 'blocked-outcome-unknown'),
  failure_code TEXT NOT NULL CHECK (failure_code = 'admission-reconciled-uncertain'),
  reconciled_at_ms INTEGER NOT NULL CHECK (reconciled_at_ms > 1793009482468),
  CHECK (operation_id IN ('1a960ff7-c7de-4a95-a11d-bf70000c4640', '17162eb9-9b7d-481b-85ad-0a2901cd5b62', '10d9ddf0-7140-40ee-8273-a9c569169d85', 'ec19e0d9-f677-436e-b979-adf95564e076')),
  CHECK (original_row_digest = CASE operation_id
    WHEN '1a960ff7-c7de-4a95-a11d-bf70000c4640' THEN '7b79d5dd4fa4f729c32400f2eb4060163585faa61e8ede3c08d384c85cc9c769'
    WHEN '17162eb9-9b7d-481b-85ad-0a2901cd5b62' THEN 'd33c97960f8d9e8ac5683b25677a81ddda4ecdbf9a977fd3553477cee1ea2193'
    WHEN '10d9ddf0-7140-40ee-8273-a9c569169d85' THEN 'a2cb0f1427b7b85f10d243ca7e524aa30b2e6b6513520747ec3ed5a56d18e3f7'
    WHEN 'ec19e0d9-f677-436e-b979-adf95564e076' THEN '38c25a8446a2f05d68af2a4c363be7a44984f5b32699b9ff086e722b26704cf3' END),
  CHECK ((operation_id IN ('1a960ff7-c7de-4a95-a11d-bf70000c4640', '17162eb9-9b7d-481b-85ad-0a2901cd5b62', '10d9ddf0-7140-40ee-8273-a9c569169d85') AND (COALESCE(json_extract(original_row_json, '$.operation_id') = operation_id
    AND json_extract(original_row_json, '$.generation') = 1
    AND json_extract(original_row_json, '$.data_epoch') = 0
    AND json_extract(original_row_json, '$.status') = 'running'
    AND json_type(original_row_json, '$.failure_code') = 'null'
    AND json_type(original_row_json, '$.parent_operation_id') = 'null'
    AND ((operation_id IN ('1a960ff7-c7de-4a95-a11d-bf70000c4640', '17162eb9-9b7d-481b-85ad-0a2901cd5b62')
      AND json_extract(original_row_json, '$.kind') = 'socket'
      AND json_extract(original_row_json, '$.started_at_ms') = 1793003252252)
      OR (operation_id = '10d9ddf0-7140-40ee-8273-a9c569169d85'
      AND json_extract(original_row_json, '$.kind') = 'scheduled'
      AND json_extract(original_row_json, '$.started_at_ms') = 1793008582468)), 0))) OR (operation_id = 'ec19e0d9-f677-436e-b979-adf95564e076' AND original_row_json = '{"data_epoch":0,"failure_code":"operation-failed","generation":1,"kind":"scheduled","operation_id":"ec19e0d9-f677-436e-b979-adf95564e076","parent_operation_id":null,"started_at_ms":1793081116965,"status":"blocked"}')),
  CHECK ((operation_id IN ('1a960ff7-c7de-4a95-a11d-bf70000c4640', '17162eb9-9b7d-481b-85ad-0a2901cd5b62', '10d9ddf0-7140-40ee-8273-a9c569169d85') AND (COALESCE(json_extract(evidence_json, '$.schemaVersion') = 1
    AND json_extract(evidence_json, '$.kind') = 'application-admission-reconciliation'
    AND json_extract(evidence_json, '$.operationId') = operation_id
    AND json_extract(evidence_json, '$.originalRowDigest') = original_row_digest
    AND json_extract(evidence_json, '$.successfulCompletionClaimed') = 0
    AND json_extract(evidence_json, '$.businessOutcomes') = 'unknown-preserved'
    AND json_extract(evidence_json, '$.acceptedDescendantsPreserved') = 1
    AND json_extract(evidence_json, '$.writeAuthorityRevokedNow') = 0
    AND json_extract(evidence_json, '$.requiresClosedGenerationFencesForMigration') = 1
    AND json_extract(evidence_json, '$.sourceWorkerVersionId') = '5c303a57-b8a5-4a19-af5d-ef6c81dde98b'
    AND json_extract(evidence_json, '$.sourceBundleDigest') = '733fbb70021d080c0c3862970108c9e108dd822daae782cf33537269b76b13fb'
    AND ((json_extract(original_row_json, '$.kind') = 'socket'
      AND json_extract(evidence_json, '$.disposition') = 'socket-capability-retirement'
      AND json_extract(evidence_json, '$.lateCacheOrUiEffectsPossible') = 1
      AND json_type(evidence_json, '$.providerBound') = 'null')
      OR (json_extract(original_row_json, '$.kind') = 'scheduled'
      AND json_extract(evidence_json, '$.disposition') = 'scheduled-provider-bound-retirement'
      AND json_extract(evidence_json, '$.lateCacheOrUiEffectsPossible') = 0
      AND json_type(evidence_json, '$.providerBound') = 'object'))
    AND json_extract(evidence_json, '$.sourceAuditDigest') = 'e9dbc4c7dcdbd0bd52b20699a39d62b58b588ca0934041ac344b79baf22352cc', 0))) OR COALESCE(operation_id = 'ec19e0d9-f677-436e-b979-adf95564e076'
    AND json_extract(evidence_json, '$.schemaVersion') = 1
    AND json_extract(evidence_json, '$.kind') = 'application-admission-reconciliation'
    AND json_extract(evidence_json, '$.operationId') = operation_id
    AND json_extract(evidence_json, '$.originalRowDigest') = original_row_digest
    AND json_extract(evidence_json, '$.sourceWorkerVersionId') = '02ddd4d2-694a-431f-87d8-737ff672f759'
    AND json_extract(evidence_json, '$.sourceBundleDigest') = 'b94627bcd469f4155d9d1d86c2769503d5b5566b1764818e487efa174d558271'
    AND json_extract(evidence_json, '$.sourceAuditDigest') = 'c2db47df2e14d6d2b15c548675b96c10ce44f8863d6aee97baf640c306f1e5be'
    AND json_extract(evidence_json, '$.disposition') = 'scheduled-provider-bound-retirement'
    AND json_type(evidence_json, '$.successfulCompletionClaimed') = 'false'
    AND json_extract(evidence_json, '$.businessOutcomes') = 'unknown-preserved'
    AND json_type(evidence_json, '$.acceptedDescendantsPreserved') = 'true'
    AND json_type(evidence_json, '$.writeAuthorityRevokedNow') = 'false'
    AND json_type(evidence_json, '$.lateCacheOrUiEffectsPossible') = 'false'
    AND json_type(evidence_json, '$.requiresClosedGenerationFencesForMigration') = 'true'
    AND json_extract(evidence_json, '$.providerBound.kind') = 'provider-execution-bound-evidence'
    AND json_extract(evidence_json, '$.providerBound.sourceWorkerVersionId') = '02ddd4d2-694a-431f-87d8-737ff672f759'
    AND json_extract(evidence_json, '$.providerBound.usageModel') = 'standard'
    AND json_extract(evidence_json, '$.providerBound.sourceKind') = 'scheduled'
    AND json_extract(evidence_json, '$.providerBound.startedAtMs') = 1793081116965
    AND json_extract(evidence_json, '$.providerBound.maximumWallTimeMs') = 900000
    AND json_extract(evidence_json, '$.providerBound.boundEndedAtMs') = 1793082016965
    AND json_type(evidence_json, '$.providerBound.providerObservedAtMs') = 'integer'
    AND json_extract(evidence_json, '$.providerBound.providerObservedAtMs') > 1793082016965
    AND reconciled_at_ms >= json_extract(evidence_json, '$.providerBound.providerObservedAtMs')
    AND json_type(evidence_json, '$.providerBound.successfulCompletionClaimed') = 'false'
    AND json_type(evidence_json, '$.providerBound.proofOfBusinessEffectCompletion') = 'false', 0))
) STRICT;

INSERT INTO application_admission_reconciliations_extended (operation_id, original_row_json, original_row_digest, evidence_json, evidence_digest, outcome, failure_code, reconciled_at_ms)
SELECT operation_id, original_row_json, original_row_digest, evidence_json, evidence_digest, outcome, failure_code, reconciled_at_ms FROM application_admission_reconciliations;

DROP TABLE application_admission_reconciliations;
ALTER TABLE application_admission_reconciliations_extended RENAME TO application_admission_reconciliations;

CREATE TRIGGER application_admission_reconciliation_insert_guard
BEFORE INSERT ON application_admission_reconciliations
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM json_each(NEW.original_row_json)) = 8
    THEN 1 ELSE RAISE(ABORT, 'application-reconciliation-source-fields') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM application_admission_reconciliations old WHERE old.operation_id = NEW.operation_id
      AND (old.original_row_json IS NOT NEW.original_row_json OR old.original_row_digest IS NOT NEW.original_row_digest
        OR old.evidence_json IS NOT NEW.evidence_json OR old.evidence_digest IS NOT NEW.evidence_digest
        OR old.outcome IS NOT NEW.outcome OR old.failure_code IS NOT NEW.failure_code
        OR old.reconciled_at_ms IS NOT NEW.reconciled_at_ms))
    THEN 1 ELSE RAISE(ABORT, 'application-reconciliation-conflict') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM application_data_control WHERE singleton = 1 AND generation = 1
      AND data_epoch = 0 AND phase = 'active' AND migration_id IS NULL)
    THEN 1 ELSE RAISE(ABORT, 'application-reconciliation-control-changed') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM application_data_admissions current WHERE current.operation_id = NEW.operation_id
      AND current.generation IS json_extract(NEW.original_row_json, '$.generation')
      AND current.data_epoch IS json_extract(NEW.original_row_json, '$.data_epoch')
      AND current.kind IS json_extract(NEW.original_row_json, '$.kind')
      AND current.started_at_ms IS json_extract(NEW.original_row_json, '$.started_at_ms')
      AND current.parent_operation_id IS json_extract(NEW.original_row_json, '$.parent_operation_id')
      AND ((NEW.operation_id = 'ec19e0d9-f677-436e-b979-adf95564e076' AND current.status = 'blocked' AND current.failure_code = 'operation-failed')
        OR (NEW.operation_id <> 'ec19e0d9-f677-436e-b979-adf95564e076' AND ((current.status = 'running' AND current.failure_code IS NULL)
          OR (current.status = 'blocked' AND current.failure_code = NEW.failure_code AND EXISTS (
            SELECT 1 FROM application_admission_reconciliations old WHERE old.operation_id = NEW.operation_id))))))
    THEN 1 ELSE RAISE(ABORT, 'application-reconciliation-source-changed') END;
END;

CREATE TRIGGER application_admission_reconciliation_apply
AFTER INSERT ON application_admission_reconciliations
WHEN NEW.operation_id <> 'ec19e0d9-f677-436e-b979-adf95564e076'
BEGIN
  UPDATE application_data_admissions SET status = 'blocked', failure_code = NEW.failure_code
    WHERE operation_id = NEW.operation_id AND status = 'running' AND failure_code IS NULL;
  SELECT CASE WHEN changes() = 1 THEN 1 ELSE RAISE(ABORT, 'application-reconciliation-cas-failed') END;
END;

CREATE TRIGGER application_admission_reconciliation_update_guard
BEFORE UPDATE ON application_admission_reconciliations
BEGIN SELECT RAISE(ABORT, 'application-reconciliation-immutable'); END;

CREATE TRIGGER application_admission_reconciliation_delete_guard
BEFORE DELETE ON application_admission_reconciliations
BEGIN SELECT RAISE(ABORT, 'application-reconciliation-immutable'); END;

CREATE TRIGGER application_reconciled_admission_update_guard
BEFORE UPDATE ON application_data_admissions
WHEN EXISTS (SELECT 1 FROM application_admission_reconciliations archive WHERE archive.operation_id = OLD.operation_id)
  AND (NEW.operation_id IS NOT OLD.operation_id OR NEW.generation IS NOT OLD.generation
    OR NEW.data_epoch IS NOT OLD.data_epoch OR NEW.kind IS NOT OLD.kind
    OR NEW.started_at_ms IS NOT OLD.started_at_ms OR NEW.parent_operation_id IS NOT OLD.parent_operation_id
    OR NEW.status IS NOT 'blocked'
    OR (OLD.operation_id = 'ec19e0d9-f677-436e-b979-adf95564e076' AND NEW.failure_code IS NOT 'operation-failed')
    OR (OLD.operation_id <> 'ec19e0d9-f677-436e-b979-adf95564e076' AND NEW.failure_code IS NOT 'admission-reconciled-uncertain'))
BEGIN SELECT RAISE(ABORT, 'application-reconciled-admission-immutable'); END;

CREATE TRIGGER application_reconciled_admission_delete_guard
BEFORE DELETE ON application_data_admissions
WHEN EXISTS (SELECT 1 FROM application_admission_reconciliations archive WHERE archive.operation_id = OLD.operation_id)
BEGIN SELECT RAISE(ABORT, 'application-reconciled-admission-immutable'); END;

CREATE TRIGGER application_reconciled_admission_insert_guard
BEFORE INSERT ON application_data_admissions
WHEN EXISTS (SELECT 1 FROM application_admission_reconciliations archive WHERE archive.operation_id = NEW.operation_id)
BEGIN SELECT RAISE(ABORT, 'application-reconciled-admission-immutable'); END;
