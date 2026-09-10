CREATE TRIGGER match_presentation_control_insert_guard
BEFORE INSERT ON match_presentation_control
WHEN EXISTS (SELECT 1 FROM match_presentation_control)
BEGIN
  SELECT RAISE(ABORT, 'match-presentation-authority-conflict');
END;

CREATE TRIGGER match_presentation_registration_insert_guard
BEFORE INSERT ON match_presentation_registrations
BEGIN
  SELECT RAISE(ABORT, 'match-presentation-exception-live-actor')
  WHERE EXISTS (
    SELECT 1 FROM match_presentation_source_exceptions
    WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id
  );
  SELECT RAISE(ABORT, 'match-presentation-registration-immutable')
  WHERE EXISTS (
    SELECT 1 FROM match_presentation_registrations
    WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id
      AND (invite_id IS NOT NEW.invite_id OR seed_digest IS NOT NEW.seed_digest)
  );
  SELECT RAISE(IGNORE)
  WHERE EXISTS (
    SELECT 1 FROM match_presentation_registrations
    WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id
  );
END;
