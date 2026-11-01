CREATE TABLE invite_sources_canonical (
  invite_id TEXT NOT NULL CHECK (invite_id IS NULL OR (invite_id != '' AND instr(invite_id, '/') = 0)),
  source_json TEXT NOT NULL CHECK(
    json_valid(source_json) AND
    json_type(source_json) IS 'object' AND
    json_type(source_json, '$.schemaVersion') IS 'integer' AND
    json_extract(source_json, '$.schemaVersion') IS 1 AND
    json_type(source_json, '$.version') IS 'integer' AND
    json_extract(source_json, '$.version') IS 2 AND
    json_type(source_json, '$.kind') IS 'text' AND
    json_extract(source_json, '$.kind') IN ('manual','automatch','event') AND
    json_type(source_json, '$.hostId') IS 'text' AND
    json_extract(source_json, '$.hostId') != '' AND
    json_type(source_json, '$.hostColor') IS 'text' AND
    json_extract(source_json, '$.hostColor') != '' AND
    json_extract(source_json, '$.hostColor') IN ('white','black') AND
    (json_type(source_json, '$.guestId') IS 'null' OR (json_type(source_json, '$.guestId') IS 'text' AND json_extract(source_json, '$.guestId') != json_extract(source_json, '$.hostId'))) AND
    json_type(source_json, '$.hostRematches') IS 'object' AND
    json_type(source_json, '$.hostRematches.state') IS 'text' AND
    json_extract(source_json, '$.hostRematches.state') IN ('open','ended') AND
    json_type(source_json, '$.hostRematches.indices') IS 'array' AND
    json_type(source_json, '$.guestRematches') IS 'object' AND
    json_type(source_json, '$.guestRematches.state') IS 'text' AND
    json_extract(source_json, '$.guestRematches.state') IN ('open','ended') AND
    json_type(source_json, '$.guestRematches.indices') IS 'array' AND
    (json_type(source_json, '$.sessionTransition') IS 'null' OR (json_type(source_json, '$.sessionTransition') IS 'object' AND json_type(source_json, '$.sessionTransition.transitionId') IS 'text' AND json_type(source_json, '$.sessionTransition.sequence') IS 'integer' AND json_type(source_json, '$.sessionTransition.digest') IS 'text')) AND
    (json_type(source_json, '$.automatchMessage') IS 'null' OR (json_type(source_json, '$.automatchMessage') IS 'object' AND json_type(source_json, '$.automatchMessage.name') IS 'text' AND json_type(source_json, '$.automatchMessage.text') IS 'text' AND json_type(source_json, '$.automatchMessage.telegramMessageId') IS 'integer')) AND
    json_type(source_json, '$.automatchOperationIds') IS 'object' AND
    (json_type(source_json, '$.password') IS 'null' OR json_type(source_json, '$.password') IS 'text') AND
    (json_type(source_json, '$.automatchStateHint') IS 'null' OR (json_type(source_json, '$.automatchStateHint') IS 'text' AND json_extract(source_json, '$.automatchStateHint') IN ('pending','matched','canceled'))) AND
    (json_type(source_json, '$.automatchCanceledAt') IS 'null' OR (json_type(source_json, '$.automatchCanceledAt') IS 'integer' AND json_extract(source_json, '$.automatchCanceledAt') BETWEEN 0 AND 9007199254740991)) AND
    (json_type(source_json, '$.telegramDeliveryVersion') IS 'null' OR (json_type(source_json, '$.telegramDeliveryVersion') IS 'integer' AND json_extract(source_json, '$.telegramDeliveryVersion') IS 2)) AND
    (json_type(source_json, '$.eventOwned') IS 'true' OR json_type(source_json, '$.eventOwned') IS 'false') AND
    (json_type(source_json, '$.eventId') IS 'null' OR json_type(source_json, '$.eventId') IS 'text') AND
    (json_type(source_json, '$.eventRoundIndex') IS 'null' OR (json_type(source_json, '$.eventRoundIndex') IS 'integer' AND json_extract(source_json, '$.eventRoundIndex') BETWEEN 0 AND 4)) AND
    (json_type(source_json, '$.eventMatchKey') IS 'null' OR json_type(source_json, '$.eventMatchKey') IS 'text') AND
    ((json_extract(source_json, '$.kind') IS 'event' AND json_type(source_json, '$.eventOwned') IS 'true' AND json_type(source_json, '$.eventId') IS 'text' AND json_type(source_json, '$.eventMatchKey') IS 'text' AND json_type(source_json, '$.guestId') IS 'text' AND json_type(source_json, '$.password') IS 'null') OR (json_extract(source_json, '$.kind') IN ('manual','automatch') AND json_type(source_json, '$.eventOwned') IS 'false' AND json_type(source_json, '$.eventId') IS 'null' AND json_type(source_json, '$.eventMatchKey') IS 'null' AND json_type(source_json, '$.eventRoundIndex') IS 'null')) AND
    (json_extract(source_json, '$.kind') IS 'automatch' OR (json_type(source_json, '$.password') IS 'null' AND json_type(source_json, '$.automatchStateHint') IS 'null' AND json_type(source_json, '$.automatchCanceledAt') IS 'null' AND json_type(source_json, '$.telegramDeliveryVersion') IS 'null' AND json_type(source_json, '$.automatchMessage') IS 'null')) AND
    (json_extract(source_json, '$.kind') IS NOT 'automatch' OR (json_type(source_json, '$.password') IS 'text' AND json_extract(source_json, '$.password') != ''))
  ),
  revision INTEGER NOT NULL CHECK (revision IS NULL OR revision BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms IS NULL OR updated_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (invite_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE login_match_discovery_canonical (
  login_uid TEXT NOT NULL CHECK (login_uid IS NULL OR (login_uid != '' AND instr(login_uid, '/') = 0)),
  match_id TEXT NOT NULL CHECK (match_id IS NULL OR (match_id != '' AND instr(match_id, '/') = 0)),
  match_sort_key TEXT NOT NULL CHECK (match_sort_key IS NULL OR (match_sort_key != '' AND instr(match_sort_key, '/') = 0)),
  invite_id TEXT CHECK (invite_id IS NULL OR (invite_id != '' AND instr(invite_id, '/') = 0)),
  resolution TEXT NOT NULL CHECK(resolution IN ('resolved','missing','ambiguous')),
  provenance TEXT NOT NULL CHECK(provenance IN ('capture','backfill')),
  indexed_at_ms INTEGER NOT NULL CHECK (indexed_at_ms IS NULL OR indexed_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (login_uid, match_id),
  CHECK ((resolution = 'resolved' AND invite_id IS NOT NULL) OR (resolution != 'resolved' AND invite_id IS NULL))
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX idx_login_match_discovery_canonical_page ON login_match_discovery_canonical(login_uid, match_sort_key);
CREATE TRIGGER login_match_discovery_canonical_mapping_guard BEFORE UPDATE OF invite_id, resolution ON login_match_discovery_canonical WHEN OLD.resolution = 'resolved' AND (NEW.resolution != 'resolved' OR NEW.invite_id IS NOT OLD.invite_id) BEGIN SELECT RAISE(ABORT, 'login-match-discovery-mapping-conflict'); END;
CREATE TABLE match_presentation_registrations_canonical (
  invite_id TEXT NOT NULL CHECK (invite_id IS NULL OR (invite_id != '' AND instr(invite_id, '/') = 0)),
  match_id TEXT NOT NULL CHECK (match_id IS NULL OR (match_id != '' AND instr(match_id, '/') = 0)),
  actor_uid TEXT NOT NULL CHECK (actor_uid IS NULL OR (actor_uid != '' AND instr(actor_uid, '/') = 0)),
  seed_digest TEXT NOT NULL CHECK(length(seed_digest) = 64 AND seed_digest NOT GLOB '*[^a-f0-9]*'),
  provenance TEXT NOT NULL CHECK(provenance IN ('creation','backfill')),
  source_id TEXT NOT NULL CHECK (source_id IS NULL OR (source_id != '' AND instr(source_id, '/') = 0)),
  registered_at_ms INTEGER NOT NULL CHECK (registered_at_ms IS NULL OR registered_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (invite_id, match_id, actor_uid),
  UNIQUE(actor_uid,match_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER match_presentation_registrations_canonical_immutable BEFORE UPDATE ON match_presentation_registrations_canonical BEGIN SELECT RAISE(ABORT, 'match-presentation-registration-immutable'); END;
CREATE TRIGGER match_presentation_registrations_canonical_delete_guard BEFORE DELETE ON match_presentation_registrations_canonical BEGIN SELECT RAISE(ABORT, 'match-presentation-registration-immutable'); END;
CREATE TRIGGER match_presentation_registrations_canonical_insert_guard BEFORE INSERT ON match_presentation_registrations_canonical WHEN EXISTS(SELECT 1 FROM match_presentation_registrations_canonical WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id AND (invite_id IS NOT NEW.invite_id OR seed_digest IS NOT NEW.seed_digest OR provenance IS NOT NEW.provenance OR source_id IS NOT NEW.source_id OR registered_at_ms IS NOT NEW.registered_at_ms)) BEGIN SELECT RAISE(ABORT, 'match-presentation-registration-immutable'); END;
CREATE TABLE historical_match_pairs_canonical (
  invite_id TEXT NOT NULL CHECK (invite_id IS NULL OR (invite_id != '' AND instr(invite_id, '/') = 0)),
  match_id TEXT NOT NULL CHECK (match_id IS NULL OR (match_id != '' AND instr(match_id, '/') = 0)),
  snapshot_json TEXT NOT NULL CHECK(
    json_valid(snapshot_json) AND
    json_type(snapshot_json) IS 'object' AND
    json_extract(snapshot_json, '$.matchId') IS match_id AND
    json_type(snapshot_json, '$.hostPlayerId') IS 'text' AND
    (json_type(snapshot_json, '$.guestPlayerId') IS 'null' OR json_type(snapshot_json, '$.guestPlayerId') IS 'text') AND
    (json_type(snapshot_json, '$.hostMatch') IS 'null' OR (json_type(snapshot_json, '$.hostMatch') IS 'object' AND json_extract(snapshot_json, '$.hostMatch.schemaVersion') IS 1 AND json_type(snapshot_json, '$.hostMatch.version') IS 'integer' AND json_type(snapshot_json, '$.hostMatch.color') IS 'text' AND json_extract(snapshot_json, '$.hostMatch.color') IN ('white','black') AND json_type(snapshot_json, '$.hostMatch.emojiId') IS 'integer' AND json_type(snapshot_json, '$.hostMatch.aura') IS 'text' AND json_extract(snapshot_json, '$.hostMatch.aura') IN ('none','rainbow') AND json_type(snapshot_json, '$.hostMatch.gameVariant') IS 'text' AND json_type(snapshot_json, '$.hostMatch.fen') IS 'text' AND json_type(snapshot_json, '$.hostMatch.status') IS 'text' AND json_extract(snapshot_json, '$.hostMatch.status') IN ('active','surrendered') AND json_type(snapshot_json, '$.hostMatch.flatMovesString') IS 'text' AND json_type(snapshot_json, '$.hostMatch.timer') IS 'object' AND json_type(snapshot_json, '$.hostMatch.timer.state') IS 'text' AND json_extract(snapshot_json, '$.hostMatch.timer.state') IN ('idle','running','finished'))) AND
    (json_type(snapshot_json, '$.guestMatch') IS 'null' OR (json_type(snapshot_json, '$.guestMatch') IS 'object' AND json_extract(snapshot_json, '$.guestMatch.schemaVersion') IS 1 AND json_type(snapshot_json, '$.guestMatch.version') IS 'integer' AND json_type(snapshot_json, '$.guestMatch.color') IS 'text' AND json_extract(snapshot_json, '$.guestMatch.color') IN ('white','black') AND json_type(snapshot_json, '$.guestMatch.emojiId') IS 'integer' AND json_type(snapshot_json, '$.guestMatch.aura') IS 'text' AND json_extract(snapshot_json, '$.guestMatch.aura') IN ('none','rainbow') AND json_type(snapshot_json, '$.guestMatch.gameVariant') IS 'text' AND json_type(snapshot_json, '$.guestMatch.fen') IS 'text' AND json_type(snapshot_json, '$.guestMatch.status') IS 'text' AND json_extract(snapshot_json, '$.guestMatch.status') IN ('active','surrendered') AND json_type(snapshot_json, '$.guestMatch.flatMovesString') IS 'text' AND json_type(snapshot_json, '$.guestMatch.timer') IS 'object' AND json_type(snapshot_json, '$.guestMatch.timer.state') IS 'text' AND json_extract(snapshot_json, '$.guestMatch.timer.state') IN ('idle','running','finished'))) AND
    (json_type(snapshot_json, '$.hostMatch') IS 'object' OR json_type(snapshot_json, '$.guestMatch') IS 'object')
  ),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('rating','transition','backfill')),
  finalized_at_ms INTEGER NOT NULL CHECK (finalized_at_ms IS NULL OR finalized_at_ms BETWEEN 0 AND 9007199254740991),
  archived_at_ms INTEGER NOT NULL CHECK (archived_at_ms IS NULL OR archived_at_ms BETWEEN 0 AND 9007199254740991),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  revision INTEGER NOT NULL CHECK (revision IS NULL OR revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (invite_id, match_id),
  CHECK(archived_at_ms >= finalized_at_ms)
) STRICT, WITHOUT ROWID;
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
    (json_extract(source_json, '$.emojiId') BETWEEN 0 AND 154 OR json_extract(source_json, '$.emojiId') BETWEEN 1000 AND 1466) AND
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
) STRICT, WITHOUT ROWID;
CREATE TRIGGER match_presentation_source_exceptions_canonical_immutable BEFORE UPDATE ON match_presentation_source_exceptions_canonical BEGIN SELECT RAISE(ABORT, 'match-presentation-source-exception-immutable'); END;
CREATE TRIGGER match_presentation_canonical_event_publication_guard BEFORE INSERT ON invite_sources_canonical WHEN COALESCE((SELECT phase FROM match_presentation_control WHERE singleton = 1), 'capture') != 'legacy' AND NOT EXISTS(SELECT 1 FROM invite_sources_canonical WHERE invite_id = NEW.invite_id) AND json_extract(NEW.source_json, '$.kind') IS 'event' AND (NOT EXISTS(SELECT 1 FROM match_presentation_registrations_canonical WHERE invite_id = NEW.invite_id AND match_id = NEW.invite_id AND actor_uid = json_extract(NEW.source_json, '$.hostId')) OR NOT EXISTS(SELECT 1 FROM match_presentation_registrations_canonical WHERE invite_id = NEW.invite_id AND match_id = NEW.invite_id AND actor_uid = json_extract(NEW.source_json, '$.guestId'))) BEGIN SELECT RAISE(ABORT, 'match-presentation-capture-required'); END;
CREATE TRIGGER match_presentation_source_exceptions_canonical_delete_guard BEFORE DELETE ON match_presentation_source_exceptions_canonical BEGIN SELECT RAISE(ABORT, 'match-presentation-source-exception-immutable'); END;
CREATE TRIGGER match_presentation_source_exceptions_canonical_insert_guard BEFORE INSERT ON match_presentation_source_exceptions_canonical WHEN EXISTS(SELECT 1 FROM match_presentation_source_exceptions_canonical WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id AND (migration_id IS NOT NEW.migration_id OR invite_id IS NOT NEW.invite_id OR disposition IS NOT NEW.disposition OR seed_digest IS NOT NEW.seed_digest OR source_digest IS NOT NEW.source_digest OR source_json IS NOT NEW.source_json OR evidence_json IS NOT NEW.evidence_json OR canonical_actor_uid IS NOT NEW.canonical_actor_uid OR canonical_seed_digest IS NOT NEW.canonical_seed_digest OR manifest_digest IS NOT NEW.manifest_digest OR imported_at_ms IS NOT NEW.imported_at_ms)) BEGIN SELECT RAISE(ABORT, 'match-presentation-source-exception-immutable'); END;
CREATE TRIGGER match_presentation_registration_canonical_exception_guard BEFORE INSERT ON match_presentation_registrations_canonical WHEN EXISTS (SELECT 1 FROM match_presentation_source_exceptions_canonical WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id) BEGIN SELECT RAISE(ABORT, 'match-presentation-exception-live-actor'); END;
CREATE TRIGGER match_presentation_source_exception_canonical_live_guard BEFORE INSERT ON match_presentation_source_exceptions_canonical WHEN EXISTS (SELECT 1 FROM match_presentation_registrations_canonical WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id) BEGIN SELECT RAISE(ABORT, 'match-presentation-exception-live-actor'); END;
