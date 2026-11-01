CREATE TABLE profile_link_catchup_jobs_recovery3 (
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
) WITHOUT ROWID;

CREATE INDEX idx_profile_link_catchup_jobs_recovery3_due
ON profile_link_catchup_jobs_recovery3 (last_queued_at_ms, login_uid);


CREATE TABLE profile_link_catchup_quarantine_recovery3 (
  login_uid TEXT PRIMARY KEY,
  revision_token TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('invalid-login-uid', 'invalid-record')),
  quarantined_at_ms INTEGER NOT NULL CHECK (
    typeof(quarantined_at_ms) = 'integer'
    AND quarantined_at_ms BETWEEN 0 AND 9007199254740991
  ),
  FOREIGN KEY (login_uid) REFERENCES profile_link_catchup_jobs_recovery3(login_uid)
    ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE profile_auth_recovery_jobs_recovery3 (
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

CREATE INDEX idx_profile_auth_recovery_jobs_recovery3_sweep
ON profile_auth_recovery_jobs_recovery3 (
  last_enqueued_at_ms,
  updated_at_ms,
  profile_id
);

CREATE TABLE profile_auth_recovery_quarantine_recovery3 (
  profile_id TEXT PRIMARY KEY,
  revision_token TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('invalid-record', 'invalid-profile-id')),
  quarantined_at_ms INTEGER NOT NULL CHECK (
    typeof(quarantined_at_ms) = 'integer'
    AND quarantined_at_ms BETWEEN 0 AND 9007199254740991
  ),
  FOREIGN KEY (profile_id) REFERENCES profile_auth_recovery_jobs_recovery3(profile_id)
    ON DELETE CASCADE
) WITHOUT ROWID;

