CREATE TABLE event_transition_receipts (
  transition_id TEXT PRIMARY KEY NOT NULL CHECK (transition_id != ''),
  schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2)),
  event_id TEXT NOT NULL CHECK (event_id != ''),
  expected_revision INTEGER NOT NULL CHECK (typeof(expected_revision) = 'integer' AND expected_revision BETWEEN 1 AND 9007199254740991),
  payload_digest TEXT,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json) AND json_type(receipt_json) = 'object'),
  recorded_at_ms INTEGER NOT NULL CHECK (typeof(recorded_at_ms) = 'integer' AND recorded_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (
    (schema_version = 1 AND payload_digest IS NULL AND json_type(receipt_json, '$.payloadDigest') IS NULL)
    OR (schema_version = 2 AND payload_digest IS NOT NULL AND length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^a-f0-9]*'
      AND json_type(receipt_json, '$.payloadDigest') IS 'text' AND json_extract(receipt_json, '$.payloadDigest') IS payload_digest)
  ),
  CHECK (json_type(receipt_json, '$.schemaVersion') IS 'integer' AND json_extract(receipt_json, '$.schemaVersion') IS schema_version),
  CHECK (json_type(receipt_json, '$.transitionId') IS 'text' AND json_extract(receipt_json, '$.transitionId') IS transition_id),
  CHECK (json_type(receipt_json, '$.eventId') IS 'text' AND json_extract(receipt_json, '$.eventId') IS event_id),
  CHECK (json_type(receipt_json, '$.expectedRevision') IS 'integer' AND json_extract(receipt_json, '$.expectedRevision') IS expected_revision)
) WITHOUT ROWID;

CREATE TABLE event_transition_receipt_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state TEXT NOT NULL CHECK (state IN ('importing', 'active')),
  source_count INTEGER CHECK (source_count IS NULL OR (typeof(source_count) = 'integer' AND source_count BETWEEN 0 AND 9007199254740991)),
  source_digest TEXT CHECK (source_digest IS NULL OR (length(source_digest) = 64 AND source_digest NOT GLOB '*[^a-f0-9]*')),
  import_count INTEGER CHECK (import_count IS NULL OR (typeof(import_count) = 'integer' AND import_count BETWEEN 0 AND 9007199254740991)),
  import_digest TEXT CHECK (import_digest IS NULL OR (length(import_digest) = 64 AND import_digest NOT GLOB '*[^a-f0-9]*')),
  candidate_version_id TEXT CHECK (candidate_version_id IS NULL OR (
    length(candidate_version_id) = 36 AND substr(candidate_version_id, 9, 1) = '-'
    AND substr(candidate_version_id, 14, 1) = '-' AND substr(candidate_version_id, 19, 1) = '-'
    AND substr(candidate_version_id, 24, 1) = '-' AND length(replace(candidate_version_id, '-', '')) = 32
    AND replace(candidate_version_id, '-', '') NOT GLOB '*[^a-f0-9]*'
  )),
  verified_event_freeze_generation INTEGER CHECK (verified_event_freeze_generation IS NULL OR (
    typeof(verified_event_freeze_generation) = 'integer' AND verified_event_freeze_generation BETWEEN 0 AND 9007199254740991
  )),
  source_exported_at_ms INTEGER CHECK (source_exported_at_ms IS NULL OR (
    typeof(source_exported_at_ms) = 'integer' AND source_exported_at_ms BETWEEN 0 AND 9007199254740991
  )),
  imported_at_ms INTEGER CHECK (imported_at_ms IS NULL OR (
    typeof(imported_at_ms) = 'integer' AND imported_at_ms BETWEEN 0 AND 9007199254740991
  )),
  verified_at_ms INTEGER CHECK (verified_at_ms IS NULL OR (
    typeof(verified_at_ms) = 'integer' AND verified_at_ms BETWEEN 0 AND 9007199254740991
  )),
  activated_at_ms INTEGER CHECK (activated_at_ms IS NULL OR (
    typeof(activated_at_ms) = 'integer' AND activated_at_ms BETWEEN 0 AND 9007199254740991
  )),
  CHECK (state = 'importing' OR (
    source_count IS NOT NULL AND source_digest IS NOT NULL
    AND import_count IS source_count AND import_digest IS source_digest
    AND candidate_version_id IS NOT NULL AND verified_event_freeze_generation IS NOT NULL
    AND source_exported_at_ms IS NOT NULL AND imported_at_ms IS NOT NULL
    AND verified_at_ms IS NOT NULL AND activated_at_ms IS NOT NULL
    AND source_exported_at_ms <= imported_at_ms AND imported_at_ms <= verified_at_ms
    AND verified_at_ms <= activated_at_ms
  ))
);

INSERT INTO event_transition_receipt_control (singleton, state) VALUES (1, 'importing');

CREATE TABLE event_transition_receipt_guards (
  singleton INTEGER PRIMARY KEY CONSTRAINT event_transition_receipt_guard CHECK (singleton = 1)
);

CREATE TRIGGER event_transition_receipts_reject_update
BEFORE UPDATE ON event_transition_receipts
BEGIN
  SELECT RAISE(ABORT, 'event transition receipts are immutable');
END;

CREATE TRIGGER event_transition_receipts_reject_delete
BEFORE DELETE ON event_transition_receipts
BEGIN
  SELECT RAISE(ABORT, 'event transition receipts are immutable');
END;

CREATE TRIGGER event_transition_receipts_reject_conflicting_insert
BEFORE INSERT ON event_transition_receipts
WHEN EXISTS (
  SELECT 1 FROM event_transition_receipts
  WHERE transition_id = NEW.transition_id
    AND (schema_version IS NOT NEW.schema_version OR event_id IS NOT NEW.event_id
      OR expected_revision IS NOT NEW.expected_revision OR payload_digest IS NOT NEW.payload_digest
      OR receipt_json IS NOT NEW.receipt_json)
)
BEGIN
  SELECT RAISE(ABORT, 'event-transition-receipt-conflict');
END;

CREATE TRIGGER event_transition_receipts_preserve_identical_insert
BEFORE INSERT ON event_transition_receipts
WHEN EXISTS (
  SELECT 1 FROM event_transition_receipts
  WHERE transition_id = NEW.transition_id AND schema_version IS NEW.schema_version
    AND event_id IS NEW.event_id AND expected_revision IS NEW.expected_revision
    AND payload_digest IS NEW.payload_digest AND receipt_json IS NEW.receipt_json
)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER event_transition_receipts_require_control
BEFORE INSERT ON event_transition_receipts
WHEN NOT EXISTS (SELECT 1 FROM event_transition_receipt_control WHERE singleton = 1)
BEGIN
  SELECT RAISE(ABORT, 'event transition receipt control is missing');
END;

CREATE TRIGGER event_transition_receipt_control_reject_update
BEFORE UPDATE ON event_transition_receipt_control
WHEN OLD.state = 'active' OR NEW.singleton != OLD.singleton
BEGIN
  SELECT RAISE(ABORT, 'event transition receipt authority is immutable');
END;

CREATE TRIGGER event_transition_receipt_control_reject_delete
BEFORE DELETE ON event_transition_receipt_control
BEGIN
  SELECT RAISE(ABORT, 'event transition receipt authority is immutable');
END;

CREATE TRIGGER event_transition_receipt_control_reject_replace
BEFORE INSERT ON event_transition_receipt_control
WHEN EXISTS (SELECT 1 FROM event_transition_receipt_control)
BEGIN
  SELECT RAISE(ABORT, 'event transition receipt authority is immutable');
END;

CREATE TRIGGER event_transition_receipt_control_require_drained_effects
BEFORE UPDATE OF state ON event_transition_receipt_control
WHEN NEW.state = 'active' AND EXISTS (
  SELECT 1 FROM invite_source_write_admissions
  WHERE kind IN ('event-effects', 'event-effects-d1-receipts')
)
BEGIN
  SELECT RAISE(ABORT, 'event transition receipt writers are active');
END;

CREATE TRIGGER event_transition_receipt_control_require_import_count
BEFORE UPDATE OF state ON event_transition_receipt_control
WHEN NEW.state = 'active' AND NEW.import_count IS NOT (
  SELECT COUNT(*) FROM event_transition_receipts
)
BEGIN
  SELECT RAISE(ABORT, 'event transition receipt import count is unverified');
END;

CREATE TRIGGER event_transition_receipt_admission_insert_gate
BEFORE INSERT ON invite_source_write_admissions
WHEN (NEW.kind = 'event-effects' AND NOT EXISTS (
  SELECT 1 FROM event_transition_receipt_control WHERE singleton = 1 AND state = 'importing'
)) OR (NEW.kind = 'event-effects-d1-receipts' AND NOT EXISTS (
  SELECT 1 FROM event_transition_receipt_control WHERE singleton = 1 AND state = 'active'
))
BEGIN
  SELECT RAISE(ABORT, 'event transition receipt writer is disabled');
END;

CREATE TRIGGER event_transition_receipt_admission_update_gate
BEFORE UPDATE ON invite_source_write_admissions
WHEN (NEW.kind = 'event-effects' AND NOT EXISTS (
  SELECT 1 FROM event_transition_receipt_control WHERE singleton = 1 AND state = 'importing'
)) OR (NEW.kind = 'event-effects-d1-receipts' AND NOT EXISTS (
  SELECT 1 FROM event_transition_receipt_control WHERE singleton = 1 AND state = 'active'
))
BEGIN
  SELECT RAISE(ABORT, 'event transition receipt writer is disabled');
END;
