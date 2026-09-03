CREATE TABLE event_profile_game_projection_fences (
  event_id TEXT PRIMARY KEY CHECK (
    event_id != '' AND instr(event_id, '/') = 0
  ),
  generation INTEGER NOT NULL CHECK (generation > 0)
) WITHOUT ROWID;
