INSERT INTO wager_reservation_write_guards (singleton)
SELECT 0 WHERE NOT EXISTS (
  SELECT 1 FROM profile_canonical_control AS profile
  JOIN wager_reservation_runtime_control AS reservation ON reservation.singleton = 1
  WHERE profile.singleton = 1 AND profile.state = 'frozen'
    AND reservation.storage_mode = 'frozen'
) OR EXISTS (SELECT 1 FROM wager_reservation_write_admissions);

CREATE TABLE invite_wager_states (
  invite_id TEXT NOT NULL CHECK (invite_id != '' AND instr(invite_id, '/') = 0),
  match_id TEXT NOT NULL CHECK (match_id != '' AND instr(match_id, '/') = 0),
  wager_json TEXT CHECK (wager_json IS NULL OR json_valid(wager_json)),
  resolution_marker INTEGER CHECK (resolution_marker IS NULL OR resolution_marker IN (0, 1)),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (invite_id, match_id)
) WITHOUT ROWID;

CREATE TABLE wager_state_activation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  activation_epoch INTEGER NOT NULL DEFAULT 0 CHECK (activation_epoch IN (0, 1)),
  import_attempt_id TEXT,
  source_digest TEXT CHECK (source_digest IS NULL OR (length(source_digest) = 64 AND source_digest NOT GLOB '*[^a-f0-9]*')),
  import_digest TEXT CHECK (import_digest IS NULL OR (length(import_digest) = 64 AND import_digest NOT GLOB '*[^a-f0-9]*')),
  baseline_digest TEXT CHECK (baseline_digest IS NULL OR (length(baseline_digest) = 64 AND baseline_digest NOT GLOB '*[^a-f0-9]*')),
  verified_baseline_digest TEXT CHECK (verified_baseline_digest IS NULL OR (length(verified_baseline_digest) = 64 AND verified_baseline_digest NOT GLOB '*[^a-f0-9]*')),
  source_wager_count INTEGER CHECK (source_wager_count IS NULL OR (typeof(source_wager_count) = 'integer' AND source_wager_count >= 0)),
  source_marker_count INTEGER CHECK (source_marker_count IS NULL OR (typeof(source_marker_count) = 'integer' AND source_marker_count >= 0)),
  source_row_count INTEGER CHECK (source_row_count IS NULL OR (typeof(source_row_count) = 'integer' AND source_row_count >= 0)),
  imported_row_count INTEGER CHECK (imported_row_count IS NULL OR (typeof(imported_row_count) = 'integer' AND imported_row_count >= 0)),
  verified_freeze_generation INTEGER CHECK (verified_freeze_generation IS NULL OR (typeof(verified_freeze_generation) = 'integer' AND verified_freeze_generation >= 0)),
  verified_at_ms INTEGER CHECK (verified_at_ms IS NULL OR (typeof(verified_at_ms) = 'integer' AND verified_at_ms > 0)),
  activated_at_ms INTEGER CHECK (activated_at_ms IS NULL OR (typeof(activated_at_ms) = 'integer' AND activated_at_ms >= verified_at_ms)),
  candidate_version_id TEXT
);

INSERT INTO wager_state_activation (singleton) VALUES (1);

CREATE TABLE wager_state_write_guards (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
);

CREATE TABLE wager_state_revision_guards (
  singleton INTEGER PRIMARY KEY CONSTRAINT wager_state_revision_guard CHECK (singleton = 1)
);

ALTER TABLE wager_reservation_write_admissions
ADD COLUMN writer_epoch INTEGER NOT NULL DEFAULT 0 CHECK (writer_epoch IN (0, 1));

CREATE TRIGGER wager_state_admission_epoch
BEFORE INSERT ON wager_reservation_write_admissions
WHEN NOT EXISTS (
  SELECT 1 FROM wager_state_activation
  WHERE singleton = 1 AND activation_epoch = NEW.writer_epoch
)
BEGIN
  SELECT RAISE(ABORT, 'wager state writer epoch is unsupported');
END;

CREATE TRIGGER wager_state_activation_no_delete
BEFORE DELETE ON wager_state_activation
BEGIN
  SELECT RAISE(ABORT, 'wager state activation is permanent');
END;

CREATE TRIGGER wager_state_activation_no_replace
BEFORE INSERT ON wager_state_activation
WHEN EXISTS (SELECT 1 FROM wager_state_activation)
BEGIN
  SELECT RAISE(ABORT, 'wager state activation is permanent');
END;

CREATE TRIGGER wager_state_activation_immutable
BEFORE UPDATE ON wager_state_activation
WHEN OLD.activation_epoch = 1
BEGIN
  SELECT RAISE(ABORT, 'wager state activation is immutable');
END;

CREATE TRIGGER wager_state_activation_frozen
BEFORE UPDATE ON wager_state_activation
WHEN NOT EXISTS (
  SELECT 1 FROM profile_canonical_control AS profile
  JOIN wager_reservation_runtime_control AS reservation ON reservation.singleton = 1
  WHERE profile.singleton = 1 AND profile.state = 'frozen'
    AND reservation.storage_mode = 'frozen'
) OR EXISTS (SELECT 1 FROM wager_reservation_write_admissions)
BEGIN
  SELECT RAISE(ABORT, 'wager state activation requires drained frozen writers');
END;

CREATE TRIGGER wager_state_activation_verified
BEFORE UPDATE ON wager_state_activation
WHEN NEW.activation_epoch = 1 AND (
  NEW.import_attempt_id IS NOT NULL
  OR NEW.source_digest IS NULL OR NEW.import_digest IS NOT NEW.source_digest
  OR NEW.baseline_digest IS NULL OR NEW.verified_baseline_digest IS NOT NEW.baseline_digest
  OR NEW.verified_at_ms IS NULL OR NEW.activated_at_ms IS NULL
  OR NEW.candidate_version_id IS NULL OR length(trim(NEW.candidate_version_id)) = 0
  OR NEW.source_row_count IS NULL OR NEW.imported_row_count IS NOT NEW.source_row_count
  OR NEW.source_row_count IS NOT (SELECT COUNT(*) FROM invite_wager_states)
  OR NEW.source_wager_count IS NOT (SELECT COUNT(*) FROM invite_wager_states WHERE wager_json IS NOT NULL)
  OR NEW.source_marker_count IS NOT (SELECT COUNT(*) FROM invite_wager_states WHERE resolution_marker IS NOT NULL)
  OR EXISTS (SELECT 1 FROM invite_wager_states WHERE revision != 1 OR (wager_json IS NULL AND resolution_marker IS NULL))
  OR NEW.verified_freeze_generation IS NOT (
    SELECT freeze_generation FROM wager_reservation_runtime_control WHERE singleton = 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'wager state import is not verified');
END;

CREATE TRIGGER wager_state_import_insert
BEFORE INSERT ON invite_wager_states
WHEN (SELECT activation_epoch FROM wager_state_activation WHERE singleton = 1) = 0
  AND NOT EXISTS (
    SELECT 1 FROM wager_state_activation AS activation
    JOIN profile_canonical_control AS profile ON profile.singleton = 1
    JOIN wager_reservation_runtime_control AS reservation ON reservation.singleton = 1
    WHERE activation.singleton = 1 AND length(activation.import_attempt_id) > 0
      AND activation.verified_at_ms IS NULL AND profile.state = 'frozen'
      AND reservation.storage_mode = 'frozen'
      AND NOT EXISTS (SELECT 1 FROM wager_reservation_write_admissions)
  )
BEGIN
  SELECT RAISE(ABORT, 'wager state import requires a frozen attempt');
END;

CREATE TRIGGER wager_state_import_update
BEFORE UPDATE ON invite_wager_states
WHEN (SELECT activation_epoch FROM wager_state_activation WHERE singleton = 1) = 0
  AND NOT EXISTS (
    SELECT 1 FROM wager_state_activation AS activation
    JOIN profile_canonical_control AS profile ON profile.singleton = 1
    JOIN wager_reservation_runtime_control AS reservation ON reservation.singleton = 1
    WHERE activation.singleton = 1 AND length(activation.import_attempt_id) > 0
      AND activation.verified_at_ms IS NULL AND profile.state = 'frozen'
      AND reservation.storage_mode = 'frozen'
      AND NOT EXISTS (SELECT 1 FROM wager_reservation_write_admissions)
  )
BEGIN
  SELECT RAISE(ABORT, 'wager state import requires a frozen attempt');
END;

CREATE TRIGGER wager_state_no_delete
BEFORE DELETE ON invite_wager_states
WHEN NOT EXISTS (
  SELECT 1 FROM wager_state_activation AS activation
  JOIN profile_canonical_control AS profile ON profile.singleton = 1
  JOIN wager_reservation_runtime_control AS reservation ON reservation.singleton = 1
  WHERE activation.singleton = 1 AND activation.activation_epoch = 0
    AND length(activation.import_attempt_id) > 0 AND activation.verified_at_ms IS NULL
    AND profile.state = 'frozen' AND reservation.storage_mode = 'frozen'
    AND NOT EXISTS (SELECT 1 FROM wager_reservation_write_admissions)
)
BEGIN
  SELECT RAISE(ABORT, 'wager state revisions are permanent');
END;
