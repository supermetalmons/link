INSERT INTO profile_transaction_guards (singleton)
SELECT 0
WHERE NOT EXISTS (
  SELECT 1 FROM profile_canonical_control
  WHERE singleton = 1 AND state = 'frozen'
    AND import_digest IS NOT NULL AND imported_at_ms IS NOT NULL
)
OR NOT EXISTS (
  SELECT 1 FROM wager_reservation_runtime_control
  WHERE singleton = 1 AND storage_mode = 'frozen'
)
OR EXISTS (SELECT 1 FROM wager_reservation_write_admissions)
OR NOT EXISTS (
  SELECT 1 FROM profile_link_catchup_import
  WHERE singleton = 1
    AND typeof(activated_at_ms) = 'integer' AND activated_at_ms > 0
    AND typeof(verified_at_ms) = 'integer' AND verified_at_ms > 0
    AND import_attempt_id IS NULL AND import_started_at_ms IS NULL
    AND length(source_digest) = 64 AND source_digest NOT GLOB '*[^a-f0-9]*'
    AND length(import_digest) = 64 AND import_digest NOT GLOB '*[^a-f0-9]*'
    AND length(owners_digest) = 64 AND owners_digest NOT GLOB '*[^a-f0-9]*'
    AND typeof(activated_version_id) = 'text' AND length(activated_version_id) > 0
)
OR NOT EXISTS (
  SELECT 1 FROM rating_completion_control
  WHERE singleton = 1 AND activated_at_ms > 0
    AND source_count = (SELECT COUNT(*) FROM legacy_rating_completions)
);

DROP TRIGGER legacy_rating_completions_insert_frozen;
DROP TRIGGER legacy_rating_completions_insert_unactivated;

CREATE TRIGGER legacy_rating_completions_reject_insert
BEFORE INSERT ON legacy_rating_completions
BEGIN
  SELECT RAISE(ABORT, 'historical-rating-completions-immutable');
END;

DROP TABLE rating_completion_control;
DROP TABLE profile_link_catchup_import_guards;
DROP TABLE profile_link_catchup_import;

CREATE TABLE profile_canonical_control_copy (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state TEXT NOT NULL CHECK (state IN ('frozen', 'active'))
);

INSERT INTO profile_canonical_control_copy (singleton, state)
SELECT singleton, state FROM profile_canonical_control;

DROP TABLE profile_canonical_control;

CREATE TABLE profile_canonical_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state TEXT NOT NULL CHECK (state IN ('frozen', 'active'))
);

INSERT INTO profile_canonical_control (singleton, state)
SELECT singleton, state FROM profile_canonical_control_copy;

DROP TABLE profile_canonical_control_copy;

CREATE TRIGGER profile_canonical_control_reject_delete
BEFORE DELETE ON profile_canonical_control
BEGIN
  SELECT RAISE(ABORT, 'profile canonical control is permanent');
END;

CREATE TRIGGER profile_canonical_control_reject_replace
BEFORE INSERT ON profile_canonical_control
WHEN EXISTS (SELECT 1 FROM profile_canonical_control)
BEGIN
  SELECT RAISE(ABORT, 'profile canonical control is permanent');
END;
