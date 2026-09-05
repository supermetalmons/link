CREATE TABLE profile_link_catchup_jobs (
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

CREATE INDEX idx_profile_link_catchup_jobs_due
ON profile_link_catchup_jobs (last_queued_at_ms, login_uid);

CREATE TABLE profile_link_catchup_import (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  import_attempt_id TEXT,
  import_started_at_ms INTEGER,
  source_digest TEXT,
  import_digest TEXT,
  owners_digest TEXT,
  job_count INTEGER,
  first_exported_at_ms INTEGER,
  exported_at_ms INTEGER,
  verified_at_ms INTEGER,
  source_version_id TEXT,
  source_deployed_at_ms INTEGER,
  evidence_json TEXT,
  activated_at_ms INTEGER,
  activated_version_id TEXT
);

INSERT INTO profile_link_catchup_import (singleton) VALUES (1);

CREATE TABLE profile_link_catchup_import_guards (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
);
