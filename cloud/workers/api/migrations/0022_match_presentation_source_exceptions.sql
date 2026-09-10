CREATE TABLE match_presentation_source_exceptions (
  migration_id TEXT NOT NULL CHECK (migration_id != ''),
  invite_id TEXT NOT NULL CHECK (invite_id != '' AND instr(invite_id, '/') = 0),
  match_id TEXT NOT NULL CHECK (match_id != '' AND instr(match_id, '/') = 0),
  actor_uid TEXT NOT NULL CHECK (length(actor_uid) BETWEEN 1 AND 128 AND instr(actor_uid, '/') = 0),
  disposition TEXT NOT NULL CHECK (disposition IN ('alias', 'archive')),
  seed_digest TEXT NOT NULL CHECK (length(seed_digest) = 64 AND seed_digest NOT GLOB '*[^a-f0-9]*'),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64 AND source_digest NOT GLOB '*[^a-f0-9]*'),
  source_json TEXT NOT NULL CHECK (json_valid(source_json) AND json_type(source_json) = 'object'),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
  canonical_actor_uid TEXT,
  canonical_seed_digest TEXT CHECK (canonical_seed_digest IS NULL OR (length(canonical_seed_digest) = 64 AND canonical_seed_digest NOT GLOB '*[^a-f0-9]*')),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^a-f0-9]*'),
  imported_at_ms INTEGER NOT NULL CHECK (typeof(imported_at_ms) = 'integer' AND imported_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (migration_id, actor_uid, match_id),
  UNIQUE (actor_uid, match_id),
  CHECK (
    (disposition = 'alias' AND canonical_actor_uid IS NOT NULL
      AND length(canonical_actor_uid) BETWEEN 1 AND 128
      AND instr(canonical_actor_uid, '/') = 0
      AND canonical_actor_uid != actor_uid
      AND canonical_seed_digest IS NOT NULL)
    OR (disposition = 'archive' AND canonical_actor_uid IS NULL AND canonical_seed_digest IS NULL)
  )
) WITHOUT ROWID;

CREATE TRIGGER match_presentation_source_exceptions_insert_guard
BEFORE INSERT ON match_presentation_source_exceptions
BEGIN
  SELECT RAISE(ABORT, 'match-presentation-exception-import-unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM match_presentation_control
    WHERE singleton = 1 AND phase = 'capture'
      AND migration_id = NEW.migration_id
      AND source_digest = NEW.manifest_digest
  );
  SELECT RAISE(ABORT, 'match-presentation-exception-live-actor')
  WHERE EXISTS (
    SELECT 1 FROM match_presentation_registrations
    WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id
  );
  SELECT RAISE(ABORT, 'match-presentation-exception-conflict')
  WHERE EXISTS (
    SELECT 1 FROM match_presentation_source_exceptions
    WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id
      AND (migration_id IS NOT NEW.migration_id OR invite_id IS NOT NEW.invite_id
        OR disposition IS NOT NEW.disposition OR seed_digest IS NOT NEW.seed_digest
        OR source_digest IS NOT NEW.source_digest OR source_json IS NOT NEW.source_json
        OR evidence_json IS NOT NEW.evidence_json
        OR canonical_actor_uid IS NOT NEW.canonical_actor_uid
        OR canonical_seed_digest IS NOT NEW.canonical_seed_digest
        OR manifest_digest IS NOT NEW.manifest_digest)
  );
  SELECT RAISE(IGNORE)
  WHERE EXISTS (
    SELECT 1 FROM match_presentation_source_exceptions
    WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id
  );
END;

CREATE TRIGGER match_presentation_source_exceptions_update_guard
BEFORE UPDATE ON match_presentation_source_exceptions
BEGIN
  SELECT RAISE(ABORT, 'match-presentation-exception-immutable');
END;

CREATE TRIGGER match_presentation_source_exceptions_delete_guard
BEFORE DELETE ON match_presentation_source_exceptions
BEGIN
  SELECT RAISE(ABORT, 'match-presentation-exception-immutable');
END;

CREATE TRIGGER match_presentation_registration_exception_guard
BEFORE INSERT ON match_presentation_registrations
WHEN EXISTS (
  SELECT 1 FROM match_presentation_source_exceptions
  WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id
)
BEGIN
  SELECT RAISE(ABORT, 'match-presentation-exception-live-actor');
END;
