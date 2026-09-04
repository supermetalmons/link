ALTER TABLE match_timer_starts ADD COLUMN opponent_id TEXT;

CREATE TRIGGER match_timer_starts_opponent_insert
BEFORE INSERT ON match_timer_starts
WHEN NEW.opponent_id IS NOT NULL
  AND (NEW.opponent_id = '' OR instr(NEW.opponent_id, '/') != 0)
BEGIN
  SELECT RAISE(ABORT, 'invalid match timer opponent');
END;

CREATE TRIGGER match_timer_starts_opponent_update
BEFORE UPDATE OF opponent_id ON match_timer_starts
WHEN NEW.opponent_id IS NOT NULL
  AND (NEW.opponent_id = '' OR instr(NEW.opponent_id, '/') != 0)
BEGIN
  SELECT RAISE(ABORT, 'invalid match timer opponent');
END;

CREATE INDEX idx_match_timer_starts_reconciliation
ON match_timer_starts (updated_at_ms, player_id, match_id);
