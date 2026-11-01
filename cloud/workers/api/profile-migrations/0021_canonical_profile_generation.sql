CREATE TABLE invite_wager_states_canonical (
  invite_id TEXT NOT NULL CHECK (invite_id != '' AND instr(invite_id, '/') = 0),
  match_id TEXT NOT NULL CHECK (match_id != '' AND instr(match_id, '/') = 0),
  wager_json TEXT CHECK (wager_json IS NULL OR (
    json_valid(wager_json) AND json_type(wager_json) IS 'object'
    AND json_extract(wager_json, '$.schemaVersion') IS 1
    AND json_type(wager_json, '$.state') IS 'text'
    AND json_extract(wager_json, '$.state') IN ('proposed', 'agreed', 'settling', 'settled', 'blocked')
    AND json_type(wager_json, '$.proposals') IS 'object'
    AND json_type(wager_json, '$.proposedBy') IS 'object'
    AND json_type(wager_json, '$.proposalRemovalOperations') IS 'object'
    AND (json_type(wager_json, '$.agreed') IS 'object' OR json_type(wager_json, '$.agreed') IS 'null')
    AND (json_type(wager_json, '$.agreementOperation') IS 'object' OR json_type(wager_json, '$.agreementOperation') IS 'null')
    AND (json_type(wager_json, '$.settlement') IS 'object' OR json_type(wager_json, '$.settlement') IS 'null')
    AND (json_type(wager_json, '$.resolved') IS 'object' OR json_type(wager_json, '$.resolved') IS 'null')
    AND (json_type(wager_json, '$.blocked') IS 'object' OR json_type(wager_json, '$.blocked') IS 'null')
    AND json_remove(wager_json, '$.schemaVersion', '$.state', '$.proposals', '$.proposedBy', '$.agreed', '$.agreementOperation', '$.proposalRemovalOperations', '$.settlement', '$.resolved', '$.blocked') = '{}'
    AND ((json_extract(wager_json, '$.state') = 'blocked' AND json_type(wager_json, '$.blocked') IS 'object')
      OR (json_extract(wager_json, '$.state') != 'blocked' AND json_type(wager_json, '$.blocked') IS 'null'))
  )),
  resolution_marker INTEGER CHECK (resolution_marker IS NULL OR resolution_marker IN (0, 1)),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (invite_id, match_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE rating_completions_canonical (
  invite_id TEXT NOT NULL CHECK (invite_id != ''),
  match_id TEXT NOT NULL CHECK (match_id != ''),
  imported_at_ms INTEGER NOT NULL CHECK (imported_at_ms >= 0),
  PRIMARY KEY (invite_id, match_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE profile_auth_methods_canonical (
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
  FOREIGN KEY (profile_id) REFERENCES profile_records_canonical(profile_id)
    ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE profile_auth_operations_canonical (
  operation_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  cancelled_at_ms INTEGER,
  cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR cancellation_reason = 'canonical-data-cutover'),
  kind TEXT NOT NULL CHECK (kind IN ('unlink', 'verify')),
  method TEXT NOT NULL CHECK (method IN ('eth', 'sol', 'apple', 'x')),
  login_uid TEXT NOT NULL CHECK (login_uid != ''),
  status TEXT NOT NULL CHECK (status IN ('started', 'failed', 'success', 'cancelled')),
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
  CHECK (operation_id != ''),
  CHECK ((kind = 'unlink' AND meta_json IS NULL) OR (kind = 'verify' AND meta_json IS NOT NULL AND json_type(meta_json, '$.methodValue') IS 'text' AND json_type(meta_json, '$.methodValueHash') IS 'text' AND (json_type(meta_json, '$.intentId') IS 'text' OR json_type(meta_json, '$.intentId') IS 'null'))),
  CHECK ((status = 'started' AND result_json IS NULL AND error_code IS NULL AND error_message IS NULL AND cancelled_at_ms IS NULL AND cancellation_reason IS NULL)
    OR (status = 'failed' AND result_json IS NULL AND error_code IS NOT NULL AND error_message IS NOT NULL AND cancelled_at_ms IS NULL AND cancellation_reason IS NULL)
    OR (status = 'success' AND result_json IS NOT NULL AND error_code IS NULL AND error_message IS NULL AND cancelled_at_ms IS NULL AND cancellation_reason IS NULL AND json_extract(result_json, '$.schemaVersion') IS 1 AND json_extract(result_json, '$.kind') IS kind)
    OR (status = 'cancelled' AND result_json IS NULL AND error_code = 'aborted' AND error_message = 'operation-cancelled' AND cancelled_at_ms BETWEEN started_at_ms AND updated_at_ms AND cancellation_reason = 'canonical-data-cutover'))
) STRICT, WITHOUT ROWID;

CREATE TABLE profile_auth_recovery_jobs_canonical (
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
  FOREIGN KEY (profile_id) REFERENCES profile_records_canonical(profile_id)
    ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE profile_auth_recovery_quarantine_canonical (
  profile_id TEXT PRIMARY KEY,
  revision_token TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('invalid-record', 'invalid-profile-id')),
  quarantined_at_ms INTEGER NOT NULL CHECK (
    typeof(quarantined_at_ms) = 'integer'
    AND quarantined_at_ms BETWEEN 0 AND 9007199254740991
  ),
  FOREIGN KEY (profile_id) REFERENCES profile_auth_recovery_jobs_canonical(profile_id)
    ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE profile_february_opponents_canonical (
  profile_id TEXT NOT NULL,
  opponent_profile_id TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
  PRIMARY KEY (profile_id, opponent_profile_id),
  CHECK (profile_id != opponent_profile_id),
  FOREIGN KEY (profile_id) REFERENCES profile_records_canonical(profile_id)
    ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE profile_link_catchup_jobs_canonical (
  login_uid TEXT PRIMARY KEY CHECK (login_uid != ''),
  request_id TEXT NOT NULL CHECK (request_id != ''),
  profile_id TEXT NOT NULL CHECK (profile_id != ''),
  cleanup_profile_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(cleanup_profile_ids_json)
    AND json_type(cleanup_profile_ids_json) = 'array'
  ),
  match_cursor TEXT CHECK (match_cursor IS NULL OR match_cursor != ''),
  source_updated_at_ms INTEGER NOT NULL CHECK (source_updated_at_ms >= 0),
  last_queued_at_ms INTEGER NOT NULL CHECK (last_queued_at_ms >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE profile_link_catchup_quarantine_canonical (
  login_uid TEXT PRIMARY KEY,
  revision_token TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('invalid-login-uid', 'invalid-record')),
  quarantined_at_ms INTEGER NOT NULL CHECK (
    typeof(quarantined_at_ms) = 'integer'
    AND quarantined_at_ms BETWEEN 0 AND 9007199254740991
  ),
  FOREIGN KEY (login_uid) REFERENCES profile_link_catchup_jobs_canonical(login_uid)
    ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE profile_login_owners_canonical (
  login_uid TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (login_uid != ''),
  FOREIGN KEY (profile_id) REFERENCES profile_records_canonical(profile_id)
    ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE profile_merge_targets_canonical (
  source_profile_id TEXT PRIMARY KEY,
  target_profile_id TEXT NOT NULL,
  merged_at_ms INTEGER NOT NULL CHECK (merged_at_ms >= 0),
  op_id TEXT,
  CHECK (
    source_profile_id != ''
    AND target_profile_id != ''
    AND source_profile_id != target_profile_id
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE profile_records_canonical (
  profile_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'retiring')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json) AND json_type(payload_json) = 'object'
  ),
  gameplay_emoji INTEGER NOT NULL CHECK (gameplay_emoji BETWEEN 0 AND 155 OR gameplay_emoji BETWEEN 1000 AND 1466),
  username_key TEXT UNIQUE,
  merged_into_profile_id TEXT,
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
  CHECK (json_remove(payload_json, '$.id', '$.nonce', '$.rating', '$.totalManaPoints', '$.win', '$.emoji', '$.aura', '$.cardBackgroundId', '$.cardSubtitleId', '$.profileCounter', '$.profileMons', '$.cardStickers', '$.username', '$.eth', '$.sol', '$.feb2026UniqueOpponentsCount', '$.completedProblemIds', '$.isTutorialCompleted', '$.mining') = '{}'),
  CHECK (json_type(payload_json, '$.nonce') IS 'integer' AND json_extract(payload_json, '$.nonce') BETWEEN -1 AND 9007199254740991),
  CHECK ((json_type(payload_json, '$.rating') IS 'real' OR json_type(payload_json, '$.rating') IS 'integer') AND json_extract(payload_json, '$.rating') >= 0),
  CHECK (json_type(payload_json, '$.totalManaPoints') IS 'integer' AND json_extract(payload_json, '$.totalManaPoints') BETWEEN 0 AND 9007199254740991),
  CHECK (json_type(payload_json, '$.win') IS 'true' OR json_type(payload_json, '$.win') IS 'false'),
  CHECK (json_type(payload_json, '$.isTutorialCompleted') IS 'true' OR json_type(payload_json, '$.isTutorialCompleted') IS 'false'),
  CHECK (json_type(payload_json, '$.cardBackgroundId') IS 'integer'),
  CHECK (json_type(payload_json, '$.cardSubtitleId') IS 'integer'),
  CHECK (json_type(payload_json, '$.feb2026UniqueOpponentsCount') IS 'integer'),
  CHECK (json_type(payload_json, '$.username') IS 'text' OR json_type(payload_json, '$.username') IS 'null'),
  CHECK (json_type(payload_json, '$.eth') IS 'text' OR json_type(payload_json, '$.eth') IS 'null'),
  CHECK (json_type(payload_json, '$.sol') IS 'text' OR json_type(payload_json, '$.sol') IS 'null'),
  CHECK (json_type(payload_json, '$.completedProblemIds') IS 'array'),
  CHECK (json_type(payload_json, '$.mining') IS 'object'),
  CHECK (json_type(payload_json, '$.profileCounter') IS 'text' AND json_extract(payload_json, '$.profileCounter') IN ('gp','mp')),
  CHECK (json_type(payload_json, '$.id') IS 'text' AND json_extract(payload_json, '$.id') IS profile_id),
  CHECK (emoji_present = 0 OR json_extract(payload_json, '$.emoji') IS gameplay_emoji),
  CHECK (json_type(payload_json, '$.emoji') IS 'integer'),
  CHECK (json_type(payload_json, '$.aura') IS 'text' AND json_extract(payload_json, '$.aura') IN ('none','rainbow')),
  CHECK (json_type(payload_json, '$.cardStickers') IS 'object'),
  CHECK (json_type(payload_json, '$.profileMons') IS 'object' OR json_type(payload_json, '$.profileMons') IS 'null'),
  CHECK (profile_id != '' AND instr(profile_id, '/') = 0),
  CHECK (username_key IS NULL OR username_key != ''),
  CHECK (
    (state = 'active' AND merged_into_profile_id IS NULL)
    OR (
      state = 'retiring'
      AND merged_into_profile_id IS NOT NULL
      AND merged_into_profile_id != ''
      AND merged_into_profile_id != profile_id
      AND merged_at_ms IS NOT NULL
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
) STRICT, WITHOUT ROWID;

CREATE TABLE rating_projection_recovery_quarantine_canonical (
  operation_id TEXT NOT NULL,
  projection_kind TEXT NOT NULL CHECK (
    projection_kind IN ('event-progress', 'profile-game', 'telegram')
  ),
  revision_token TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('invalid-operation-id', 'invalid-record')),
  quarantined_at_ms INTEGER NOT NULL CHECK (
    typeof(quarantined_at_ms) = 'integer'
    AND quarantined_at_ms BETWEEN 0 AND 9007199254740991
  ),
  PRIMARY KEY (operation_id, projection_kind),
  FOREIGN KEY (operation_id) REFERENCES rating_updates_canonical(operation_id)
    ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE rating_updates_canonical (
  operation_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  blocked_at_ms INTEGER,
  block_reason TEXT CHECK (block_reason IS NULL OR block_reason = 'canonical-data-cutover'),
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json) AND json_type(payload_json) = 'object'
  ),
  status TEXT NOT NULL CHECK (status IN ('processing', 'done', 'blocked')),
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
    OR telegram_projection_state IN ('pending', 'done', 'dead', 'cancelled')
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
    OR profile_game_projection_state IN ('pending', 'done', 'dead', 'cancelled')
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
    OR event_progress_state IN ('pending', 'done', 'dead', 'cancelled')
  ),
  event_progress_updated_at_ms INTEGER CHECK (
    event_progress_updated_at_ms IS NULL OR event_progress_updated_at_ms >= 0
  ),
  event_progress_version INTEGER CHECK (
    event_progress_version IS NULL OR event_progress_version >= 0
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK (
    (status = 'processing' AND completed_at_ms IS NULL AND blocked_at_ms IS NULL AND block_reason IS NULL)
    OR (status = 'done' AND completed_at_ms IS NOT NULL AND blocked_at_ms IS NULL AND block_reason IS NULL)
    OR (status = 'blocked' AND completed_at_ms IS NULL AND blocked_at_ms BETWEEN started_at_ms AND updated_at_ms AND block_reason = 'canonical-data-cutover')
  ),
  CHECK ((telegram_projection_state IS NULL AND telegram_projection_updated_at_ms IS NULL AND telegram_projection_version IS NULL) OR (telegram_projection_state IS NOT NULL AND telegram_projection_updated_at_ms IS NOT NULL AND telegram_projection_version IS 1)),
  CHECK ((profile_game_projection_state IS NULL AND profile_game_projection_updated_at_ms IS NULL AND profile_game_projection_version IS NULL) OR (profile_game_projection_state IS NOT NULL AND profile_game_projection_updated_at_ms IS NOT NULL AND profile_game_projection_version IS 1)),
  CHECK ((event_progress_state IS NULL AND event_progress_updated_at_ms IS NULL AND event_progress_version IS NULL) OR (event_progress_state IS NOT NULL AND event_progress_updated_at_ms IS NOT NULL AND event_progress_version IS 1)),
  CHECK (operation_id = invite_id || '__' || match_id),
  CHECK (status != 'processing' OR (telegram_projection_state IS NULL AND profile_game_projection_state IS NULL AND event_progress_state IS NULL)),
  CHECK (status != 'blocked' OR (telegram_projection_state IS NOT 'pending' AND profile_game_projection_state IS NOT 'pending' AND event_progress_state IS NOT 'pending')),
  CHECK (player_id != opponent_id),
  CHECK (json_extract(payload_json, '$.schemaVersion') IS 1),
  CHECK (json_type(payload_json, '$.eventOwned') IS 'true' OR json_type(payload_json, '$.eventOwned') IS 'false'),
  CHECK (json_type(payload_json, '$.isEventMatch') IS 'true' OR json_type(payload_json, '$.isEventMatch') IS 'false')
) STRICT, WITHOUT ROWID;

CREATE TABLE wager_frozen_balances_canonical (
  player_uid TEXT PRIMARY KEY CHECK (player_uid != '' AND instr(player_uid, '/') = 0),
  frozen_json TEXT NOT NULL CHECK (
    json_valid(frozen_json)
    AND json_type(frozen_json) = 'object'
    AND json_remove(frozen_json, '$.dust', '$.slime', '$.gum', '$.metal', '$.ice') = '{}'
    AND json_type(frozen_json, '$.dust') IS 'integer'
    AND json_type(frozen_json, '$.slime') IS 'integer'
    AND json_type(frozen_json, '$.gum') IS 'integer'
    AND json_type(frozen_json, '$.metal') IS 'integer'
    AND json_type(frozen_json, '$.ice') IS 'integer'
    AND json_extract(frozen_json, '$.dust') BETWEEN 0 AND 9007199254740991
    AND json_extract(frozen_json, '$.slime') BETWEEN 0 AND 9007199254740991
    AND json_extract(frozen_json, '$.gum') BETWEEN 0 AND 9007199254740991
    AND json_extract(frozen_json, '$.metal') BETWEEN 0 AND 9007199254740991
    AND json_extract(frozen_json, '$.ice') BETWEEN 0 AND 9007199254740991
  ),
  revision INTEGER NOT NULL CONSTRAINT wager_frozen_revision_guard CHECK (
    typeof(revision) IS 'integer' AND revision BETWEEN 1 AND 9007199254740991
  ),
  updated_at_ms INTEGER NOT NULL CHECK (
    typeof(updated_at_ms) IS 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE wager_frozen_operations_canonical (
  player_uid TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (operation_id != '' AND instr(operation_id, '/') = 0),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) IS 'object'
    AND json_extract(record_json, '$.schemaVersion') IS 1
    AND ((json_extract(record_json, '$.status') IS 'consumed'
      AND json_remove(record_json, '$.schemaVersion', '$.status') = '{}')
      OR (json_extract(record_json, '$.status') IS 'active'
        AND json_type(record_json, '$.operation') IS 'object'
        AND json_type(record_json, '$.operation.kind') IS 'text'
        AND json_extract(record_json, '$.operation.kind') IN ('send-reserve', 'accept-reserve', 'accept-proposer-adjustment', 'send-proposer-adjustment', 'send-self-adjustment')
        AND json_type(record_json, '$.operation.appliedAtMs') IS 'integer'
        AND json_extract(record_json, '$.operation.appliedAtMs') BETWEEN 0 AND 9007199254740991
        AND json_type(record_json, '$.operation.deltas') IS 'object'
        AND json_type(record_json, '$.operation.fingerprint') IS 'text'
        AND length(json_extract(record_json, '$.operation.fingerprint')) > 0
        AND json_remove(record_json, '$.schemaVersion', '$.status', '$.operation') = '{}'))
  ),
  PRIMARY KEY (player_uid, operation_id),
  FOREIGN KEY (player_uid) REFERENCES wager_frozen_balances_canonical(player_uid)
) STRICT, WITHOUT ROWID;

CREATE TABLE wager_settlements_canonical (
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
, outcome TEXT NOT NULL DEFAULT 'applied' CHECK (
  outcome IN ('applied', 'insufficient-materials')
)) STRICT, WITHOUT ROWID;

CREATE INDEX idx_profile_auth_operations_sweep_canonical
ON profile_auth_operations_canonical (status, updated_at_ms, operation_id);

CREATE INDEX idx_profile_auth_recovery_jobs_sweep_canonical
ON profile_auth_recovery_jobs_canonical (
  last_enqueued_at_ms,
  updated_at_ms,
  profile_id
);

CREATE INDEX idx_profile_february_opponents_opponent_canonical
ON profile_february_opponents_canonical (opponent_profile_id, profile_id);

CREATE INDEX idx_profile_link_catchup_jobs_due_canonical
ON profile_link_catchup_jobs_canonical (last_queued_at_ms, login_uid);

CREATE INDEX idx_profile_login_owners_profile_canonical
ON profile_login_owners_canonical (profile_id, login_uid);

CREATE INDEX idx_profile_merge_targets_target_canonical
ON profile_merge_targets_canonical (target_profile_id, source_profile_id);

CREATE INDEX idx_profile_records_dust_canonical
ON profile_records_canonical (
  state,
  dust_sort_present,
  dust_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profile_records_gum_canonical
ON profile_records_canonical (
  state,
  gum_sort_present,
  gum_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profile_records_ice_canonical
ON profile_records_canonical (
  state,
  ice_sort_present,
  ice_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profile_records_mana_points_canonical
ON profile_records_canonical (
  state,
  mana_points_sort_present,
  mana_points_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profile_records_metal_canonical
ON profile_records_canonical (
  state,
  metal_sort_present,
  metal_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profile_records_nonce_canonical
ON profile_records_canonical (
  state,
  nonce_sort_present,
  nonce_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profile_records_rating_canonical
ON profile_records_canonical (
  state,
  rating_sort_present,
  rating_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_profile_records_slime_canonical
ON profile_records_canonical (
  state,
  slime_sort_present,
  slime_sort DESC,
  profile_id DESC
);

CREATE INDEX idx_rating_updates_event_progress_canonical
ON rating_updates_canonical (
  event_progress_state,
  event_progress_updated_at_ms,
  operation_id
);

CREATE INDEX idx_rating_updates_lease_canonical
ON rating_updates_canonical (status, lease_expires_at_ms, operation_id);

CREATE INDEX idx_rating_updates_profile_game_projection_canonical
ON rating_updates_canonical (
  profile_game_projection_state,
  profile_game_projection_updated_at_ms,
  operation_id
);

CREATE INDEX idx_rating_updates_telegram_projection_canonical
ON rating_updates_canonical (
  telegram_projection_state,
  telegram_projection_updated_at_ms,
  operation_id
);

CREATE INDEX idx_wager_settlements_profiles_canonical
ON wager_settlements_canonical (
  winner_profile_id,
  loser_profile_id,
  applied_at_ms,
  operation_id
);

CREATE TRIGGER legacy_rating_completions_immutable_delete_canonical
BEFORE DELETE ON rating_completions_canonical
BEGIN
  SELECT RAISE(ABORT, 'rating-completion-evidence-immutable');
END;

CREATE TRIGGER legacy_rating_completions_immutable_update_canonical
BEFORE UPDATE ON rating_completions_canonical
BEGIN
  SELECT RAISE(ABORT, 'rating-completion-evidence-immutable');
END;

CREATE TRIGGER profile_login_owners_require_active_profile_insert_canonical
BEFORE INSERT ON profile_login_owners_canonical
WHEN NOT EXISTS (
  SELECT 1 FROM profile_records_canonical
  WHERE profile_id = NEW.profile_id AND state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'profile login owner target is not active');
END;

CREATE TRIGGER profile_login_owners_require_active_profile_update_canonical
BEFORE UPDATE ON profile_login_owners_canonical
WHEN NOT EXISTS (
  SELECT 1 FROM profile_records_canonical
  WHERE profile_id = NEW.profile_id AND state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'profile login owner target is not active');
END;

CREATE TRIGGER profile_merge_targets_reject_cycle_canonical
BEFORE INSERT ON profile_merge_targets_canonical
WHEN EXISTS (
  WITH RECURSIVE targets(profile_id) AS (
    VALUES (NEW.target_profile_id)
    UNION
    SELECT target.target_profile_id
    FROM profile_merge_targets_canonical AS target
    JOIN targets ON target.source_profile_id = targets.profile_id
  )
  SELECT 1 FROM targets WHERE profile_id = NEW.source_profile_id
)
BEGIN
  SELECT RAISE(ABORT, 'profile merge cycle');
END;

CREATE TRIGGER profile_merge_targets_reject_delete_canonical
BEFORE DELETE ON profile_merge_targets_canonical
BEGIN
  SELECT RAISE(ABORT, 'profile merge mappings are permanent');
END;

CREATE TRIGGER profile_merge_targets_reject_depth_canonical
BEFORE INSERT ON profile_merge_targets_canonical
WHEN (
  WITH RECURSIVE
  ancestors(profile_id, depth) AS (
    VALUES (NEW.source_profile_id, 0)
    UNION ALL
    SELECT target.source_profile_id, ancestors.depth + 1
    FROM profile_merge_targets_canonical AS target
    JOIN ancestors ON target.target_profile_id = ancestors.profile_id
    WHERE ancestors.depth < 32
  ),
  descendants(profile_id, depth) AS (
    VALUES (NEW.target_profile_id, 0)
    UNION ALL
    SELECT target.target_profile_id, descendants.depth + 1
    FROM profile_merge_targets_canonical AS target
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

CREATE TRIGGER profile_merge_targets_reject_replace_canonical
BEFORE INSERT ON profile_merge_targets_canonical
WHEN EXISTS (
  SELECT 1 FROM profile_merge_targets_canonical
  WHERE source_profile_id = NEW.source_profile_id
    AND (
      target_profile_id IS NOT NEW.target_profile_id
      OR merged_at_ms IS NOT NEW.merged_at_ms
      OR op_id IS NOT NEW.op_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'profile merge mappings are immutable');
END;

CREATE TRIGGER profile_merge_targets_reject_update_canonical
BEFORE UPDATE ON profile_merge_targets_canonical
BEGIN
  SELECT RAISE(ABORT, 'profile merge mappings are immutable');
END;

CREATE TRIGGER profile_merge_targets_require_retired_source_canonical
BEFORE INSERT ON profile_merge_targets_canonical
WHEN EXISTS (
  SELECT 1
  FROM profile_records_canonical
  WHERE profile_id = NEW.source_profile_id
    AND (
      state != 'retiring'
      OR merged_into_profile_id IS NOT NEW.target_profile_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'profile merge source is not retired');
END;

CREATE TRIGGER profile_merge_targets_require_runtime_target_canonical
BEFORE INSERT ON profile_merge_targets_canonical
WHEN NOT EXISTS (
  SELECT 1 FROM application_write_context w
  JOIN application_data_control c ON c.singleton = 1
  WHERE w.singleton = 1 AND w.migration_id = c.migration_id
    AND w.generation = c.generation AND w.data_epoch = c.data_epoch
    AND c.phase IN ('closed', 'verifying')
)
AND NOT EXISTS (
  SELECT 1
  FROM profile_records_canonical
  WHERE profile_id = NEW.target_profile_id AND state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'profile merge target is not active');
END;

CREATE TRIGGER profile_records_reject_active_delete_canonical
BEFORE DELETE ON profile_records_canonical
WHEN OLD.state = 'active'
BEGIN
  SELECT RAISE(ABORT, 'active profiles cannot be deleted');
END;

CREATE TRIGGER profile_records_require_matching_merge_target_insert_canonical
BEFORE INSERT ON profile_records_canonical
WHEN EXISTS (
  SELECT 1
  FROM profile_merge_targets_canonical
  WHERE source_profile_id = NEW.profile_id
    AND (
      NEW.state != 'retiring'
      OR target_profile_id IS NOT NEW.merged_into_profile_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'profile merge source does not match mapping');
END;

CREATE TRIGGER profile_records_require_matching_merge_target_update_canonical
BEFORE UPDATE ON profile_records_canonical
WHEN EXISTS (
  SELECT 1
  FROM profile_merge_targets_canonical
  WHERE source_profile_id = NEW.profile_id
    AND (
      NEW.state != 'retiring'
      OR target_profile_id IS NOT NEW.merged_into_profile_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'profile merge source does not match mapping');
END;

CREATE TRIGGER wager_settlements_reject_delete_canonical
BEFORE DELETE ON wager_settlements_canonical
BEGIN
  SELECT RAISE(ABORT, 'wager settlements are permanent');
END;

CREATE TRIGGER wager_settlements_reject_replace_canonical
BEFORE INSERT ON wager_settlements_canonical
WHEN EXISTS (
  SELECT 1 FROM wager_settlements_canonical
  WHERE operation_id = NEW.operation_id
    AND (
      fingerprint IS NOT NEW.fingerprint
      OR winner_profile_id IS NOT NEW.winner_profile_id
      OR loser_profile_id IS NOT NEW.loser_profile_id
      OR material IS NOT NEW.material
      OR count IS NOT NEW.count
      OR applied_at_ms IS NOT NEW.applied_at_ms
      OR outcome IS NOT NEW.outcome
      OR revision IS NOT NEW.revision
    )
)
BEGIN
  SELECT RAISE(ABORT, 'wager settlements are immutable');
END;

CREATE TRIGGER wager_settlements_reject_update_canonical
BEFORE UPDATE ON wager_settlements_canonical
BEGIN
  SELECT RAISE(ABORT, 'wager settlements are immutable');
END;

CREATE TRIGGER wager_state_import_insert_canonical
BEFORE INSERT ON invite_wager_states_canonical
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

CREATE TRIGGER wager_state_import_update_canonical
BEFORE UPDATE ON invite_wager_states_canonical
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

CREATE TRIGGER wager_state_no_delete_canonical
BEFORE DELETE ON invite_wager_states_canonical
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

CREATE TRIGGER profile_auth_operations_identity_immutable_canonical
BEFORE UPDATE ON profile_auth_operations_canonical
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.kind IS NOT OLD.kind
  OR NEW.method IS NOT OLD.method OR NEW.login_uid IS NOT OLD.login_uid
  OR NEW.meta_json IS NOT OLD.meta_json OR NEW.started_at_ms IS NOT OLD.started_at_ms
BEGIN
  SELECT RAISE(ABORT, 'auth operation identity is immutable');
END;

CREATE TRIGGER profile_auth_operations_terminal_immutable_canonical
BEFORE UPDATE ON profile_auth_operations_canonical
WHEN OLD.status IN ('success', 'cancelled') AND (
  NEW.status IS NOT OLD.status OR NEW.result_json IS NOT OLD.result_json
  OR NEW.error_code IS NOT OLD.error_code OR NEW.error_message IS NOT OLD.error_message
  OR NEW.cancelled_at_ms IS NOT OLD.cancelled_at_ms OR NEW.cancellation_reason IS NOT OLD.cancellation_reason
)
BEGIN
  SELECT RAISE(ABORT, 'auth operation outcome is immutable');
END;

CREATE TRIGGER rating_updates_identity_immutable_canonical
BEFORE UPDATE ON rating_updates_canonical
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.invite_id IS NOT OLD.invite_id
  OR NEW.match_id IS NOT OLD.match_id OR NEW.player_id IS NOT OLD.player_id
  OR NEW.opponent_id IS NOT OLD.opponent_id OR NEW.started_at_ms IS NOT OLD.started_at_ms
BEGIN
  SELECT RAISE(ABORT, 'rating operation identity is immutable');
END;

CREATE TRIGGER rating_updates_terminal_immutable_canonical
BEFORE UPDATE ON rating_updates_canonical
WHEN OLD.status IN ('done', 'blocked') AND (
  NEW.status IS NOT OLD.status OR NEW.completed_at_ms IS NOT OLD.completed_at_ms
  OR NEW.player_profile_id IS NOT OLD.player_profile_id OR NEW.opponent_profile_id IS NOT OLD.opponent_profile_id
  OR NEW.blocked_at_ms IS NOT OLD.blocked_at_ms OR NEW.block_reason IS NOT OLD.block_reason
  OR json_remove(NEW.payload_json, '$.profileGameProjectionReason', '$.telegramProjectionReason', '$.eventProgressReason')
    IS NOT json_remove(OLD.payload_json, '$.profileGameProjectionReason', '$.telegramProjectionReason', '$.eventProgressReason')
)
BEGIN
  SELECT RAISE(ABORT, 'rating operation outcome is immutable');
END;
