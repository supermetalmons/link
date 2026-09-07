CREATE TABLE game_session_transitions (
  transition_id TEXT PRIMARY KEY NOT NULL CHECK (transition_id != ''),
  invite_id TEXT NOT NULL CHECK (invite_id != ''),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT
) WITHOUT ROWID;

CREATE INDEX idx_game_session_transitions_pending
ON game_session_transitions (status, updated_at_ms, transition_id);

CREATE TABLE game_session_transition_resources (
  resource_key TEXT PRIMARY KEY NOT NULL CHECK (resource_key != ''),
  transition_id TEXT NOT NULL REFERENCES game_session_transitions(transition_id)
) WITHOUT ROWID;

CREATE INDEX idx_game_session_transition_resources_intent
ON game_session_transition_resources (transition_id);

CREATE TABLE game_session_transition_guards (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
);
