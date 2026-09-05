CREATE TABLE wager_reservation_runtime_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  storage_mode TEXT NOT NULL CHECK (storage_mode IN ('firebase', 'frozen', 'd1')),
  previous_storage_mode TEXT CHECK (previous_storage_mode IN ('firebase', 'd1')),
  freeze_generation INTEGER NOT NULL CHECK (freeze_generation >= 0),
  activated_at_ms INTEGER,
  verified_import_generation INTEGER,
  import_attempt_id TEXT,
  import_started_at_ms INTEGER,
  source_digest TEXT,
  source_balance_count INTEGER,
  source_operation_count INTEGER,
  source_first_exported_at_ms INTEGER,
  source_exported_at_ms INTEGER,
  queues_paused_at_ms INTEGER,
  bridge_deployed_at_ms INTEGER,
  bridge_version_id TEXT,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK (
    (storage_mode = 'frozen' AND previous_storage_mode IS NOT NULL)
    OR (storage_mode != 'frozen' AND previous_storage_mode IS NULL)
  ),
  CHECK (activated_at_ms IS NULL OR storage_mode != 'firebase'),
  CHECK (activated_at_ms IS NULL OR previous_storage_mode IS NULL OR previous_storage_mode = 'd1'),
  CHECK ((import_attempt_id IS NULL) = (import_started_at_ms IS NULL))
);

INSERT INTO wager_reservation_runtime_control (
  singleton, storage_mode, previous_storage_mode, freeze_generation, updated_at_ms
) VALUES (1, 'firebase', NULL, 0, 0);

CREATE TABLE wager_reservation_write_admissions (
  admission_id TEXT PRIMARY KEY,
  storage_mode TEXT NOT NULL CHECK (storage_mode IN ('firebase', 'd1')),
  freeze_generation INTEGER NOT NULL CHECK (freeze_generation >= 0),
  kind TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  uncertain INTEGER NOT NULL DEFAULT 0 CHECK (uncertain IN (0, 1))
);

CREATE INDEX idx_wager_reservation_admission_expiry
ON wager_reservation_write_admissions (expires_at_ms);

CREATE TABLE wager_reservation_write_guards (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
);

CREATE TRIGGER wager_reservation_control_no_delete
BEFORE DELETE ON wager_reservation_runtime_control
BEGIN
  SELECT RAISE(ABORT, 'wager reservation control is permanent');
END;

CREATE TRIGGER wager_reservation_control_no_replace
BEFORE INSERT ON wager_reservation_runtime_control
WHEN EXISTS (SELECT 1 FROM wager_reservation_runtime_control)
BEGIN
  SELECT RAISE(ABORT, 'wager reservation control is permanent');
END;

CREATE TRIGGER wager_reservation_control_irreversible
BEFORE UPDATE ON wager_reservation_runtime_control
WHEN OLD.activated_at_ms IS NOT NULL AND (
      NEW.activated_at_ms IS NOT OLD.activated_at_ms
      OR NEW.storage_mode = 'firebase'
      OR NEW.previous_storage_mode = 'firebase'
    )
BEGIN
  SELECT RAISE(ABORT, 'wager reservation activation is irreversible');
END;

CREATE TRIGGER wager_reservation_control_freeze
BEFORE UPDATE ON wager_reservation_runtime_control
WHEN NEW.storage_mode = 'frozen' AND OLD.storage_mode != 'frozen' AND (
      NEW.previous_storage_mode != OLD.storage_mode
      OR NEW.freeze_generation != OLD.freeze_generation + 1
      OR NEW.verified_import_generation IS NOT NULL
    )
BEGIN
  SELECT RAISE(ABORT, 'invalid wager reservation freeze');
END;

CREATE TRIGGER wager_reservation_control_generation
BEFORE UPDATE ON wager_reservation_runtime_control
WHEN NOT (NEW.storage_mode = 'frozen' AND OLD.storage_mode != 'frozen')
    AND NEW.freeze_generation != OLD.freeze_generation
BEGIN
  SELECT RAISE(ABORT, 'invalid wager reservation generation');
END;

CREATE TRIGGER wager_reservation_control_transition
BEFORE UPDATE ON wager_reservation_runtime_control
WHEN NEW.storage_mode != OLD.storage_mode AND NEW.storage_mode != 'frozen'
    AND OLD.storage_mode != 'frozen'
BEGIN
  SELECT RAISE(ABORT, 'wager reservation transition requires freeze');
END;

CREATE TRIGGER wager_reservation_control_drain
BEFORE UPDATE ON wager_reservation_runtime_control
WHEN OLD.storage_mode = 'frozen' AND NEW.storage_mode != 'frozen'
    AND EXISTS (SELECT 1 FROM wager_reservation_write_admissions)
BEGIN
  SELECT RAISE(ABORT, 'wager reservation writers are not drained');
END;

CREATE TRIGGER wager_reservation_control_activation
BEFORE UPDATE ON wager_reservation_runtime_control
WHEN NEW.storage_mode = 'd1' AND OLD.activated_at_ms IS NULL AND (
      OLD.storage_mode != 'frozen'
      OR OLD.previous_storage_mode != 'firebase'
      OR NEW.activated_at_ms IS NULL
      OR NEW.import_attempt_id IS NOT NULL
      OR NEW.verified_import_generation IS NOT NEW.freeze_generation
      OR NEW.source_digest IS NULL OR length(NEW.source_digest) != 64
      OR NEW.source_balance_count IS NULL OR NEW.source_balance_count < 0
      OR NEW.source_operation_count IS NULL OR NEW.source_operation_count < 0
      OR NEW.source_first_exported_at_ms IS NULL
      OR NEW.source_exported_at_ms IS NULL
      OR NEW.source_exported_at_ms - NEW.source_first_exported_at_ms < 360000
      OR NEW.queues_paused_at_ms IS NULL
      OR NEW.source_exported_at_ms - NEW.queues_paused_at_ms < 900000
      OR NEW.bridge_deployed_at_ms IS NULL
      OR NEW.bridge_deployed_at_ms > NEW.source_first_exported_at_ms
      OR NEW.bridge_version_id IS NULL OR length(NEW.bridge_version_id) = 0
      OR NOT EXISTS (
        SELECT 1 FROM profile_canonical_control WHERE singleton = 1 AND state = 'frozen'
      )
    )
BEGIN
  SELECT RAISE(ABORT, 'wager reservation import is not verified');
END;

CREATE TRIGGER wager_reservation_control_proof
BEFORE UPDATE ON wager_reservation_runtime_control
WHEN NEW.verified_import_generation IS NOT NULL
    AND NEW.verified_import_generation IS NOT OLD.verified_import_generation AND (
      NEW.storage_mode != 'frozen'
      OR NEW.previous_storage_mode != 'firebase'
      OR NEW.verified_import_generation != NEW.freeze_generation
      OR EXISTS (SELECT 1 FROM wager_reservation_write_admissions)
      OR OLD.import_attempt_id IS NULL
      OR NEW.import_attempt_id IS NOT NULL
    )
BEGIN
  SELECT RAISE(ABORT, 'invalid wager reservation import proof');
END;

CREATE TRIGGER wager_reservation_control_import_claim
BEFORE UPDATE ON wager_reservation_runtime_control
WHEN NEW.import_attempt_id IS NOT NULL AND NEW.import_attempt_id IS NOT OLD.import_attempt_id AND (
      OLD.import_attempt_id IS NOT NULL
      OR NEW.storage_mode != 'frozen' OR NEW.previous_storage_mode != 'firebase'
      OR NEW.activated_at_ms IS NOT NULL OR NEW.verified_import_generation IS NOT NULL
      OR NEW.import_started_at_ms IS NULL OR NEW.import_started_at_ms < 0
      OR EXISTS (SELECT 1 FROM wager_reservation_write_admissions)
      OR NOT EXISTS (SELECT 1 FROM profile_canonical_control WHERE singleton = 1 AND state = 'frozen')
    )
BEGIN
  SELECT RAISE(ABORT, 'invalid wager reservation import claim');
END;

CREATE TRIGGER wager_reservation_control_import_in_progress
BEFORE UPDATE ON wager_reservation_runtime_control
WHEN NEW.import_attempt_id IS NOT NULL AND NEW.storage_mode != 'frozen'
BEGIN
  SELECT RAISE(ABORT, 'wager reservation import is still active');
END;

CREATE TRIGGER wager_reservation_admission_gate
BEFORE INSERT ON wager_reservation_write_admissions
WHEN NOT EXISTS (
  SELECT 1 FROM wager_reservation_runtime_control AS reservation
  JOIN profile_canonical_control AS profile ON profile.singleton = 1
  WHERE reservation.singleton = 1
    AND reservation.storage_mode = NEW.storage_mode
    AND reservation.freeze_generation = NEW.freeze_generation
    AND profile.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'wager reservation writes are disabled');
END;
