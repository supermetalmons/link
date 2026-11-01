CREATE TABLE application_data_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation INTEGER NOT NULL CHECK (generation > 0),
  data_epoch INTEGER NOT NULL CHECK (data_epoch IN (0, 1)),
  phase TEXT NOT NULL CHECK (phase IN ('active', 'closing', 'closed', 'verifying')),
  migration_id TEXT CHECK (migration_id IS NULL OR length(migration_id) BETWEEN 1 AND 256),
  CHECK (phase = 'active' OR migration_id IS NOT NULL)
) STRICT;

INSERT INTO application_data_control VALUES (1, 1, 0, 'active', NULL);

CREATE TRIGGER application_data_generation_monotonic
BEFORE UPDATE ON application_data_control
WHEN NEW.generation < OLD.generation
BEGIN SELECT RAISE(ABORT, 'application-generation-regression'); END;

CREATE TABLE application_write_context (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation INTEGER NOT NULL CHECK (generation > 0),
  data_epoch INTEGER NOT NULL CHECK (data_epoch IN (0, 1)),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
  migration_id TEXT CHECK (migration_id IS NULL OR length(migration_id) BETWEEN 1 AND 256)
) STRICT;

CREATE TRIGGER application_write_context_admission
BEFORE INSERT ON application_write_context
WHEN NOT EXISTS (
  SELECT 1 FROM application_data_control c
  WHERE c.singleton = 1 AND c.generation = NEW.generation AND c.data_epoch = NEW.data_epoch
  AND ((NEW.migration_id IS NULL AND c.phase IN ('active', 'closing'))
    OR (NEW.migration_id = c.migration_id AND c.phase IN ('closed', 'verifying'))))
BEGIN SELECT RAISE(ABORT, 'application-write-fenced'); END;

CREATE TABLE IF NOT EXISTS application_migration_selection (
  migration_id TEXT NOT NULL CHECK (length(migration_id) BETWEEN 1 AND 256),
  generation INTEGER NOT NULL CHECK (generation > 0),
  data_epoch INTEGER NOT NULL CHECK (data_epoch IN (0, 1)),
  verification_digest TEXT NOT NULL CHECK (length(verification_digest) = 64 AND verification_digest NOT GLOB '*[^a-f0-9]*'),
  selected_at_ms INTEGER NOT NULL CHECK (selected_at_ms >= 0),
  PRIMARY KEY (migration_id, generation, data_epoch)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS application_retired_executions (
  execution_kind TEXT NOT NULL CHECK (execution_kind IN ('auth-recovery', 'profile-game-projection', 'event-profile-game-projection', 'telegram-projection', 'telegram-delivery', 'wager-settlement', 'event-progress', 'prize-withdrawal', 'auth-intent', 'auth-flow', 'auth-operation', 'rating', 'profile-link-projection', 'match-effect', 'game-session-transition', 'event-transition')),
  execution_id TEXT NOT NULL CHECK (length(execution_id) BETWEEN 1 AND 512),
  business_key TEXT NOT NULL CHECK (length(business_key) BETWEEN 1 AND 512),
  data_epoch INTEGER NOT NULL CHECK (data_epoch IN (0, 1)),
  migration_id TEXT NOT NULL CHECK (length(migration_id) BETWEEN 1 AND 256),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64 AND source_digest NOT GLOB '*[^a-f0-9]*'),
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^a-f0-9]*'),
  retired_at_ms INTEGER NOT NULL CHECK (retired_at_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('cancelled', 'blocked')),
  reason TEXT NOT NULL CHECK (reason IN ('maintenance-cancelled', 'outcome-uncertain', 'resolution-unavailable', 'partial-effect')),
  PRIMARY KEY (execution_kind, execution_id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS application_retired_execution_update_guard BEFORE UPDATE ON application_retired_executions BEGIN SELECT RAISE(ABORT, 'retired-execution-immutable'); END;
CREATE TRIGGER IF NOT EXISTS application_retired_execution_delete_guard BEFORE DELETE ON application_retired_executions BEGIN SELECT RAISE(ABORT, 'retired-execution-immutable'); END;
CREATE TRIGGER IF NOT EXISTS application_retired_execution_insert_guard BEFORE INSERT ON application_retired_executions WHEN EXISTS (SELECT 1 FROM application_retired_executions WHERE execution_kind = NEW.execution_kind AND execution_id = NEW.execution_id AND (business_key IS NOT NEW.business_key OR data_epoch IS NOT NEW.data_epoch OR migration_id IS NOT NEW.migration_id OR source_digest IS NOT NEW.source_digest OR evidence_digest IS NOT NEW.evidence_digest OR retired_at_ms IS NOT NEW.retired_at_ms OR outcome IS NOT NEW.outcome OR reason IS NOT NEW.reason)) BEGIN SELECT RAISE(ABORT, 'retired-execution-conflict'); END;
