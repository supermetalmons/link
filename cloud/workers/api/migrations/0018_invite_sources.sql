CREATE TABLE invite_sources (
  invite_id TEXT PRIMARY KEY NOT NULL CHECK (invite_id != ''),
  source_json TEXT NOT NULL CHECK (json_valid(source_json) AND json_type(source_json) = 'object'),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) WITHOUT ROWID;

CREATE TABLE invite_source_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  backend TEXT NOT NULL CHECK (backend IN ('rtdb', 'd1')),
  state TEXT NOT NULL CHECK (state IN ('active', 'frozen')),
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  freeze_generation INTEGER NOT NULL CHECK (freeze_generation >= 0),
  candidate_version_id TEXT,
  source_digest TEXT,
  import_digest TEXT,
  verified_at_ms INTEGER,
  activated_at_ms INTEGER,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  CHECK ((backend = 'rtdb' AND epoch = 0) OR (backend = 'd1' AND epoch >= 1))
);

INSERT INTO invite_source_control (singleton, backend, state, epoch, freeze_generation)
VALUES (1, 'rtdb', 'active', 0, 0);

CREATE TABLE invite_source_write_admissions (
  admission_id TEXT PRIMARY KEY NOT NULL CHECK (admission_id != ''),
  backend TEXT NOT NULL CHECK (backend IN ('rtdb', 'd1')),
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  freeze_generation INTEGER NOT NULL CHECK (freeze_generation >= 0),
  kind TEXT NOT NULL CHECK (kind != ''),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) WITHOUT ROWID;

CREATE TABLE invite_source_guards (
  singleton INTEGER PRIMARY KEY CONSTRAINT invite_source_control_guard CHECK (singleton = 1)
);

CREATE TABLE invite_source_revision_guards (
  singleton INTEGER PRIMARY KEY CONSTRAINT invite_source_revision_guard CHECK (singleton = 1)
);

CREATE TABLE invite_event_effect_receipts (
  transition_id TEXT PRIMARY KEY NOT NULL CHECK (transition_id != ''),
  event_id TEXT NOT NULL CHECK (event_id != ''),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
) WITHOUT ROWID;
