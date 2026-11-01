SELECT CASE WHEN
  EXISTS (SELECT 1 FROM application_data_control WHERE singleton = 1 AND generation = 1 AND data_epoch = 0 AND phase = 'active' AND migration_id IS NULL)
  AND NOT EXISTS (SELECT 1 FROM match_state_records_canonical)
  AND NOT EXISTS (SELECT 1 FROM match_presentation_source_exceptions_canonical)
THEN 1 ELSE json('canonical-emoji-range-requires-empty-source-generation') END AS verified;

DROP TABLE match_state_records_canonical;

CREATE TABLE match_state_records_canonical (
  actor_uid TEXT NOT NULL CHECK (actor_uid IS NULL OR (actor_uid != '' AND instr(actor_uid, '/') = 0)),
  match_id TEXT NOT NULL CHECK (match_id IS NULL OR (match_id != '' AND instr(match_id, '/') = 0)),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND
    json_type(record_json) IS 'object' AND
    json_type(record_json, '$.schemaVersion') IS 'integer' AND
    json_extract(record_json, '$.schemaVersion') IS 1 AND
    json_type(record_json, '$.version') IS 'integer' AND
    json_extract(record_json, '$.version') IN (1, 2) AND
    json_type(record_json, '$.color') IS 'text' AND
    json_extract(record_json, '$.color') IN ('white', 'black') AND
    json_type(record_json, '$.emojiId') IS 'integer' AND
    (json_extract(record_json, '$.emojiId') BETWEEN 0 AND 155 OR json_extract(record_json, '$.emojiId') BETWEEN 1000 AND 1466) AND
    json_type(record_json, '$.aura') IS 'text' AND
    json_extract(record_json, '$.aura') IN ('none', 'rainbow') AND
    json_type(record_json, '$.gameVariant') IS 'text' AND
    json_extract(record_json, '$.gameVariant') != '' AND
    json_type(record_json, '$.fen') IS 'text' AND
    json_extract(record_json, '$.fen') != '' AND
    json_type(record_json, '$.status') IS 'text' AND
    json_extract(record_json, '$.status') IN ('active', 'surrendered') AND
    json_type(record_json, '$.flatMovesString') IS 'text' AND
    json_type(record_json, '$.timer') IS 'object' AND json_type(record_json, '$.timer.state') IS 'text' AND json_extract(record_json, '$.timer.state') IN ('idle', 'running', 'finished') AND (json_extract(record_json, '$.timer.state') != 'running' OR (json_type(record_json, '$.timer.turnNumber') IS 'integer' AND json_extract(record_json, '$.timer.turnNumber') BETWEEN 0 AND 9007199254740991 AND json_type(record_json, '$.timer.deadlineAtMs') IS 'integer' AND json_extract(record_json, '$.timer.deadlineAtMs') BETWEEN 1 AND 9007199254740991)) AND
    (json_type(record_json, '$.sessionCreation') IS 'null' OR (json_type(record_json, '$.sessionCreation') IS 'text' AND json_extract(record_json, '$.sessionCreation') != '')) AND
    (json_type(record_json, '$.reaction') IS 'null' OR (json_type(record_json, '$.reaction') IS 'object' AND json_type(record_json, '$.reaction.uuid') IS 'text' AND json_type(record_json, '$.reaction.kind') IS 'text' AND json_type(record_json, '$.reaction.variation') IS 'integer'))
  ),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64 AND source_digest NOT GLOB '*[^a-f0-9]*'),
  import_id TEXT NOT NULL CHECK (import_id != ''),
  disposition TEXT NOT NULL CHECK (disposition IN ('missing-invite', 'ambiguous-invite', 'nonparticipant', 'malformed')),
  PRIMARY KEY (actor_uid, match_id)
) STRICT, WITHOUT ROWID;;

CREATE TRIGGER match_state_records_canonical_insert_conflict BEFORE INSERT ON match_state_records_canonical WHEN EXISTS (SELECT 1 FROM match_state_records_canonical WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id AND (record_json IS NOT NEW.record_json OR source_digest IS NOT NEW.source_digest OR import_id IS NOT NEW.import_id OR disposition IS NOT NEW.disposition)) BEGIN SELECT RAISE(ABORT, 'match-state-archive-conflict'); END;;

CREATE TRIGGER match_state_records_canonical_immutable BEFORE UPDATE ON match_state_records_canonical BEGIN SELECT RAISE(ABORT, 'match-state-archive-immutable'); END;;

DROP TABLE match_presentation_source_exceptions_canonical;

CREATE TABLE match_presentation_source_exceptions_canonical (
  migration_id TEXT NOT NULL CHECK (migration_id != ''),
  invite_id TEXT NOT NULL CHECK (invite_id != '' AND instr(invite_id, '/') = 0),
  match_id TEXT NOT NULL CHECK (match_id != '' AND instr(match_id, '/') = 0),
  actor_uid TEXT NOT NULL CHECK (length(actor_uid) BETWEEN 1 AND 128 AND instr(actor_uid, '/') = 0),
  disposition TEXT NOT NULL CHECK (disposition IN ('alias', 'archive')),
  seed_digest TEXT NOT NULL CHECK (length(seed_digest) = 64 AND seed_digest NOT GLOB '*[^a-f0-9]*'),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64 AND source_digest NOT GLOB '*[^a-f0-9]*'),
  source_json TEXT NOT NULL CHECK (
    json_valid(source_json) AND
    json_type(source_json) IS 'object' AND
    json_type(source_json, '$.schemaVersion') IS 'integer' AND
    json_extract(source_json, '$.schemaVersion') IS 1 AND
    json_type(source_json, '$.version') IS 'integer' AND
    json_extract(source_json, '$.version') IN (1, 2) AND
    json_type(source_json, '$.color') IS 'text' AND
    json_extract(source_json, '$.color') IN ('white', 'black') AND
    json_type(source_json, '$.emojiId') IS 'integer' AND
    (json_extract(source_json, '$.emojiId') BETWEEN 0 AND 155 OR json_extract(source_json, '$.emojiId') BETWEEN 1000 AND 1466) AND
    json_type(source_json, '$.aura') IS 'text' AND
    json_extract(source_json, '$.aura') IN ('none', 'rainbow') AND
    json_type(source_json, '$.gameVariant') IS 'text' AND
    json_extract(source_json, '$.gameVariant') != '' AND
    json_type(source_json, '$.fen') IS 'text' AND
    json_extract(source_json, '$.fen') != '' AND
    json_type(source_json, '$.status') IS 'text' AND
    json_extract(source_json, '$.status') IN ('active', 'surrendered') AND
    json_type(source_json, '$.flatMovesString') IS 'text' AND
    json_type(source_json, '$.timer') IS 'object' AND json_type(source_json, '$.timer.state') IS 'text' AND json_extract(source_json, '$.timer.state') IN ('idle', 'running', 'finished') AND (json_extract(source_json, '$.timer.state') != 'running' OR (json_type(source_json, '$.timer.turnNumber') IS 'integer' AND json_extract(source_json, '$.timer.turnNumber') BETWEEN 0 AND 9007199254740991 AND json_type(source_json, '$.timer.deadlineAtMs') IS 'integer' AND json_extract(source_json, '$.timer.deadlineAtMs') BETWEEN 1 AND 9007199254740991)) AND
    (json_type(source_json, '$.sessionCreation') IS 'null' OR (json_type(source_json, '$.sessionCreation') IS 'text' AND json_extract(source_json, '$.sessionCreation') != '')) AND
    (json_type(source_json, '$.reaction') IS 'null' OR (json_type(source_json, '$.reaction') IS 'object' AND json_type(source_json, '$.reaction.uuid') IS 'text' AND json_type(source_json, '$.reaction.kind') IS 'text' AND json_type(source_json, '$.reaction.variation') IS 'integer'))
  ),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) IS 'object' AND json_extract(evidence_json, '$.schemaVersion') IS 1 AND json_extract(evidence_json, '$.disposition') IS disposition AND json_extract(evidence_json, '$.sourceDigest') IS source_digest AND json_type(evidence_json, '$.ownership') IS 'array' AND json_type(evidence_json, '$.profileId') IS 'text' AND json_type(evidence_json, '$.reason') IS 'text' AND json_extract(evidence_json, '$.reason') IN ('linked-login-copy','no-canonical-owner','conflicting-color')),
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
) STRICT, WITHOUT ROWID;;

CREATE TRIGGER match_presentation_source_exceptions_canonical_immutable BEFORE UPDATE ON match_presentation_source_exceptions_canonical BEGIN SELECT RAISE(ABORT, 'match-presentation-source-exception-immutable'); END;;

CREATE TRIGGER match_presentation_source_exceptions_canonical_delete_guard BEFORE DELETE ON match_presentation_source_exceptions_canonical BEGIN SELECT RAISE(ABORT, 'match-presentation-source-exception-immutable'); END;;

CREATE TRIGGER match_presentation_source_exceptions_canonical_insert_guard BEFORE INSERT ON match_presentation_source_exceptions_canonical WHEN EXISTS(SELECT 1 FROM match_presentation_source_exceptions_canonical WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id AND (migration_id IS NOT NEW.migration_id OR invite_id IS NOT NEW.invite_id OR disposition IS NOT NEW.disposition OR seed_digest IS NOT NEW.seed_digest OR source_digest IS NOT NEW.source_digest OR source_json IS NOT NEW.source_json OR evidence_json IS NOT NEW.evidence_json OR canonical_actor_uid IS NOT NEW.canonical_actor_uid OR canonical_seed_digest IS NOT NEW.canonical_seed_digest OR manifest_digest IS NOT NEW.manifest_digest OR imported_at_ms IS NOT NEW.imported_at_ms)) BEGIN SELECT RAISE(ABORT, 'match-presentation-source-exception-immutable'); END;;

CREATE TRIGGER match_presentation_source_exception_canonical_live_guard BEFORE INSERT ON match_presentation_source_exceptions_canonical WHEN EXISTS (SELECT 1 FROM match_presentation_registrations_canonical WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id) BEGIN SELECT RAISE(ABORT, 'match-presentation-exception-live-actor'); END;;
