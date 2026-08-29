ALTER TABLE wager_settlements
ADD COLUMN outcome TEXT NOT NULL DEFAULT 'applied' CHECK (
  outcome IN ('applied', 'insufficient-materials')
);

DROP TRIGGER wager_settlements_reject_replace;

CREATE TRIGGER wager_settlements_reject_replace
BEFORE INSERT ON wager_settlements
WHEN EXISTS (
  SELECT 1 FROM wager_settlements
  WHERE operation_id = NEW.operation_id
    AND (
      fingerprint IS NOT NEW.fingerprint
      OR winner_profile_id IS NOT NEW.winner_profile_id
      OR loser_profile_id IS NOT NEW.loser_profile_id
      OR material IS NOT NEW.material
      OR count IS NOT NEW.count
      OR applied_at_ms IS NOT NEW.applied_at_ms
      OR outcome IS NOT NEW.outcome
      OR revision IS NOT NEW.revision
    )
)
BEGIN
  SELECT RAISE(ABORT, 'wager settlements are immutable');
END;
