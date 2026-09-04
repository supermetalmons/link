CREATE TABLE game_session_mutation_locks (
  lock_id TEXT PRIMARY KEY NOT NULL CHECK (lock_id != '' AND instr(lock_id, '/') = 0),
  owner_id TEXT NOT NULL CHECK (owner_id != ''),
  operation_id TEXT NOT NULL CHECK (operation_id != ''),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0)
) WITHOUT ROWID;

CREATE INDEX idx_game_session_mutation_locks_expiry
ON game_session_mutation_locks (expires_at_ms, lock_id);

CREATE TABLE match_timer_starts (
  player_id TEXT NOT NULL CHECK (player_id != '' AND instr(player_id, '/') = 0),
  match_id TEXT NOT NULL CHECK (match_id != '' AND instr(match_id, '/') = 0),
  timer TEXT NOT NULL CHECK (timer != ''),
  turn_number INTEGER NOT NULL CHECK (turn_number >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (player_id, match_id)
) WITHOUT ROWID;
