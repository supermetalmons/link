CREATE TABLE event_transaction_guards (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
);

INSERT INTO event_transaction_guards (singleton) VALUES (1);

CREATE TABLE event_records (
  event_id TEXT PRIMARY KEY CHECK (event_id != '' AND instr(event_id, '/') = 0),
  status TEXT NOT NULL CHECK (
    status IN ('scheduled', 'active', 'ended', 'dismissed')
  ),
  start_at_ms INTEGER NOT NULL CHECK (start_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  pending_transition_id TEXT CHECK (
    pending_transition_id IS NULL OR pending_transition_id != ''
  ),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) = 'object'
  )
) WITHOUT ROWID;

CREATE INDEX idx_event_records_status_start
ON event_records (status, start_at_ms, event_id);

CREATE INDEX idx_event_records_updated
ON event_records (updated_at_ms, event_id);

CREATE TABLE event_prize_selections (
  event_id TEXT NOT NULL,
  profile_id TEXT NOT NULL CHECK (profile_id != '' AND instr(profile_id, '/') = 0),
  prize_id TEXT NOT NULL CHECK (prize_id != '' AND instr(prize_id, '/') = 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (event_id, profile_id),
  FOREIGN KEY (event_id) REFERENCES event_records(event_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_event_prize_selections_profile
ON event_prize_selections (profile_id, event_id);

CREATE TABLE profile_event_prizes (
  profile_id TEXT NOT NULL CHECK (profile_id != '' AND instr(profile_id, '/') = 0),
  event_id TEXT NOT NULL,
  assignment_json TEXT NOT NULL CHECK (
    json_valid(assignment_json) AND json_type(assignment_json) = 'object'
  ),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (profile_id, event_id),
  FOREIGN KEY (event_id) REFERENCES event_records(event_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_profile_event_prizes_event
ON profile_event_prizes (event_id, profile_id);

CREATE TABLE profile_event_prize_revisions (
  profile_id TEXT PRIMARY KEY CHECK (profile_id != '' AND instr(profile_id, '/') = 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) WITHOUT ROWID;

CREATE TABLE event_leases (
  event_id TEXT PRIMARY KEY CHECK (event_id != '' AND instr(event_id, '/') = 0),
  lease_id TEXT NOT NULL CHECK (lease_id != ''),
  owner_uid TEXT NOT NULL CHECK (owner_uid != ''),
  acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
  refreshed_at_ms INTEGER NOT NULL CHECK (refreshed_at_ms >= acquired_at_ms),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > refreshed_at_ms)
) WITHOUT ROWID;

CREATE INDEX idx_event_leases_expiry
ON event_leases (expires_at_ms, event_id);

CREATE TABLE event_sync_throttles (
  event_id TEXT PRIMARY KEY CHECK (event_id != '' AND instr(event_id, '/') = 0),
  owner_uid TEXT NOT NULL CHECK (owner_uid != ''),
  token TEXT NOT NULL CHECK (token != ''),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0)
) WITHOUT ROWID;

CREATE INDEX idx_event_sync_throttles_started
ON event_sync_throttles (started_at_ms, event_id);

CREATE TABLE event_transition_intents (
  transition_id TEXT PRIMARY KEY CHECK (
    transition_id != '' AND instr(transition_id, '/') = 0
  ),
  event_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'dead')),
  intent_json TEXT NOT NULL CHECK (
    json_valid(intent_json) AND json_type(intent_json) = 'object'
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (event_id) REFERENCES event_records(event_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_event_transition_intents_pending
ON event_transition_intents (status, updated_at_ms, transition_id);

CREATE TABLE event_progress_outboxes (
  outbox_id TEXT PRIMARY KEY CHECK (outbox_id != '' AND instr(outbox_id, '/') = 0),
  event_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dead')),
  run_at_ms INTEGER CHECK (run_at_ms IS NULL OR run_at_ms >= 0),
  last_queued_at_ms INTEGER NOT NULL CHECK (last_queued_at_ms >= 0),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) = 'object'
  ),
  FOREIGN KEY (event_id) REFERENCES event_records(event_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_event_progress_outboxes_due
ON event_progress_outboxes (status, last_queued_at_ms, outbox_id);

CREATE INDEX idx_event_progress_outboxes_event
ON event_progress_outboxes (event_id, outbox_id);

CREATE TABLE event_profile_game_projection_outboxes (
  event_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL CHECK (request_id != ''),
  status TEXT NOT NULL CHECK (status IN ('pending', 'dead')),
  last_queued_at_ms INTEGER NOT NULL CHECK (last_queued_at_ms >= 0),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) = 'object'
  ),
  FOREIGN KEY (event_id) REFERENCES event_records(event_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_event_profile_game_projection_outboxes_due
ON event_profile_game_projection_outboxes (status, last_queued_at_ms, event_id);

CREATE TABLE event_telegram_projection_outboxes (
  event_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL CHECK (request_id != ''),
  status TEXT NOT NULL CHECK (status IN ('pending', 'dead')),
  first_queued_at_ms INTEGER NOT NULL CHECK (first_queued_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= first_queued_at_ms),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) = 'object'
  ),
  FOREIGN KEY (event_id) REFERENCES event_records(event_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_event_telegram_projection_outboxes_due
ON event_telegram_projection_outboxes (status, updated_at_ms, event_id);

CREATE TABLE event_telegram_projection_state (
  event_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  state_json TEXT NOT NULL CHECK (
    json_valid(state_json) AND json_type(state_json) = 'object'
  ),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  FOREIGN KEY (event_id) REFERENCES event_records(event_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE event_runtime_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  storage_mode TEXT NOT NULL CHECK (
    storage_mode IN ('firebase', 'frozen', 'd1')
  ),
  previous_storage_mode TEXT CHECK (
    previous_storage_mode IS NULL OR previous_storage_mode IN ('firebase', 'd1')
  ),
  source_digest TEXT CHECK (
    source_digest IS NULL OR length(source_digest) = 64
  ),
  source_event_count INTEGER CHECK (
    source_event_count IS NULL OR source_event_count >= 0
  ),
  source_selection_count INTEGER CHECK (
    source_selection_count IS NULL OR source_selection_count >= 0
  ),
  source_assignment_count INTEGER CHECK (
    source_assignment_count IS NULL OR source_assignment_count >= 0
  ),
  source_exported_at_ms INTEGER CHECK (
    source_exported_at_ms IS NULL OR source_exported_at_ms > 0
  ),
  cutover_at_ms INTEGER CHECK (cutover_at_ms IS NULL OR cutover_at_ms > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK (
    (storage_mode IN ('firebase', 'd1') AND previous_storage_mode IS NULL)
    OR (storage_mode = 'frozen' AND previous_storage_mode IS NOT NULL)
  )
);

INSERT INTO event_runtime_control (
  singleton,
  storage_mode,
  previous_storage_mode,
  updated_at_ms
) VALUES (1, 'firebase', NULL, 1);

CREATE TRIGGER event_runtime_control_reject_delete
BEFORE DELETE ON event_runtime_control
BEGIN
  SELECT RAISE(ABORT, 'event runtime control cannot be deleted');
END;

CREATE TRIGGER event_runtime_control_validate_transition
BEFORE UPDATE OF storage_mode, previous_storage_mode ON event_runtime_control
WHEN NOT (
  (OLD.storage_mode = NEW.storage_mode AND OLD.previous_storage_mode IS NEW.previous_storage_mode)
  OR (
    OLD.storage_mode = 'firebase'
    AND OLD.previous_storage_mode IS NULL
    AND NEW.storage_mode = 'frozen'
    AND NEW.previous_storage_mode = 'firebase'
  )
  OR (
    OLD.storage_mode = 'd1'
    AND OLD.previous_storage_mode IS NULL
    AND NEW.storage_mode = 'frozen'
    AND NEW.previous_storage_mode = 'd1'
  )
  OR (
    OLD.storage_mode = 'frozen'
    AND OLD.previous_storage_mode = 'firebase'
    AND NEW.storage_mode = 'firebase'
    AND NEW.previous_storage_mode IS NULL
  )
  OR (
    OLD.storage_mode = 'frozen'
    AND OLD.previous_storage_mode = 'firebase'
    AND NEW.storage_mode = 'd1'
    AND NEW.previous_storage_mode IS NULL
    AND OLD.source_digest IS NOT NULL
    AND OLD.source_event_count IS NOT NULL
    AND OLD.source_selection_count IS NOT NULL
    AND OLD.source_assignment_count IS NOT NULL
    AND OLD.source_exported_at_ms IS NOT NULL
    AND NEW.cutover_at_ms IS NOT NULL
  )
  OR (
    OLD.storage_mode = 'frozen'
    AND OLD.previous_storage_mode = 'd1'
    AND NEW.storage_mode = 'd1'
    AND NEW.previous_storage_mode IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid event storage transition');
END;

CREATE TRIGGER event_records_require_pending_intent_insert
BEFORE INSERT ON event_records
WHEN NEW.pending_transition_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1 FROM event_transition_intents
  WHERE transition_id = NEW.pending_transition_id
    AND event_id = NEW.event_id
    AND status = 'pending'
)
BEGIN
  SELECT RAISE(ABORT, 'event pending transition is unavailable');
END;

CREATE TRIGGER event_records_require_pending_intent_update
BEFORE UPDATE OF pending_transition_id ON event_records
WHEN NEW.pending_transition_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1 FROM event_transition_intents
  WHERE transition_id = NEW.pending_transition_id
    AND event_id = NEW.event_id
    AND status = 'pending'
)
BEGIN
  SELECT RAISE(ABORT, 'event pending transition is unavailable');
END;

CREATE TRIGGER event_transition_intents_reject_live_delete
BEFORE DELETE ON event_transition_intents
WHEN EXISTS (
  SELECT 1 FROM event_records
  WHERE event_id = OLD.event_id
    AND pending_transition_id = OLD.transition_id
)
BEGIN
  SELECT RAISE(ABORT, 'event transition is still attached');
END;
