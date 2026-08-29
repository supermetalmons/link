CREATE TABLE profile_records (
  profile_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('active', 'retiring')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json) AND json_type(payload_json) = 'object'
  ),
  gameplay_emoji_json TEXT NOT NULL DEFAULT '""' CHECK (
    json_valid(gameplay_emoji_json)
    AND json_type(gameplay_emoji_json) IN ('text', 'integer', 'real')
  ),
  username_key TEXT UNIQUE,
  merged_into_profile_id TEXT,
  legacy_fields_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(legacy_fields_json)
    AND json_type(legacy_fields_json) = 'object'
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  merged_at_ms INTEGER CHECK (merged_at_ms IS NULL OR merged_at_ms >= 0),
  rating_sort REAL,
  mana_points_sort REAL,
  nonce_sort REAL,
  dust_sort REAL,
  slime_sort REAL,
  gum_sort REAL,
  metal_sort REAL,
  ice_sort REAL,
  rating_sort_present INTEGER NOT NULL CHECK (
    rating_sort_present IN (0, 1)
  ),
  mana_points_sort_present INTEGER NOT NULL CHECK (
    mana_points_sort_present IN (0, 1)
  ),
  nonce_sort_present INTEGER NOT NULL CHECK (
    nonce_sort_present IN (0, 1)
  ),
  dust_sort_present INTEGER NOT NULL CHECK (dust_sort_present IN (0, 1)),
  slime_sort_present INTEGER NOT NULL CHECK (slime_sort_present IN (0, 1)),
  gum_sort_present INTEGER NOT NULL CHECK (gum_sort_present IN (0, 1)),
  metal_sort_present INTEGER NOT NULL CHECK (metal_sort_present IN (0, 1)),
  ice_sort_present INTEGER NOT NULL CHECK (ice_sort_present IN (0, 1)),
  win_present INTEGER NOT NULL CHECK (win_present IN (0, 1)),
  emoji_present INTEGER NOT NULL CHECK (emoji_present IN (0, 1)),
  CHECK (profile_id != '' AND instr(profile_id, '/') = 0),
  CHECK (username_key IS NULL OR username_key != ''),
  CHECK (
    (state = 'active' AND merged_into_profile_id IS NULL)
    OR (
      state = 'retiring'
      AND merged_into_profile_id IS NOT NULL
      AND merged_into_profile_id != ''
      AND merged_into_profile_id != profile_id
    )
  ),
  CHECK (rating_sort_present = 1 OR rating_sort IS NULL),
  CHECK (mana_points_sort_present = 1 OR mana_points_sort IS NULL),
  CHECK (nonce_sort_present = 1 OR nonce_sort IS NULL),
  CHECK (dust_sort_present = 1 OR dust_sort IS NULL),
  CHECK (slime_sort_present = 1 OR slime_sort IS NULL),
  CHECK (gum_sort_present = 1 OR gum_sort IS NULL),
  CHECK (metal_sort_present = 1 OR metal_sort IS NULL),
  CHECK (ice_sort_present = 1 OR ice_sort IS NULL)
) WITHOUT ROWID;

CREATE INDEX idx_profile_records_rating
ON profile_records (
  state,
  rating_sort_present,
  rating_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profile_records_mana_points
ON profile_records (
  state,
  mana_points_sort_present,
  mana_points_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profile_records_nonce
ON profile_records (
  state,
  nonce_sort_present,
  nonce_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profile_records_dust
ON profile_records (
  state,
  dust_sort_present,
  dust_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profile_records_slime
ON profile_records (
  state,
  slime_sort_present,
  slime_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profile_records_gum
ON profile_records (
  state,
  gum_sort_present,
  gum_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profile_records_metal
ON profile_records (
  state,
  metal_sort_present,
  metal_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profile_records_ice
ON profile_records (
  state,
  ice_sort_present,
  ice_sort DESC,
  profile_id DESC
);

CREATE TABLE profile_login_owners (
  login_uid TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (login_uid != ''),
  FOREIGN KEY (profile_id) REFERENCES profile_records(profile_id)
    ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_profile_login_owners_profile
ON profile_login_owners (profile_id, login_uid);

CREATE TRIGGER profile_login_owners_require_active_profile_insert
BEFORE INSERT ON profile_login_owners
WHEN NOT EXISTS (
  SELECT 1 FROM profile_records
  WHERE profile_id = NEW.profile_id AND state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'profile login owner target is not active');
END;

CREATE TRIGGER profile_login_owners_require_active_profile_update
BEFORE UPDATE ON profile_login_owners
WHEN NOT EXISTS (
  SELECT 1 FROM profile_records
  WHERE profile_id = NEW.profile_id AND state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'profile login owner target is not active');
END;

CREATE TABLE profile_auth_methods (
  method TEXT NOT NULL CHECK (method IN ('eth', 'sol', 'apple', 'x')),
  normalized_value TEXT NOT NULL CHECK (normalized_value != ''),
  profile_id TEXT NOT NULL,
  raw_value TEXT NOT NULL CHECK (raw_value != ''),
  apple_email_masked TEXT,
  x_username TEXT,
  linked_at_ms INTEGER CHECK (linked_at_ms IS NULL OR linked_at_ms >= 0),
  consent_at_ms INTEGER CHECK (consent_at_ms IS NULL OR consent_at_ms >= 0),
  consent_source TEXT CHECK (
    consent_source IS NULL OR consent_source IN ('signin', 'settings')
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  PRIMARY KEY (method, normalized_value),
  UNIQUE (profile_id, method),
  CHECK (method = 'apple' OR apple_email_masked IS NULL),
  CHECK (method = 'x' OR x_username IS NULL),
  FOREIGN KEY (profile_id) REFERENCES profile_records(profile_id)
    ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_profile_auth_methods_profile
ON profile_auth_methods (profile_id, method);

CREATE TABLE profile_merge_targets (
  source_profile_id TEXT PRIMARY KEY,
  target_profile_id TEXT NOT NULL,
  merged_at_ms INTEGER NOT NULL CHECK (merged_at_ms >= 0),
  op_id TEXT,
  source_legacy_fields_json TEXT NOT NULL CHECK (
    json_valid(source_legacy_fields_json)
    AND json_type(source_legacy_fields_json) = 'object'
  ),
  CHECK (
    source_profile_id != ''
    AND target_profile_id != ''
    AND source_profile_id != target_profile_id
  )
) WITHOUT ROWID;

CREATE INDEX idx_profile_merge_targets_target
ON profile_merge_targets (target_profile_id, source_profile_id);

CREATE TRIGGER profile_merge_targets_require_retired_source
BEFORE INSERT ON profile_merge_targets
WHEN (
  SELECT state FROM profile_canonical_control WHERE singleton = 1
) != 'importing'
AND EXISTS (
  SELECT 1
  FROM profile_records
  WHERE profile_id = NEW.source_profile_id
    AND (
      state != 'retiring'
      OR merged_into_profile_id IS NOT NEW.target_profile_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'profile merge source is not retired');
END;

CREATE TRIGGER profile_merge_targets_require_runtime_target
BEFORE INSERT ON profile_merge_targets
WHEN (
  SELECT state FROM profile_canonical_control WHERE singleton = 1
) != 'importing'
AND NOT EXISTS (
  SELECT 1
  FROM profile_records
  WHERE profile_id = NEW.target_profile_id AND state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'profile merge target is not active');
END;

CREATE TRIGGER profile_merge_targets_reject_cycle
BEFORE INSERT ON profile_merge_targets
WHEN EXISTS (
  WITH RECURSIVE targets(profile_id) AS (
    VALUES (NEW.target_profile_id)
    UNION
    SELECT target.target_profile_id
    FROM profile_merge_targets AS target
    JOIN targets ON target.source_profile_id = targets.profile_id
  )
  SELECT 1 FROM targets WHERE profile_id = NEW.source_profile_id
)
BEGIN
  SELECT RAISE(ABORT, 'profile merge cycle');
END;

CREATE TRIGGER profile_merge_targets_reject_depth
BEFORE INSERT ON profile_merge_targets
WHEN (
  WITH RECURSIVE
  ancestors(profile_id, depth) AS (
    VALUES (NEW.source_profile_id, 0)
    UNION ALL
    SELECT target.source_profile_id, ancestors.depth + 1
    FROM profile_merge_targets AS target
    JOIN ancestors ON target.target_profile_id = ancestors.profile_id
    WHERE ancestors.depth < 32
  ),
  descendants(profile_id, depth) AS (
    VALUES (NEW.target_profile_id, 0)
    UNION ALL
    SELECT target.target_profile_id, descendants.depth + 1
    FROM profile_merge_targets AS target
    JOIN descendants ON target.source_profile_id = descendants.profile_id
    WHERE descendants.depth < 32
  )
  SELECT MAX(ancestors.depth) + 1 + (
    SELECT MAX(descendants.depth) FROM descendants
  ) > 32
  FROM ancestors
)
BEGIN
  SELECT RAISE(ABORT, 'profile merge depth exceeded');
END;

CREATE TRIGGER profile_records_require_matching_merge_target_insert
BEFORE INSERT ON profile_records
WHEN (
  SELECT state FROM profile_canonical_control WHERE singleton = 1
) != 'importing'
AND EXISTS (
  SELECT 1
  FROM profile_merge_targets
  WHERE source_profile_id = NEW.profile_id
    AND (
      NEW.state != 'retiring'
      OR target_profile_id IS NOT NEW.merged_into_profile_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'profile merge source does not match mapping');
END;

CREATE TRIGGER profile_records_require_matching_merge_target_update
BEFORE UPDATE ON profile_records
WHEN (
  SELECT state FROM profile_canonical_control WHERE singleton = 1
) != 'importing'
AND EXISTS (
  SELECT 1
  FROM profile_merge_targets
  WHERE source_profile_id = NEW.profile_id
    AND (
      NEW.state != 'retiring'
      OR target_profile_id IS NOT NEW.merged_into_profile_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'profile merge source does not match mapping');
END;

CREATE TRIGGER profile_records_reject_active_delete
BEFORE DELETE ON profile_records
WHEN OLD.state = 'active'
AND (
  SELECT state FROM profile_canonical_control WHERE singleton = 1
) != 'importing'
BEGIN
  SELECT RAISE(ABORT, 'active profiles cannot be deleted');
END;

CREATE TRIGGER profile_merge_targets_reject_update
BEFORE UPDATE ON profile_merge_targets
BEGIN
  SELECT RAISE(ABORT, 'profile merge mappings are immutable');
END;

CREATE TRIGGER profile_merge_targets_reject_replace
BEFORE INSERT ON profile_merge_targets
WHEN EXISTS (
  SELECT 1 FROM profile_merge_targets
  WHERE source_profile_id = NEW.source_profile_id
    AND (
      target_profile_id IS NOT NEW.target_profile_id
      OR merged_at_ms IS NOT NEW.merged_at_ms
      OR op_id IS NOT NEW.op_id
      OR source_legacy_fields_json IS NOT NEW.source_legacy_fields_json
    )
)
BEGIN
  SELECT RAISE(ABORT, 'profile merge mappings are immutable');
END;

CREATE TRIGGER profile_merge_targets_reject_delete
BEFORE DELETE ON profile_merge_targets
BEGIN
  SELECT RAISE(ABORT, 'profile merge mappings are permanent');
END;

CREATE TABLE profile_february_opponents (
  profile_id TEXT NOT NULL,
  opponent_profile_id TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
  PRIMARY KEY (profile_id, opponent_profile_id),
  CHECK (profile_id != opponent_profile_id),
  FOREIGN KEY (profile_id) REFERENCES profile_records(profile_id)
    ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_profile_february_opponents_opponent
ON profile_february_opponents (opponent_profile_id, profile_id);

CREATE TABLE profile_auth_operations (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('unlink', 'verify')),
  method TEXT NOT NULL CHECK (method IN ('eth', 'sol', 'apple', 'x')),
  login_uid TEXT NOT NULL CHECK (login_uid != ''),
  status TEXT NOT NULL CHECK (status IN ('started', 'failed', 'success')),
  meta_json TEXT CHECK (
    meta_json IS NULL
    OR (json_valid(meta_json) AND json_type(meta_json) = 'object')
  ),
  result_json TEXT CHECK (
    result_json IS NULL
    OR (json_valid(result_json) AND json_type(result_json) = 'object')
  ),
  error_code TEXT,
  error_message TEXT,
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= started_at_ms),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK (operation_id != '')
) WITHOUT ROWID;

CREATE INDEX idx_profile_auth_operations_sweep
ON profile_auth_operations (status, updated_at_ms, operation_id);

CREATE TABLE profile_auth_method_revocations (
  method TEXT NOT NULL CHECK (method IN ('eth', 'sol', 'apple', 'x')),
  normalized_value TEXT NOT NULL CHECK (normalized_value != ''),
  profile_id TEXT NOT NULL CHECK (profile_id != ''),
  scope TEXT NOT NULL CHECK (scope != ''),
  unlinked_by_uid TEXT NOT NULL CHECK (unlinked_by_uid != ''),
  cooldown_ms INTEGER NOT NULL CHECK (cooldown_ms > 0),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  retry_at_ms INTEGER NOT NULL CHECK (retry_at_ms >= started_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= started_at_ms),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (method, normalized_value)
) WITHOUT ROWID;

CREATE INDEX idx_profile_auth_method_revocations_sweep
ON profile_auth_method_revocations (retry_at_ms, method, normalized_value);

CREATE TABLE profile_auth_method_cooldowns (
  profile_id TEXT NOT NULL CHECK (profile_id != ''),
  method TEXT NOT NULL CHECK (method IN ('eth', 'sol', 'apple', 'x')),
  scope TEXT NOT NULL CHECK (scope != ''),
  unlinked_by_uid TEXT NOT NULL CHECK (unlinked_by_uid != ''),
  cooldown_ms INTEGER NOT NULL CHECK (cooldown_ms > 0),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  retry_at_ms INTEGER NOT NULL CHECK (retry_at_ms >= started_at_ms),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= started_at_ms),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  PRIMARY KEY (profile_id, method)
) WITHOUT ROWID;

CREATE INDEX idx_profile_auth_method_cooldowns_sweep
ON profile_auth_method_cooldowns (retry_at_ms, profile_id, method);

CREATE TABLE profile_auth_recovery_jobs (
  profile_id TEXT PRIMARY KEY,
  login_uids_json TEXT NOT NULL CHECK (
    json_valid(login_uids_json) AND json_type(login_uids_json) = 'array'
  ),
  source_profile_ids_json TEXT NOT NULL CHECK (
    json_valid(source_profile_ids_json)
    AND json_type(source_profile_ids_json) = 'array'
  ),
  source_phase TEXT NOT NULL CHECK (
    source_phase IN ('prizes', 'games', 'finalize')
  ),
  prize_cursor TEXT,
  phase_started_at_ms INTEGER NOT NULL CHECK (phase_started_at_ms >= 0),
  last_enqueued_at_ms INTEGER NOT NULL CHECK (last_enqueued_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  FOREIGN KEY (profile_id) REFERENCES profile_records(profile_id)
    ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_profile_auth_recovery_jobs_sweep
ON profile_auth_recovery_jobs (
  last_enqueued_at_ms,
  updated_at_ms,
  profile_id
);

CREATE TABLE rating_updates (
  operation_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json) AND json_type(payload_json) = 'object'
  ),
  status TEXT NOT NULL CHECK (status IN ('processing', 'done')),
  invite_id TEXT NOT NULL CHECK (invite_id != ''),
  match_id TEXT NOT NULL CHECK (match_id != ''),
  player_id TEXT NOT NULL CHECK (player_id != ''),
  opponent_id TEXT NOT NULL CHECK (opponent_id != ''),
  player_profile_id TEXT,
  opponent_profile_id TEXT,
  owner_uid TEXT NOT NULL CHECK (owner_uid != ''),
  owner_token TEXT NOT NULL CHECK (owner_token != ''),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= started_at_ms),
  lease_expires_at_ms INTEGER NOT NULL CHECK (
    lease_expires_at_ms >= started_at_ms
  ),
  completed_at_ms INTEGER CHECK (
    completed_at_ms IS NULL OR completed_at_ms >= started_at_ms
  ),
  telegram_projection_state TEXT CHECK (
    telegram_projection_state IS NULL
    OR telegram_projection_state IN ('pending', 'done', 'dead')
  ),
  telegram_projection_updated_at_ms INTEGER CHECK (
    telegram_projection_updated_at_ms IS NULL
    OR telegram_projection_updated_at_ms >= 0
  ),
  telegram_projection_version INTEGER CHECK (
    telegram_projection_version IS NULL OR telegram_projection_version >= 0
  ),
  profile_game_projection_state TEXT CHECK (
    profile_game_projection_state IS NULL
    OR profile_game_projection_state IN ('pending', 'done', 'dead')
  ),
  profile_game_projection_updated_at_ms INTEGER CHECK (
    profile_game_projection_updated_at_ms IS NULL
    OR profile_game_projection_updated_at_ms >= 0
  ),
  profile_game_projection_version INTEGER CHECK (
    profile_game_projection_version IS NULL
    OR profile_game_projection_version >= 0
  ),
  event_progress_state TEXT CHECK (
    event_progress_state IS NULL
    OR event_progress_state IN ('pending', 'done', 'dead')
  ),
  event_progress_updated_at_ms INTEGER CHECK (
    event_progress_updated_at_ms IS NULL OR event_progress_updated_at_ms >= 0
  ),
  event_progress_version INTEGER CHECK (
    event_progress_version IS NULL OR event_progress_version >= 0
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK (
    (status = 'processing' AND completed_at_ms IS NULL)
    OR (status = 'done' AND completed_at_ms IS NOT NULL)
  )
) WITHOUT ROWID;

CREATE INDEX idx_rating_updates_lease
ON rating_updates (status, lease_expires_at_ms, operation_id);

CREATE INDEX idx_rating_updates_telegram_projection
ON rating_updates (
  telegram_projection_state,
  telegram_projection_updated_at_ms,
  operation_id
);

CREATE INDEX idx_rating_updates_profile_game_projection
ON rating_updates (
  profile_game_projection_state,
  profile_game_projection_updated_at_ms,
  operation_id
);

CREATE INDEX idx_rating_updates_event_progress
ON rating_updates (
  event_progress_state,
  event_progress_updated_at_ms,
  operation_id
);

CREATE TABLE wager_settlements (
  operation_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL CHECK (fingerprint != ''),
  winner_profile_id TEXT NOT NULL CHECK (winner_profile_id != ''),
  loser_profile_id TEXT NOT NULL CHECK (loser_profile_id != ''),
  material TEXT NOT NULL CHECK (
    material IN ('dust', 'slime', 'gum', 'metal', 'ice')
  ),
  count INTEGER NOT NULL CHECK (count > 0),
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision = 1)
) WITHOUT ROWID;

CREATE INDEX idx_wager_settlements_profiles
ON wager_settlements (
  winner_profile_id,
  loser_profile_id,
  applied_at_ms,
  operation_id
);

CREATE TRIGGER wager_settlements_reject_update
BEFORE UPDATE ON wager_settlements
BEGIN
  SELECT RAISE(ABORT, 'wager settlements are immutable');
END;

CREATE TRIGGER wager_settlements_reject_replace
BEFORE INSERT ON wager_settlements
WHEN EXISTS (
  SELECT 1 FROM wager_settlements
  WHERE operation_id = NEW.operation_id
    AND (
      fingerprint IS NOT NEW.fingerprint
      OR winner_profile_id IS NOT NEW.winner_profile_id
      OR loser_profile_id IS NOT NEW.loser_profile_id
      OR material IS NOT NEW.material
      OR count IS NOT NEW.count
      OR applied_at_ms IS NOT NEW.applied_at_ms
      OR revision IS NOT NEW.revision
    )
)
BEGIN
  SELECT RAISE(ABORT, 'wager settlements are immutable');
END;

CREATE TRIGGER wager_settlements_reject_delete
BEFORE DELETE ON wager_settlements
BEGIN
  SELECT RAISE(ABORT, 'wager settlements are permanent');
END;

CREATE TABLE profile_transaction_guards (
  singleton INTEGER NOT NULL CHECK (singleton = 1)
);

CREATE TABLE profile_canonical_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state TEXT NOT NULL CHECK (
    state IN ('firestore', 'importing', 'frozen', 'active')
  ),
  import_digest TEXT,
  import_plan_version INTEGER,
  imported_at_ms INTEGER,
  CHECK (
    (
      import_digest IS NULL
      AND import_plan_version IS NULL
    )
    OR (
      typeof(import_digest) = 'text'
      AND length(import_digest) = 64
      AND import_digest NOT GLOB '*[^a-f0-9]*'
      AND typeof(import_plan_version) = 'integer'
      AND import_plan_version > 0
      AND import_plan_version <= 9007199254740991
    )
  ),
  CHECK (
    (state = 'firestore' AND import_digest IS NULL AND imported_at_ms IS NULL)
    OR (
      state = 'importing'
      AND imported_at_ms IS NULL
    )
    OR (
      state IN ('frozen', 'active')
      AND import_digest IS NOT NULL
      AND typeof(imported_at_ms) = 'integer'
      AND imported_at_ms >= 0
      AND imported_at_ms <= 9007199254740991
    )
  )
);

INSERT INTO profile_canonical_control (
  singleton,
  state,
  import_digest,
  import_plan_version,
  imported_at_ms
)
VALUES (1, 'firestore', NULL, NULL, NULL);

CREATE TRIGGER profile_canonical_control_reject_invalid_transition
BEFORE UPDATE ON profile_canonical_control
WHEN NOT (
  (
    NEW.state = OLD.state
    AND NEW.import_digest IS OLD.import_digest
    AND NEW.import_plan_version IS OLD.import_plan_version
    AND NEW.imported_at_ms IS OLD.imported_at_ms
  )
  OR (
    OLD.state = 'firestore'
    AND NEW.state = 'importing'
    AND NEW.import_digest IS NULL
    AND NEW.import_plan_version IS NULL
    AND NEW.imported_at_ms IS NULL
  )
  OR (
    OLD.state = 'importing'
    AND NEW.state = 'importing'
    AND OLD.import_digest IS NULL
    AND OLD.import_plan_version IS NULL
    AND OLD.imported_at_ms IS NULL
    AND NEW.import_digest IS NOT NULL
    AND NEW.import_plan_version IS NOT NULL
    AND NEW.imported_at_ms IS NULL
  )
  OR (
    OLD.state = 'importing'
    AND NEW.state = 'frozen'
    AND OLD.import_digest IS NOT NULL
    AND OLD.import_plan_version IS NOT NULL
    AND OLD.imported_at_ms IS NULL
    AND NEW.import_digest IS OLD.import_digest
    AND NEW.import_plan_version IS OLD.import_plan_version
    AND NEW.imported_at_ms IS NOT NULL
    AND NEW.imported_at_ms >= 0
  )
  OR (
    OLD.state = 'frozen'
    AND NEW.state = 'active'
    AND NEW.import_digest IS OLD.import_digest
    AND NEW.import_plan_version IS OLD.import_plan_version
    AND NEW.imported_at_ms IS OLD.imported_at_ms
  )
  OR (
    OLD.state = 'active'
    AND NEW.state = 'frozen'
    AND NEW.import_digest IS OLD.import_digest
    AND NEW.import_plan_version IS OLD.import_plan_version
    AND NEW.imported_at_ms IS OLD.imported_at_ms
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid canonical profile control transition');
END;

CREATE TRIGGER profile_canonical_control_reject_delete
BEFORE DELETE ON profile_canonical_control
BEGIN
  SELECT RAISE(ABORT, 'canonical profile control is permanent');
END;

CREATE TRIGGER profile_canonical_control_reject_replace
BEFORE INSERT ON profile_canonical_control
WHEN EXISTS (
  SELECT 1 FROM profile_canonical_control
  WHERE singleton = 1
)
BEGIN
  SELECT RAISE(ABORT, 'canonical profile control is permanent');
END;
