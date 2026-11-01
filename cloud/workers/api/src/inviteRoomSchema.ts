const SCHEMA_VERSION_KEY = "invite-room:schema-version";
const TIMER_LAYOUT_KEY = "invite-room:timer-layout-version";
const MATCH_SYNC_INDEX_KEY = "invite-room:match-sync-due-index";
const CANONICAL_TABLE_NAMES = [
  "match_state_records_canonical",
  "match_state_claims_canonical",
  "match_state_timer_starts_canonical",
  "match_state_revisions_canonical",
  "match_state_source_canonical",
  "match_state_timer_cohorts_canonical",
  "match_state_effects_canonical",
  "match_presentations_canonical",
  "frozen_match_presentations_canonical",
  "match_presentation_seeds_canonical",
  "latest_reactions_canonical",
  "invite_metadata_canonical",
  "invite_wagers_canonical",
  "invite_refresh_schedule_canonical",
  "match_sync_snapshots_canonical",
  "match_state_event_receipts_canonical",
];

const CANONICAL_INVITE_ROOM_SCHEMA = `CREATE TABLE IF NOT EXISTS match_state_records_canonical (
  player_id TEXT NOT NULL CHECK (player_id IS NULL OR (player_id != '' AND instr(player_id, '/') = 0)),
  match_id TEXT NOT NULL CHECK (match_id IS NULL OR (match_id != '' AND instr(match_id, '/') = 0)),
  value_json TEXT NOT NULL CHECK (
    json_valid(value_json) AND
    json_type(value_json) IS 'object' AND
    json_type(value_json, '$.schemaVersion') IS 'integer' AND
    json_extract(value_json, '$.schemaVersion') IS 1 AND
    json_type(value_json, '$.version') IS 'integer' AND
    json_extract(value_json, '$.version') IN (1, 2) AND
    json_type(value_json, '$.color') IS 'text' AND
    json_extract(value_json, '$.color') IN ('white', 'black') AND
    json_type(value_json, '$.emojiId') IS 'integer' AND
    (json_extract(value_json, '$.emojiId') BETWEEN 0 AND 155 OR json_extract(value_json, '$.emojiId') BETWEEN 1000 AND 1466) AND
    json_type(value_json, '$.aura') IS 'text' AND
    json_extract(value_json, '$.aura') IN ('none', 'rainbow') AND
    json_type(value_json, '$.gameVariant') IS 'text' AND
    json_extract(value_json, '$.gameVariant') != '' AND
    json_type(value_json, '$.fen') IS 'text' AND
    json_extract(value_json, '$.fen') != '' AND
    json_type(value_json, '$.status') IS 'text' AND
    json_extract(value_json, '$.status') IN ('active', 'surrendered') AND
    json_type(value_json, '$.flatMovesString') IS 'text' AND
    json_type(value_json, '$.timer') IS 'object' AND json_type(value_json, '$.timer.state') IS 'text' AND json_extract(value_json, '$.timer.state') IN ('idle', 'running', 'finished') AND (json_extract(value_json, '$.timer.state') != 'running' OR (json_type(value_json, '$.timer.turnNumber') IS 'integer' AND json_extract(value_json, '$.timer.turnNumber') BETWEEN 0 AND 9007199254740991 AND json_type(value_json, '$.timer.deadlineAtMs') IS 'integer' AND json_extract(value_json, '$.timer.deadlineAtMs') BETWEEN 1 AND 9007199254740991)) AND
    (json_type(value_json, '$.sessionCreation') IS 'null' OR (json_type(value_json, '$.sessionCreation') IS 'text' AND json_extract(value_json, '$.sessionCreation') != '')) AND
    (json_type(value_json, '$.reaction') IS 'null' OR (json_type(value_json, '$.reaction') IS 'object' AND json_type(value_json, '$.reaction.uuid') IS 'text' AND json_type(value_json, '$.reaction.kind') IS 'text' AND json_type(value_json, '$.reaction.variation') IS 'integer'))
  ),
  PRIMARY KEY (match_id, player_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS match_state_claims_canonical (
  match_id TEXT NOT NULL CHECK (match_id IS NULL OR (match_id != '' AND instr(match_id, '/') = 0)),
  value_json TEXT NOT NULL CHECK (
    json_valid(value_json) AND
    json_type(value_json) IS 'object' AND
    json_type(value_json, '$.schemaVersion') IS 'integer' AND
    json_extract(value_json, '$.schemaVersion') IS 1 AND
    json_type(value_json, '$.status') IS 'text' AND
    json_extract(value_json, '$.status') IN ('pending', 'claimed') AND
    json_type(value_json, '$.inviteId') IS 'text' AND
    json_extract(value_json, '$.inviteId') != '' AND
    json_type(value_json, '$.playerId') IS 'text' AND
    json_extract(value_json, '$.playerId') != '' AND
    json_type(value_json, '$.opponentId') IS 'text' AND
    json_extract(value_json, '$.opponentId') != '' AND
    json_extract(value_json, '$.playerId') != json_extract(value_json, '$.opponentId') AND
    json_type(value_json, '$.turnNumber') IS 'integer' AND
    json_extract(value_json, '$.turnNumber') BETWEEN 0 AND 9007199254740991 AND
    json_type(value_json, '$.timer') IS 'object' AND json_type(value_json, '$.timer.state') IS 'text' AND json_extract(value_json, '$.timer.state') IN ('idle', 'running', 'finished') AND (json_extract(value_json, '$.timer.state') != 'running' OR (json_type(value_json, '$.timer.turnNumber') IS 'integer' AND json_extract(value_json, '$.timer.turnNumber') BETWEEN 0 AND 9007199254740991 AND json_type(value_json, '$.timer.deadlineAtMs') IS 'integer' AND json_extract(value_json, '$.timer.deadlineAtMs') BETWEEN 1 AND 9007199254740991)) AND
    json_extract(value_json, '$.timer.state') != 'idle' AND
    (json_extract(value_json, '$.timer.state') != 'running' OR json_extract(value_json, '$.timer.turnNumber') IS json_extract(value_json, '$.turnNumber')) AND
    ((json_extract(value_json, '$.status') IS 'pending' AND json_extract(value_json, '$.timer.state') IS 'running' AND json_type(value_json, '$.claimedAtMs') IS 'null' AND json_type(value_json, '$.expiresAtMs') IS 'integer' AND json_extract(value_json, '$.expiresAtMs') BETWEEN 0 AND 9007199254740991) OR (json_extract(value_json, '$.status') IS 'claimed' AND json_type(value_json, '$.claimedAtMs') IS 'integer' AND json_extract(value_json, '$.claimedAtMs') BETWEEN 0 AND 9007199254740991 AND json_type(value_json, '$.expiresAtMs') IS 'null'))
  ),
  PRIMARY KEY (match_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS match_state_timer_starts_canonical (
  match_id TEXT NOT NULL CHECK (match_id IS NULL OR (match_id != '' AND instr(match_id, '/') = 0)),
  player_id TEXT NOT NULL CHECK (player_id IS NULL OR (player_id != '' AND instr(player_id, '/') = 0)),
  opponent_id TEXT NOT NULL CHECK (opponent_id IS NULL OR (opponent_id != '' AND instr(opponent_id, '/') = 0)),
  turn_number INTEGER NOT NULL CHECK (turn_number IS NULL OR turn_number BETWEEN 0 AND 9007199254740991),
  deadline_at_ms INTEGER NOT NULL CHECK (deadline_at_ms IS NULL OR deadline_at_ms BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms IS NULL OR updated_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (match_id, player_id),
  CHECK(opponent_id != player_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS match_state_revisions_canonical (
  match_id TEXT NOT NULL CHECK (match_id IS NULL OR (match_id != '' AND instr(match_id, '/') = 0)),
  revision INTEGER NOT NULL CHECK (revision IS NULL OR revision BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (match_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS match_state_source_canonical (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  invite_id TEXT NOT NULL CHECK (invite_id IS NULL OR (invite_id != '' AND instr(invite_id, '/') = 0)),
  active_epoch INTEGER CHECK (active_epoch IS NULL OR active_epoch BETWEEN 1 AND 9007199254740991),
  staged_epoch INTEGER CHECK (staged_epoch IS NULL OR staged_epoch BETWEEN 1 AND 9007199254740991),
  import_id TEXT CHECK(import_id IS NULL OR import_id != ''),
  digest TEXT CHECK(digest IS NULL OR (length(digest) = 64 AND digest NOT GLOB '*[^a-f0-9]*')),
  CHECK (active_epoch IS NOT NULL OR staged_epoch IS NOT NULL),
  CHECK ((import_id IS NULL) = (digest IS NULL)),
  CHECK (staged_epoch IS NULL OR (import_id IS NOT NULL AND (active_epoch IS NULL OR staged_epoch >= active_epoch)))
) STRICT;
CREATE TABLE IF NOT EXISTS match_state_timer_cohorts_canonical (
  match_id TEXT NOT NULL CHECK (match_id IS NULL OR (match_id != '' AND instr(match_id, '/') = 0)),
  mode TEXT NOT NULL CHECK(mode IN ('d1','local')),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  PRIMARY KEY (match_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS match_state_effects_canonical (
  effect_id TEXT NOT NULL CHECK (effect_id IS NULL OR (effect_id != '' AND instr(effect_id, '/') = 0)),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json) IS 'object' AND json_extract(payload_json, '$.schemaVersion') IS 1 AND json_extract(payload_json, '$.kind') IS 'timer-claimed' AND json_extract(payload_json, '$.effectId') IS effect_id),
  state TEXT NOT NULL CHECK(state IN ('pending','completed')),
  next_at_ms INTEGER CHECK (next_at_ms IS NULL OR next_at_ms BETWEEN 0 AND 9007199254740991),
  attempts INTEGER NOT NULL CHECK (attempts IS NULL OR attempts BETWEEN 0 AND 9007199254740991),
  completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (effect_id),
  CHECK ((state = 'pending' AND next_at_ms IS NOT NULL AND completed_at_ms IS NULL) OR (state = 'completed' AND next_at_ms IS NULL AND completed_at_ms IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_match_state_effects_canonical_due ON match_state_effects_canonical(next_at_ms);
CREATE TABLE IF NOT EXISTS match_presentations_canonical (
  match_id TEXT NOT NULL CHECK (match_id IS NULL OR (match_id != '' AND instr(match_id, '/') = 0)),
  actor_uid TEXT NOT NULL CHECK (actor_uid IS NULL OR (actor_uid != '' AND instr(actor_uid, '/') = 0)),
  emoji_id INTEGER NOT NULL CHECK(emoji_id BETWEEN 0 AND 155 OR emoji_id BETWEEN 1000 AND 1466),
  aura TEXT NOT NULL CHECK(aura IN ('none','rainbow')),
  revision INTEGER NOT NULL CHECK (revision IS NULL OR revision BETWEEN 0 AND 9007199254740991),
  operation_id TEXT,
  operation_json TEXT CHECK(operation_json IS NULL OR (json_valid(operation_json) AND json_type(operation_json) IS 'object')),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  PRIMARY KEY (match_id, actor_uid),
  CHECK((operation_id IS NULL) = (operation_json IS NULL))
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS frozen_match_presentations_canonical (
  match_id TEXT NOT NULL CHECK (match_id IS NULL OR (match_id != '' AND instr(match_id, '/') = 0)),
  actor_uid TEXT NOT NULL CHECK (actor_uid IS NULL OR (actor_uid != '' AND instr(actor_uid, '/') = 0)),
  emoji_id INTEGER NOT NULL CHECK(emoji_id BETWEEN 0 AND 155 OR emoji_id BETWEEN 1000 AND 1466),
  aura TEXT NOT NULL CHECK(aura IN ('none','rainbow')),
  revision INTEGER NOT NULL CHECK (revision IS NULL OR revision BETWEEN 0 AND 9007199254740991),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  PRIMARY KEY (match_id, actor_uid)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS match_presentation_seeds_canonical (
  match_id TEXT NOT NULL CHECK (match_id IS NULL OR (match_id != '' AND instr(match_id, '/') = 0)),
  actor_uid TEXT NOT NULL CHECK (actor_uid IS NULL OR (actor_uid != '' AND instr(actor_uid, '/') = 0)),
  invite_id TEXT NOT NULL CHECK (invite_id IS NULL OR (invite_id != '' AND instr(invite_id, '/') = 0)),
  seed_digest TEXT NOT NULL CHECK(length(seed_digest) = 64 AND seed_digest NOT GLOB '*[^a-f0-9]*'),
  emoji_id INTEGER NOT NULL CHECK(emoji_id BETWEEN 0 AND 155 OR emoji_id BETWEEN 1000 AND 1466),
  aura TEXT NOT NULL CHECK(aura IN ('none','rainbow')),
  provenance TEXT NOT NULL CHECK(provenance IN ('creation','backfill')),
  source_id TEXT NOT NULL CHECK(source_id != ''),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  PRIMARY KEY (match_id, actor_uid)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS latest_reactions_canonical (
  sender_uid TEXT NOT NULL CHECK (sender_uid IS NULL OR (sender_uid != '' AND instr(sender_uid, '/') = 0)),
  reaction_json TEXT NOT NULL CHECK(json_valid(reaction_json) AND json_type(reaction_json) IS 'object' AND json_type(reaction_json, '$.uuid') IS 'text' AND json_type(reaction_json, '$.kind') IS 'text' AND json_type(reaction_json, '$.variation') IS 'integer' AND json_extract(reaction_json, '$.variation') > 0 AND json_type(reaction_json, '$.matchId') IS 'text'),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  PRIMARY KEY (sender_uid)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS invite_metadata_canonical (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  invite_id TEXT NOT NULL CHECK (invite_id IS NULL OR (invite_id != '' AND instr(invite_id, '/') = 0)),
  snapshot_json TEXT CHECK(snapshot_json IS NULL OR (json_valid(snapshot_json) AND json_type(snapshot_json) IS 'object')),
  revision INTEGER NOT NULL CHECK (revision IS NULL OR revision BETWEEN 0 AND 9007199254740991),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1)
) STRICT;
CREATE TABLE IF NOT EXISTS invite_wagers_canonical (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  invite_id TEXT NOT NULL CHECK (invite_id IS NULL OR (invite_id != '' AND instr(invite_id, '/') = 0)),
  snapshot_json TEXT CHECK(snapshot_json IS NULL OR (json_valid(snapshot_json) AND json_type(snapshot_json) IS 'object')),
  revision INTEGER NOT NULL CHECK (revision IS NULL OR revision BETWEEN 0 AND 9007199254740991),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  source_fingerprint TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS invite_refresh_schedule_canonical (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  next_at_ms INTEGER NOT NULL CHECK (next_at_ms IS NULL OR next_at_ms BETWEEN 0 AND 9007199254740991),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1)
) STRICT;
CREATE TABLE IF NOT EXISTS match_sync_snapshots_canonical (
  match_id TEXT NOT NULL CHECK (match_id IS NULL OR (match_id != '' AND instr(match_id, '/') = 0)),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND json_type(snapshot_json) IS 'object' AND json_extract(snapshot_json, '$.matchId') IS match_id),
  revision INTEGER NOT NULL CHECK (revision IS NULL OR revision BETWEEN 0 AND 9007199254740991),
  next_at_ms INTEGER CHECK (next_at_ms IS NULL OR next_at_ms BETWEEN 0 AND 9007199254740991),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version = 1),
  PRIMARY KEY (match_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_match_sync_snapshots_canonical_due ON match_sync_snapshots_canonical(next_at_ms);
CREATE TABLE IF NOT EXISTS match_state_event_receipts_canonical (
  operation_id TEXT NOT NULL CHECK (operation_id IS NULL OR (operation_id != '' AND instr(operation_id, '/') = 0)),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json) IS 'object' AND json_extract(payload_json, '$.schemaVersion') IS 1 AND json_extract(payload_json, '$.operationId') IS operation_id AND json_type(payload_json, '$.inviteId') IS 'text' AND json_type(payload_json, '$.epoch') IS 'integer' AND json_type(payload_json, '$.creations') IS 'array' AND json_type(payload_json, '$.terminalTimers') IS 'array' AND json_type(payload_json, '$.claims') IS 'array'),
  operation_digest TEXT NOT NULL CHECK(length(operation_digest) = 64 AND operation_digest NOT GLOB '*[^a-f0-9]*'),
  PRIMARY KEY (operation_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS match_state_event_receipts_canonical_immutable BEFORE UPDATE ON match_state_event_receipts_canonical BEGIN SELECT RAISE(ABORT, 'match-state-event-receipt-immutable'); END;
CREATE TRIGGER IF NOT EXISTS match_state_event_receipts_canonical_insert_conflict BEFORE INSERT ON match_state_event_receipts_canonical WHEN EXISTS(SELECT 1 FROM match_state_event_receipts_canonical WHERE operation_id = NEW.operation_id AND (payload_json IS NOT NEW.payload_json OR operation_digest IS NOT NEW.operation_digest)) BEGIN SELECT RAISE(ABORT, 'match-state-event-receipt-conflict'); END;
`;

export function ensureCanonicalInviteRoomSchema(
  storage: DurableObjectStorage,
): void {
  const tableCount = storage.sql
    .exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN (${CANONICAL_TABLE_NAMES.map(() => "?").join(", ")})`,
      ...CANONICAL_TABLE_NAMES,
    )
    .one().count;
  if (tableCount === CANONICAL_TABLE_NAMES.length) return;
  storage.transactionSync(() => {
    storage.sql.exec(CANONICAL_INVITE_ROOM_SCHEMA);
  });
}

const LOCAL_TIMER_STORAGE_GUARDS = `
CREATE TRIGGER IF NOT EXISTS match_state_timer_cohorts_local_insert
BEFORE INSERT ON match_state_timer_cohorts_canonical
WHEN NEW.mode != 'local'
BEGIN SELECT RAISE(ABORT, 'match-timer-storage-local-required'); END;
CREATE TRIGGER IF NOT EXISTS match_state_timer_cohorts_local_update
BEFORE UPDATE ON match_state_timer_cohorts_canonical
WHEN NEW.mode != 'local'
BEGIN SELECT RAISE(ABORT, 'match-timer-storage-local-required'); END;
`;

export function assertLocalInviteRoomLayout(
  storage: DurableObjectStorage,
): void {
  if (storage.kv.get(TIMER_LAYOUT_KEY) !== 2)
    throw new Error("invite-room-timer-layout-unverified");
  const count = storage.sql
    .exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name IN (${CANONICAL_TABLE_NAMES.map(() => "?").join(",")})`,
      ...CANONICAL_TABLE_NAMES,
    )
    .one().count;
  if (count !== CANONICAL_TABLE_NAMES.length)
    throw new Error("invite-room-canonical-schema-incomplete");
  const invalid = storage.sql
    .exec<{ invalid: number }>(
      `SELECT
    EXISTS(SELECT 1 FROM match_state_timer_cohorts_canonical WHERE mode != 'local' OR schema_version != 1)
    OR EXISTS(SELECT 1 FROM match_state_records_canonical record WHERE NOT EXISTS(
      SELECT 1 FROM match_state_timer_cohorts_canonical cohort WHERE cohort.match_id = record.match_id))
    OR EXISTS(SELECT 1 FROM match_state_timer_starts_canonical marker WHERE NOT EXISTS(
      SELECT 1 FROM match_state_timer_cohorts_canonical cohort WHERE cohort.match_id = marker.match_id)) AS invalid`,
    )
    .one().invalid;
  if (invalid !== 0) throw new Error("invite-room-timer-layout-invalid");
}

export function ensureInviteRoomSchema(
  storage: DurableObjectStorage,
  options: { fresh?: boolean } = {},
): void {
  const version = storage.kv.get(SCHEMA_VERSION_KEY);
  const indexVersion = storage.kv.get(MATCH_SYNC_INDEX_KEY);
  if (version !== undefined && version !== 1)
    throw new Error("invite-room-schema-version-unsupported");
  if (indexVersion !== undefined && indexVersion !== 1)
    throw new Error("invite-room-match-sync-index-version-unsupported");
  if (!options.fresh) {
    assertLocalInviteRoomLayout(storage);
    if (version !== 1 || indexVersion !== 1)
      throw new Error("invite-room-schema-metadata-missing");
  } else {
    ensureCanonicalInviteRoomSchema(storage);
    storage.transactionSync(() => {
      storage.kv.put(SCHEMA_VERSION_KEY, 1);
      storage.kv.put(MATCH_SYNC_INDEX_KEY, 1);
    });
  }
  storage.transactionSync(() => storage.sql.exec(LOCAL_TIMER_STORAGE_GUARDS));
}
