const SCHEMA_VERSION_KEY = "invite-room:schema-version";

export function ensureInviteRoomSchema(storage: DurableObjectStorage): void {
  const version = storage.kv.get(SCHEMA_VERSION_KEY);
  if (version === 1) return;
  if (version !== undefined) {
    throw new Error("invite-room-schema-version-unsupported");
  }
  storage.transactionSync(() => {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS invite_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), invite_id TEXT NOT NULL, snapshot_json TEXT, revision INTEGER NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS invite_wagers (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), invite_id TEXT NOT NULL, snapshot_json TEXT, revision INTEGER NOT NULL, source_fingerprint TEXT)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS invite_refresh_schedule (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), next_at_ms INTEGER NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_presentations (match_id TEXT NOT NULL, actor_uid TEXT NOT NULL, emoji_id INTEGER NOT NULL, aura TEXT NOT NULL, revision INTEGER NOT NULL, operation_id TEXT, operation_json TEXT, PRIMARY KEY(match_id, actor_uid))",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS frozen_match_presentations (match_id TEXT NOT NULL, actor_uid TEXT NOT NULL, emoji_id INTEGER NOT NULL, aura TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(match_id, actor_uid))",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_presentation_seeds (match_id TEXT NOT NULL, actor_uid TEXT NOT NULL, invite_id TEXT NOT NULL, seed_digest TEXT NOT NULL, emoji_id INTEGER NOT NULL, aura TEXT NOT NULL, provenance TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(match_id, actor_uid))",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS latest_reactions (sender_uid TEXT PRIMARY KEY, reaction_json TEXT NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_state_source (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), invite_id TEXT NOT NULL, active_epoch INTEGER, staged_epoch INTEGER, import_id TEXT, digest TEXT)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_state_records (match_id TEXT NOT NULL, player_id TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(match_id, player_id))",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_state_revisions (match_id TEXT PRIMARY KEY, revision INTEGER NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_state_claims (match_id TEXT PRIMARY KEY, value_json TEXT NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_state_effects (effect_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, next_at_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 0, completed_at_ms INTEGER)",
    );
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS match_state_effects_due ON match_state_effects(next_at_ms)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_state_event_receipts (operation_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_state_timer_cohorts (match_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('d1', 'local')), schema_version INTEGER NOT NULL CHECK(schema_version = 1))",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_state_timer_starts (match_id TEXT NOT NULL, player_id TEXT NOT NULL, opponent_id TEXT NOT NULL, timer TEXT NOT NULL, turn_number INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY(match_id, player_id))",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS match_sync_snapshots (match_id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, revision INTEGER NOT NULL, next_at_ms INTEGER)",
    );
    storage.kv.put(SCHEMA_VERSION_KEY, 1);
  });
}
