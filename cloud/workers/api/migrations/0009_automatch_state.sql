CREATE TABLE automatch_runtime_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  backend TEXT NOT NULL CHECK (backend IN ('rtdb', 'd1')),
  state TEXT NOT NULL CHECK (state IN ('active', 'frozen')),
  epoch INTEGER NOT NULL CHECK (epoch BETWEEN 1 AND 9007199254740991),
  freeze_generation INTEGER NOT NULL CHECK (freeze_generation BETWEEN 0 AND 9007199254740991),
  staged_at_ms INTEGER,
  candidate_version_id TEXT,
  imported_at_ms INTEGER,
  source_digest TEXT,
  import_digest TEXT,
  activated_at_ms INTEGER,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json))
);

INSERT INTO automatch_runtime_control (singleton, backend, state, epoch, freeze_generation)
VALUES (1, 'rtdb', 'active', 1, 0);

CREATE TRIGGER automatch_backend_one_way
BEFORE UPDATE OF backend ON automatch_runtime_control
WHEN OLD.backend = 'd1' AND NEW.backend != 'd1'
BEGIN
  SELECT RAISE(ABORT, 'automatch backend cannot return to RTDB');
END;

CREATE TABLE automatch_write_admissions (
  admission_id TEXT PRIMARY KEY NOT NULL CHECK (admission_id != ''),
  epoch INTEGER NOT NULL CHECK (epoch BETWEEN 1 AND 9007199254740991),
  freeze_generation INTEGER NOT NULL CHECK (freeze_generation BETWEEN 0 AND 9007199254740991),
  backend TEXT NOT NULL CHECK (backend IN ('rtdb', 'd1')),
  kind TEXT NOT NULL CHECK (kind != ''),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) WITHOUT ROWID;

CREATE INDEX idx_automatch_admissions_epoch
ON automatch_write_admissions (epoch, created_at_ms, admission_id);

CREATE TABLE automatch_write_guards (
  singleton INTEGER PRIMARY KEY CONSTRAINT automatch_write_guard CHECK (singleton = 1)
);

CREATE TABLE automatch_revision_guards (
  singleton INTEGER PRIMARY KEY CONSTRAINT automatch_revision_guard CHECK (singleton = 1)
);

CREATE TABLE automatch_entries (
  record_key TEXT PRIMARY KEY NOT NULL CHECK (record_key != '' AND instr(record_key, '/') = 0),
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) WITHOUT ROWID;

CREATE INDEX idx_automatch_entries_uid
ON automatch_entries (json_extract(payload_json, '$.uid'), record_key)
WHERE payload_json IS NOT NULL;

CREATE INDEX idx_automatch_entries_profile
ON automatch_entries (json_extract(payload_json, '$.profileId'), record_key)
WHERE payload_json IS NOT NULL;

CREATE TABLE automatch_telegram_sources (
  record_key TEXT PRIMARY KEY NOT NULL CHECK (record_key != '' AND instr(record_key, '/') = 0),
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) WITHOUT ROWID;

CREATE TABLE automatch_telegram_projection_outbox (
  record_key TEXT PRIMARY KEY NOT NULL CHECK (record_key != '' AND instr(record_key, '/') = 0),
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) WITHOUT ROWID;

CREATE INDEX idx_automatch_telegram_projection_due
ON automatch_telegram_projection_outbox (json_extract(payload_json, '$.updatedAtMs'), record_key)
WHERE payload_json IS NOT NULL;

CREATE TABLE game_session_projection_outbox (
  record_key TEXT PRIMARY KEY NOT NULL CHECK (record_key != '' AND instr(record_key, '/') = 0),
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) WITHOUT ROWID;

CREATE INDEX idx_game_session_projection_due
ON game_session_projection_outbox (json_extract(payload_json, '$.lastQueuedAtMs'), record_key)
WHERE payload_json IS NOT NULL;

CREATE TABLE game_session_mutation_receipts (
  record_key TEXT PRIMARY KEY NOT NULL CHECK (record_key != '' AND instr(record_key, '/') = 0),
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991),
  expiration_json TEXT CHECK (expiration_json IS NULL OR json_valid(expiration_json)),
  expiration_revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(expiration_revision) = 'integer' AND expiration_revision BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK (revision > 0 OR expiration_revision > 0)
) WITHOUT ROWID;

CREATE INDEX idx_game_session_receipt_completed
ON game_session_mutation_receipts (json_extract(payload_json, '$.completedAtMs'), record_key)
WHERE payload_json IS NOT NULL;

CREATE INDEX idx_game_session_receipt_expiration
ON game_session_mutation_receipts (json_extract(expiration_json, '$.completedAtMs'), record_key)
WHERE expiration_json IS NOT NULL;
