CREATE TABLE match_presentation_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  phase TEXT NOT NULL CHECK (phase IN ('legacy', 'capture', 'durable')),
  candidate_version_id TEXT,
  migration_id TEXT,
  capture_started_at_ms INTEGER,
  source_digest TEXT CHECK (source_digest IS NULL OR length(source_digest) = 64),
  source_count INTEGER CHECK (source_count IS NULL OR source_count >= 0),
  verification_digest TEXT CHECK (verification_digest IS NULL OR length(verification_digest) = 64),
  verified_at_ms INTEGER,
  activated_at_ms INTEGER,
  CHECK (phase = 'legacy' OR (candidate_version_id IS NOT NULL AND migration_id IS NOT NULL AND capture_started_at_ms IS NOT NULL)),
  CHECK (phase != 'durable' OR (source_digest IS NOT NULL AND source_count IS NOT NULL AND verification_digest IS NOT NULL AND verified_at_ms IS NOT NULL AND activated_at_ms IS NOT NULL))
);

INSERT INTO match_presentation_control (singleton, phase) VALUES (1, 'legacy');

CREATE TABLE match_presentation_registrations (
  invite_id TEXT NOT NULL CHECK (invite_id != ''),
  match_id TEXT NOT NULL CHECK (match_id != ''),
  actor_uid TEXT NOT NULL CHECK (actor_uid != ''),
  seed_digest TEXT NOT NULL CHECK (length(seed_digest) = 64),
  provenance TEXT NOT NULL CHECK (provenance IN ('creation', 'backfill')),
  source_id TEXT NOT NULL CHECK (source_id != ''),
  registered_at_ms INTEGER NOT NULL CHECK (registered_at_ms >= 0),
  PRIMARY KEY (invite_id, match_id, actor_uid),
  UNIQUE (actor_uid, match_id)
) WITHOUT ROWID;

CREATE TABLE match_presentation_registration_guards (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
);

CREATE TRIGGER match_presentation_registration_immutable_guard
BEFORE UPDATE ON match_presentation_registrations
WHEN NEW.invite_id != OLD.invite_id OR NEW.match_id != OLD.match_id
  OR NEW.actor_uid != OLD.actor_uid OR NEW.seed_digest != OLD.seed_digest
  OR NEW.provenance != OLD.provenance OR NEW.source_id != OLD.source_id
  OR NEW.registered_at_ms != OLD.registered_at_ms
BEGIN
  SELECT RAISE(ABORT, 'match-presentation-registration-immutable');
END;

CREATE TRIGGER match_presentation_registration_delete_guard
BEFORE DELETE ON match_presentation_registrations
BEGIN
  SELECT RAISE(ABORT, 'match-presentation-registration-immutable');
END;

CREATE TRIGGER match_presentation_control_phase_guard
BEFORE UPDATE ON match_presentation_control
WHEN (OLD.phase = 'durable' AND (
    NEW.phase != OLD.phase OR NEW.candidate_version_id IS NOT OLD.candidate_version_id
    OR NEW.migration_id IS NOT OLD.migration_id OR NEW.source_digest IS NOT OLD.source_digest
    OR NEW.capture_started_at_ms IS NOT OLD.capture_started_at_ms
    OR NEW.source_count IS NOT OLD.source_count OR NEW.verification_digest IS NOT OLD.verification_digest
    OR NEW.verified_at_ms IS NOT OLD.verified_at_ms OR NEW.activated_at_ms IS NOT OLD.activated_at_ms
  )) OR (OLD.phase = 'capture' AND (
    NEW.phase = 'legacy' OR NEW.migration_id IS NOT OLD.migration_id
    OR NEW.candidate_version_id IS NOT OLD.candidate_version_id
    OR NEW.capture_started_at_ms IS NOT OLD.capture_started_at_ms
    OR (OLD.source_digest IS NOT NULL AND NEW.source_digest IS NOT OLD.source_digest)
    OR (OLD.source_count IS NOT NULL AND NEW.source_count IS NOT OLD.source_count)
  )) OR (OLD.phase = 'legacy' AND NEW.phase = 'durable')
BEGIN
  SELECT RAISE(ABORT, 'match-presentation-authority-conflict');
END;

CREATE TRIGGER match_presentation_control_delete_guard
BEFORE DELETE ON match_presentation_control
BEGIN
  SELECT RAISE(ABORT, 'match-presentation-control-required');
END;

CREATE TRIGGER match_presentation_manual_completion_guard
BEFORE UPDATE OF status ON game_session_transitions
WHEN NEW.status = 'completed' AND OLD.status != 'completed'
  AND COALESCE((SELECT phase FROM match_presentation_control WHERE singleton = 1), 'capture') != 'legacy'
  AND EXISTS (
    SELECT 1 FROM json_each(NEW.payload_json, '$.creations') AS creation
    WHERE NOT EXISTS (
      SELECT 1 FROM match_presentation_registrations AS registration
      WHERE registration.invite_id = NEW.invite_id
        AND 'players/' || registration.actor_uid || '/matches/' || registration.match_id = json_extract(creation.value, '$.path')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'match-presentation-capture-required');
END;

CREATE TRIGGER match_presentation_event_publication_guard
BEFORE INSERT ON invite_sources
WHEN COALESCE((SELECT phase FROM match_presentation_control WHERE singleton = 1), 'capture') != 'legacy'
  AND NOT EXISTS (SELECT 1 FROM invite_sources WHERE invite_id = NEW.invite_id)
  AND (json_extract(NEW.source_json, '$.eventOwned') = 1 OR length(json_extract(NEW.source_json, '$.eventId')) > 0)
  AND (NOT EXISTS (
    SELECT 1 FROM match_presentation_registrations
    WHERE invite_id = NEW.invite_id AND match_id = NEW.invite_id
      AND actor_uid = json_extract(NEW.source_json, '$.hostId')
  ) OR NOT EXISTS (
    SELECT 1 FROM match_presentation_registrations
    WHERE invite_id = NEW.invite_id AND match_id = NEW.invite_id
      AND actor_uid = json_extract(NEW.source_json, '$.guestId')
  ))
BEGIN
  SELECT RAISE(ABORT, 'match-presentation-capture-required');
END;
