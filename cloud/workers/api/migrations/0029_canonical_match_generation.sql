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
    (json_extract(record_json, '$.emojiId') BETWEEN 0 AND 154 OR json_extract(record_json, '$.emojiId') BETWEEN 1000 AND 1466) AND
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
) STRICT, WITHOUT ROWID;
CREATE TABLE match_state_claims_canonical (
  match_id TEXT NOT NULL CHECK (match_id IS NULL OR (match_id != '' AND instr(match_id, '/') = 0)),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND
    json_type(record_json) IS 'object' AND
    json_type(record_json, '$.schemaVersion') IS 'integer' AND
    json_extract(record_json, '$.schemaVersion') IS 1 AND
    json_type(record_json, '$.status') IS 'text' AND
    json_extract(record_json, '$.status') IN ('pending', 'claimed') AND
    json_type(record_json, '$.inviteId') IS 'text' AND
    json_extract(record_json, '$.inviteId') != '' AND
    json_type(record_json, '$.playerId') IS 'text' AND
    json_extract(record_json, '$.playerId') != '' AND
    json_type(record_json, '$.opponentId') IS 'text' AND
    json_extract(record_json, '$.opponentId') != '' AND
    json_extract(record_json, '$.playerId') != json_extract(record_json, '$.opponentId') AND
    json_type(record_json, '$.turnNumber') IS 'integer' AND
    json_extract(record_json, '$.turnNumber') BETWEEN 0 AND 9007199254740991 AND
    json_type(record_json, '$.timer') IS 'object' AND json_type(record_json, '$.timer.state') IS 'text' AND json_extract(record_json, '$.timer.state') IN ('idle', 'running', 'finished') AND (json_extract(record_json, '$.timer.state') != 'running' OR (json_type(record_json, '$.timer.turnNumber') IS 'integer' AND json_extract(record_json, '$.timer.turnNumber') BETWEEN 0 AND 9007199254740991 AND json_type(record_json, '$.timer.deadlineAtMs') IS 'integer' AND json_extract(record_json, '$.timer.deadlineAtMs') BETWEEN 1 AND 9007199254740991)) AND
    json_extract(record_json, '$.timer.state') != 'idle' AND
    (json_extract(record_json, '$.timer.state') != 'running' OR json_extract(record_json, '$.timer.turnNumber') IS json_extract(record_json, '$.turnNumber')) AND
    ((json_extract(record_json, '$.status') IS 'pending' AND json_extract(record_json, '$.timer.state') IS 'running' AND json_type(record_json, '$.claimedAtMs') IS 'null' AND json_type(record_json, '$.expiresAtMs') IS 'integer' AND json_extract(record_json, '$.expiresAtMs') BETWEEN 0 AND 9007199254740991) OR (json_extract(record_json, '$.status') IS 'claimed' AND json_type(record_json, '$.claimedAtMs') IS 'integer' AND json_extract(record_json, '$.claimedAtMs') BETWEEN 0 AND 9007199254740991 AND json_type(record_json, '$.expiresAtMs') IS 'null'))
  ),
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64 AND source_digest NOT GLOB '*[^a-f0-9]*'),
  import_id TEXT NOT NULL CHECK (import_id != ''),
  disposition TEXT NOT NULL CHECK (disposition IN ('missing-invite', 'ambiguous-invite', 'nonparticipant', 'malformed')),
  PRIMARY KEY (match_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE match_timer_starts_canonical (
  match_id TEXT NOT NULL CHECK (match_id IS NULL OR (match_id != '' AND instr(match_id, '/') = 0)),
  player_id TEXT NOT NULL CHECK (player_id IS NULL OR (player_id != '' AND instr(player_id, '/') = 0)),
  opponent_id TEXT NOT NULL CHECK (opponent_id IS NULL OR (opponent_id != '' AND instr(opponent_id, '/') = 0)),
  turn_number INTEGER NOT NULL CHECK (turn_number IS NULL OR turn_number BETWEEN 0 AND 9007199254740991),
  deadline_at_ms INTEGER NOT NULL CHECK (deadline_at_ms IS NULL OR deadline_at_ms BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms IS NULL OR updated_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (player_id, match_id),
  CHECK (opponent_id != player_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_match_timer_starts_canonical_updated ON match_timer_starts_canonical(updated_at_ms, player_id, match_id);
CREATE TABLE match_state_routes_canonical (
  actor_uid TEXT NOT NULL CHECK (actor_uid IS NULL OR (actor_uid != '' AND instr(actor_uid, '/') = 0)),
  match_id TEXT NOT NULL CHECK (match_id IS NULL OR (match_id != '' AND instr(match_id, '/') = 0)),
  kind TEXT NOT NULL CHECK(kind IN ('durable','archive')),
  invite_id TEXT CHECK (invite_id IS NULL OR (invite_id != '' AND instr(invite_id, '/') = 0)),
  epoch INTEGER NOT NULL CHECK (epoch IS NULL OR epoch BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (actor_uid, match_id),
  CHECK ((kind = 'durable' AND invite_id IS NOT NULL) OR (kind = 'archive' AND invite_id IS NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_match_state_routes_canonical_invite ON match_state_routes_canonical(invite_id, match_id);
CREATE TRIGGER match_state_records_canonical_insert_conflict BEFORE INSERT ON match_state_records_canonical WHEN EXISTS (SELECT 1 FROM match_state_records_canonical WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id AND (record_json IS NOT NEW.record_json OR source_digest IS NOT NEW.source_digest OR import_id IS NOT NEW.import_id OR disposition IS NOT NEW.disposition)) BEGIN SELECT RAISE(ABORT, 'match-state-archive-conflict'); END;
CREATE TRIGGER match_state_records_canonical_immutable BEFORE UPDATE ON match_state_records_canonical BEGIN SELECT RAISE(ABORT, 'match-state-archive-immutable'); END;
CREATE TRIGGER match_state_claims_canonical_insert_conflict BEFORE INSERT ON match_state_claims_canonical WHEN EXISTS (SELECT 1 FROM match_state_claims_canonical WHERE match_id = NEW.match_id AND (record_json IS NOT NEW.record_json OR source_digest IS NOT NEW.source_digest OR import_id IS NOT NEW.import_id OR disposition IS NOT NEW.disposition)) BEGIN SELECT RAISE(ABORT, 'match-state-archive-conflict'); END;
CREATE TRIGGER match_state_claims_canonical_immutable BEFORE UPDATE ON match_state_claims_canonical BEGIN SELECT RAISE(ABORT, 'match-state-archive-immutable'); END;
CREATE TRIGGER match_state_routes_canonical_insert_conflict BEFORE INSERT ON match_state_routes_canonical WHEN EXISTS (SELECT 1 FROM match_state_routes_canonical WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id AND (kind IS NOT NEW.kind OR invite_id IS NOT NEW.invite_id OR epoch IS NOT NEW.epoch)) BEGIN SELECT RAISE(ABORT, 'match-state-route-conflict'); END;
CREATE TRIGGER match_state_routes_canonical_update_conflict BEFORE UPDATE ON match_state_routes_canonical WHEN OLD.kind IS NOT NEW.kind OR OLD.invite_id IS NOT NEW.invite_id OR OLD.epoch IS NOT NEW.epoch BEGIN SELECT RAISE(ABORT, 'match-state-route-conflict'); END;
