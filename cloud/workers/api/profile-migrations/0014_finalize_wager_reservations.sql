INSERT INTO wager_reservation_write_guards (singleton)
SELECT 0
WHERE NOT EXISTS (
  SELECT 1 FROM wager_reservation_runtime_control
  WHERE singleton = 1 AND storage_mode = 'frozen'
    AND previous_storage_mode = 'd1' AND activated_at_ms IS NOT NULL
    AND import_attempt_id IS NULL
)
OR NOT EXISTS (
  SELECT 1 FROM profile_canonical_control WHERE singleton = 1 AND state = 'frozen'
)
OR EXISTS (SELECT 1 FROM wager_reservation_write_admissions);

CREATE TABLE wager_reservation_runtime_control_next (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  storage_mode TEXT NOT NULL CHECK (storage_mode IN ('frozen', 'd1')),
  freeze_generation INTEGER NOT NULL CHECK (freeze_generation >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
);

INSERT INTO wager_reservation_runtime_control_next (
  singleton, storage_mode, freeze_generation, updated_at_ms
)
SELECT singleton, storage_mode, freeze_generation, updated_at_ms
FROM wager_reservation_runtime_control;

DROP TABLE wager_reservation_write_admissions;
DROP TABLE wager_reservation_runtime_control;
ALTER TABLE wager_reservation_runtime_control_next
RENAME TO wager_reservation_runtime_control;

CREATE TABLE wager_reservation_write_admissions (
  admission_id TEXT PRIMARY KEY,
  freeze_generation INTEGER NOT NULL CHECK (freeze_generation >= 0),
  kind TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  uncertain INTEGER NOT NULL DEFAULT 0 CHECK (uncertain IN (0, 1))
);

CREATE INDEX idx_wager_reservation_admission_expiry
ON wager_reservation_write_admissions (expires_at_ms);

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

CREATE TRIGGER wager_reservation_control_freeze
BEFORE UPDATE ON wager_reservation_runtime_control
WHEN NEW.storage_mode = 'frozen' AND OLD.storage_mode != 'frozen'
  AND NEW.freeze_generation != OLD.freeze_generation + 1
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

CREATE TRIGGER wager_reservation_control_drain
BEFORE UPDATE ON wager_reservation_runtime_control
WHEN OLD.storage_mode = 'frozen' AND NEW.storage_mode != 'frozen'
  AND EXISTS (SELECT 1 FROM wager_reservation_write_admissions)
BEGIN
  SELECT RAISE(ABORT, 'wager reservation writers are not drained');
END;

CREATE TRIGGER wager_reservation_admission_gate
BEFORE INSERT ON wager_reservation_write_admissions
WHEN NOT EXISTS (
  SELECT 1 FROM wager_reservation_runtime_control AS reservation
  JOIN profile_canonical_control AS profile ON profile.singleton = 1
  WHERE reservation.singleton = 1 AND reservation.storage_mode = 'd1'
    AND reservation.freeze_generation = NEW.freeze_generation
    AND profile.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'wager reservation writes are disabled');
END;
