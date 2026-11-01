CREATE TABLE event_records_canonical (
  event_id TEXT PRIMARY KEY CHECK (event_id != '' AND instr(event_id, '/') = 0),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'active', 'ended', 'dismissed')),
  start_at_ms INTEGER NOT NULL CHECK (start_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  pending_transition_id TEXT CHECK (pending_transition_id IS NULL OR pending_transition_id != ''),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) IS 'object'
    AND json_type(record_json, '$.schemaVersion') IS 'integer'
    AND json_extract(record_json, '$.schemaVersion') IS 3
    AND json_type(record_json, '$.eventId') IS 'text'
    AND json_extract(record_json, '$.eventId') IS event_id
    AND json_type(record_json, '$.status') IS 'text'
    AND json_extract(record_json, '$.status') IS status
    AND json_type(record_json, '$.startAtMs') IS 'integer'
    AND json_extract(record_json, '$.startAtMs') IS start_at_ms
    AND json_type(record_json, '$.updatedAtMs') IS 'integer'
    AND json_extract(record_json, '$.updatedAtMs') IS updated_at_ms
    AND json_type(record_json, '$.createdAtMs') IS 'integer'
    AND json_extract(record_json, '$.createdAtMs') BETWEEN 0 AND 9007199254740991
    AND (json_type(record_json, '$.startedAtMs') IS 'null' OR json_type(record_json, '$.startedAtMs') IS 'integer')
    AND (json_type(record_json, '$.endedAtMs') IS 'null' OR json_type(record_json, '$.endedAtMs') IS 'integer')
    AND json_type(record_json, '$.createdByProfileId') IS 'text'
    AND json_type(record_json, '$.createdByLoginUid') IS 'text'
    AND json_type(record_json, '$.createdByUsername') IS 'text'
    AND (json_type(record_json, '$.winnerProfileId') IS 'null' OR json_type(record_json, '$.winnerProfileId') IS 'text')
    AND (json_type(record_json, '$.winnerDisplayName') IS 'null' OR json_type(record_json, '$.winnerDisplayName') IS 'text')
    AND (json_type(record_json, '$.currentRoundIndex') IS 'null' OR json_type(record_json, '$.currentRoundIndex') IS 'integer')
    AND json_type(record_json, '$.bracketFormat') IS 'text'
    AND json_extract(record_json, '$.bracketFormat') IN ('fixed', 'archived-rolling')
    AND json_type(record_json, '$.bracketSize') IS 'integer'
    AND json_extract(record_json, '$.bracketSize') IN (0, 2, 4, 8, 16, 32)
    AND json_type(record_json, '$.roundCount') IS 'integer'
    AND json_extract(record_json, '$.roundCount') BETWEEN 0 AND 5
    AND json_type(record_json, '$.roundByes') IS 'object'
    AND (json_extract(record_json, '$.bracketFormat') IS 'fixed' OR (status IS 'ended' AND json_extract(record_json, '$.bracketSize') IS 0 AND json_extract(record_json, '$.roundCount') BETWEEN 1 AND 5))
    AND (json_type(record_json, '$.isSundayMons') IS 'true' OR json_type(record_json, '$.isSundayMons') IS 'false')
    AND json_type(record_json, '$.telegramAnnouncements') IS 'object'
    AND (json_type(record_json, '$.telegramAnnouncements.invite') IS 'true' OR json_type(record_json, '$.telegramAnnouncements.invite') IS 'false')
    AND (json_type(record_json, '$.telegramAnnouncements.matches') IS 'true' OR json_type(record_json, '$.telegramAnnouncements.matches') IS 'false')
    AND (json_type(record_json, '$.telegramAnnouncements.results') IS 'true' OR json_type(record_json, '$.telegramAnnouncements.results') IS 'false')
    AND json_type(record_json, '$.telegramDeliveryVersion') IS 'integer'
    AND json_extract(record_json, '$.telegramDeliveryVersion') IS 2
    AND (json_type(record_json, '$.supportsThirdPlaceMatch') IS 'true' OR json_type(record_json, '$.supportsThirdPlaceMatch') IS 'false')
    AND (json_type(record_json, '$.thirdPlaceMatch') IS 'null' OR json_type(record_json, '$.thirdPlaceMatch') IS 'object')
    AND (json_type(record_json, '$.prizeSelectionsLockedAtMs') IS 'null' OR json_type(record_json, '$.prizeSelectionsLockedAtMs') IS 'integer')
    AND json_type(record_json, '$.prizeAssignments') IS 'object'
    AND json_type(record_json, '$.participants') IS 'object'
    AND json_type(record_json, '$.rounds') IS 'object'
  )
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_event_records_canonical_status_start ON event_records_canonical(status, start_at_ms, event_id);
CREATE INDEX idx_event_records_canonical_updated ON event_records_canonical(updated_at_ms, event_id);
CREATE INDEX idx_event_records_canonical_scheduled_sunday_start
  ON event_records_canonical(status, start_at_ms, event_id)
  WHERE status = 'scheduled' AND json_type(record_json, '$.isSundayMons') = 'true';

CREATE TABLE event_prize_selections_canonical (
  event_id TEXT NOT NULL,
  profile_id TEXT NOT NULL CHECK (profile_id != '' AND instr(profile_id, '/') = 0),
  prize_id TEXT NOT NULL CHECK (prize_id != '' AND instr(prize_id, '/') = 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(event_id, profile_id),
  FOREIGN KEY(event_id) REFERENCES event_records_canonical(event_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE profile_event_prizes_canonical (
  profile_id TEXT NOT NULL CHECK (profile_id != '' AND instr(profile_id, '/') = 0),
  event_id TEXT NOT NULL,
  assignment_json TEXT NOT NULL CHECK (
    json_valid(assignment_json) AND json_type(assignment_json) IS 'object'
    AND json_type(assignment_json, '$.eventId') IS 'text'
    AND json_extract(assignment_json, '$.eventId') IS event_id
    AND json_type(assignment_json, '$.profileId') IS 'text'
    AND json_extract(assignment_json, '$.profileId') IS profile_id
    AND json_type(assignment_json, '$.place') IS 'integer'
    AND json_extract(assignment_json, '$.place') IN (1, 2, 3)
    AND json_type(assignment_json, '$.prizeId') IS 'text'
    AND json_extract(assignment_json, '$.prizeId') != ''
    AND json_type(assignment_json, '$.assignedAtMs') IS 'integer'
    AND json_extract(assignment_json, '$.assignedAtMs') BETWEEN 0 AND 9007199254740991
  ),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(profile_id, event_id),
  FOREIGN KEY(event_id) REFERENCES event_records_canonical(event_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_profile_event_prizes_canonical_event ON profile_event_prizes_canonical(event_id, profile_id);

CREATE TABLE profile_event_prize_revisions_canonical (
  profile_id TEXT PRIMARY KEY CHECK (profile_id != '' AND instr(profile_id, '/') = 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER event_records_canonical_bump_profile_prize_revisions
BEFORE DELETE ON event_records_canonical
WHEN EXISTS (
  SELECT 1 FROM profile_event_prizes_canonical WHERE event_id = OLD.event_id
)
BEGIN
  INSERT INTO profile_event_prize_revisions_canonical (profile_id, revision, updated_at_ms)
  SELECT DISTINCT profile_id, 1, OLD.updated_at_ms
  FROM profile_event_prizes_canonical
  WHERE event_id = OLD.event_id
  ON CONFLICT (profile_id) DO UPDATE SET
    revision = profile_event_prize_revisions_canonical.revision + 1,
    updated_at_ms = MAX(profile_event_prize_revisions_canonical.updated_at_ms, excluded.updated_at_ms);
END;

CREATE TABLE event_transition_intents_canonical (
  transition_id TEXT PRIMARY KEY CHECK (transition_id != '' AND instr(transition_id, '/') = 0),
  event_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK (status IN ('pending', 'blocked', 'dead')),
  intent_json TEXT NOT NULL CHECK (
    json_valid(intent_json) AND json_type(intent_json) IS 'object'
    AND json_type(intent_json, '$.schemaVersion') IS 'integer'
    AND json_extract(intent_json, '$.schemaVersion') IS 3
    AND json_extract(intent_json, '$.transitionId') IS transition_id
    AND json_extract(intent_json, '$.eventId') IS event_id
    AND json_type(intent_json, '$.expectedRevision') IS 'integer'
    AND json_extract(intent_json, '$.expectedRevision') IS expected_revision
    AND json_type(intent_json, '$.canonicalUpdates') IS 'array'
    AND json_type(intent_json, '$.effects') IS 'array'
    AND json_type(intent_json, '$.inviteMutations') IS 'array'
    AND json_array_length(intent_json, '$.inviteMutations') <= 32
    AND json_type(intent_json, '$.sourceEpoch') IS 'integer'
    AND json_extract(intent_json, '$.sourceEpoch') BETWEEN 1 AND 9007199254740991
    AND json_type(intent_json, '$.payloadDigest') IS 'text'
    AND length(json_extract(intent_json, '$.payloadDigest')) = 64
    AND json_extract(intent_json, '$.payloadDigest') NOT GLOB '*[^0-9a-f]*'
    AND json_type(intent_json, '$.operationDigest') IS 'text'
    AND length(json_extract(intent_json, '$.operationDigest')) = 64
    AND json_extract(intent_json, '$.operationDigest') NOT GLOB '*[^0-9a-f]*'
    AND json_type(intent_json, '$.createdAtMs') IS 'integer'
    AND json_type(intent_json, '$.updatedAtMs') IS 'integer'
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 9007199254740991),
  last_error TEXT,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
  FOREIGN KEY(event_id) REFERENCES event_records_canonical(event_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_event_transition_intents_canonical_pending
  ON event_transition_intents_canonical(status, updated_at_ms, transition_id);

CREATE TRIGGER event_records_canonical_require_pending_intent_insert
BEFORE INSERT ON event_records_canonical
WHEN NEW.pending_transition_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1 FROM event_transition_intents_canonical
  WHERE transition_id = NEW.pending_transition_id AND event_id = NEW.event_id
    AND status IN ('pending', 'blocked', 'dead')
)
BEGIN SELECT RAISE(ABORT, 'event pending transition is unavailable'); END;

CREATE TRIGGER event_records_canonical_require_pending_intent_update
BEFORE UPDATE OF pending_transition_id ON event_records_canonical
WHEN NEW.pending_transition_id IS NOT NULL
AND NOT EXISTS (
  SELECT 1 FROM event_transition_intents_canonical
  WHERE transition_id = NEW.pending_transition_id AND event_id = NEW.event_id
    AND status IN ('pending', 'blocked', 'dead')
)
BEGIN SELECT RAISE(ABORT, 'event pending transition is unavailable'); END;

CREATE TRIGGER event_transition_intents_canonical_reject_live_delete
BEFORE DELETE ON event_transition_intents_canonical
WHEN EXISTS (
  SELECT 1 FROM event_records_canonical
  WHERE event_id = OLD.event_id AND pending_transition_id = OLD.transition_id
)
BEGIN SELECT RAISE(ABORT, 'event transition is still attached'); END;

CREATE TABLE event_progress_outboxes_canonical (
  outbox_id TEXT NOT NULL CHECK (outbox_id != '' AND instr(outbox_id, '/') = 0),
  event_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dead', 'cancelled')),
  run_at_ms INTEGER CHECK (run_at_ms IS NULL OR run_at_ms BETWEEN 0 AND 9007199254740991),
  last_queued_at_ms INTEGER NOT NULL CHECK (last_queued_at_ms BETWEEN 0 AND 9007199254740991),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) IS 'object' AND
    COALESCE(json_type(record_json, '$.dataEpoch') = 'integer' AND json_extract(record_json, '$.dataEpoch') = 1, 0) AND
    COALESCE(json_type(record_json, '$.schemaVersion') = 'integer' AND json_extract(record_json, '$.schemaVersion') = CASE status WHEN 'pending' THEN 2 ELSE 1 END, 0)
  ),
  next_reconcile_at_ms INTEGER NOT NULL DEFAULT 0 CHECK (next_reconcile_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (status <> 'pending' OR (event_id IS NOT NULL AND json_extract(record_json, '$.eventId') IS event_id AND json_extract(record_json, '$.runAtMs') IS run_at_ms AND json_extract(record_json, '$.lastQueuedAtMs') IS last_queued_at_ms)),
  CHECK (status = 'pending' OR (run_at_ms IS NULL AND json_extract(record_json, '$.deadAtMs') IS last_queued_at_ms AND COALESCE(length(json_extract(record_json, '$.sourceDigest')) = 64, 0))),
  PRIMARY KEY(status, outbox_id),
  FOREIGN KEY(event_id) REFERENCES event_records_canonical(event_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TRIGGER event_progress_outboxes_canonical_fields_insert
BEFORE INSERT ON event_progress_outboxes_canonical
BEGIN
  SELECT CASE WHEN NEW.status = 'pending' AND (
    (SELECT count(*) FROM json_each(NEW.record_json)) <> 8 OR
    EXISTS (SELECT 1 FROM json_each(NEW.record_json) WHERE key NOT IN ('schemaVersion','dataEpoch','eventId','sourceKey','reason','runAtMs','firstQueuedAtMs','lastQueuedAtMs')) OR
    NOT COALESCE(json_type(NEW.record_json,'$.eventId') = 'text' AND json_type(NEW.record_json,'$.runAtMs') IN ('integer','null') AND json_type(NEW.record_json,'$.lastQueuedAtMs') = 'integer' AND json_type(NEW.record_json,'$.sourceKey') = 'text' AND length(json_extract(NEW.record_json,'$.sourceKey')) > 0 AND json_type(NEW.record_json,'$.reason') = 'text' AND length(json_extract(NEW.record_json,'$.reason')) > 0 AND json_type(NEW.record_json,'$.firstQueuedAtMs') = 'integer' AND json_extract(NEW.record_json,'$.firstQueuedAtMs') BETWEEN 0 AND NEW.last_queued_at_ms,0)
  ) THEN RAISE(ABORT,'invalid-canonical-event-progress') END;
  SELECT CASE WHEN NEW.status <> 'pending' AND (
    (SELECT count(*) FROM json_each(NEW.record_json)) <> 6 OR
    EXISTS (SELECT 1 FROM json_each(NEW.record_json) WHERE key NOT IN ('schemaVersion','dataEpoch','deadAtMs','sourceDigest','originalRecord','reason')) OR
    NOT COALESCE(json_type(NEW.record_json,'$.deadAtMs') = 'integer' AND json_type(NEW.record_json,'$.sourceDigest') = 'text' AND json_extract(NEW.record_json,'$.sourceDigest') NOT GLOB '*[^0-9a-f]*' AND json_type(NEW.record_json,'$.originalRecord') IN ('object','null') AND json_extract(NEW.record_json,'$.reason') IN ('invalid-event-progress-outbox','canonical-data-cutover'),0)
  ) THEN RAISE(ABORT,'invalid-canonical-event-progress-archive') END;
END;
CREATE TRIGGER event_progress_outboxes_canonical_fields_update
BEFORE UPDATE ON event_progress_outboxes_canonical
BEGIN
  SELECT CASE WHEN NEW.status = 'pending' AND (
    (SELECT count(*) FROM json_each(NEW.record_json)) <> 8 OR
    EXISTS (SELECT 1 FROM json_each(NEW.record_json) WHERE key NOT IN ('schemaVersion','dataEpoch','eventId','sourceKey','reason','runAtMs','firstQueuedAtMs','lastQueuedAtMs')) OR
    NOT COALESCE(json_type(NEW.record_json,'$.eventId') = 'text' AND json_type(NEW.record_json,'$.runAtMs') IN ('integer','null') AND json_type(NEW.record_json,'$.lastQueuedAtMs') = 'integer' AND json_type(NEW.record_json,'$.sourceKey') = 'text' AND length(json_extract(NEW.record_json,'$.sourceKey')) > 0 AND json_type(NEW.record_json,'$.reason') = 'text' AND length(json_extract(NEW.record_json,'$.reason')) > 0 AND json_type(NEW.record_json,'$.firstQueuedAtMs') = 'integer' AND json_extract(NEW.record_json,'$.firstQueuedAtMs') BETWEEN 0 AND NEW.last_queued_at_ms,0)
  ) THEN RAISE(ABORT,'invalid-canonical-event-progress') END;
  SELECT CASE WHEN NEW.status <> 'pending' AND (
    (SELECT count(*) FROM json_each(NEW.record_json)) <> 6 OR
    EXISTS (SELECT 1 FROM json_each(NEW.record_json) WHERE key NOT IN ('schemaVersion','dataEpoch','deadAtMs','sourceDigest','originalRecord','reason')) OR
    NOT COALESCE(json_type(NEW.record_json,'$.deadAtMs') = 'integer' AND json_type(NEW.record_json,'$.sourceDigest') = 'text' AND json_extract(NEW.record_json,'$.sourceDigest') NOT GLOB '*[^0-9a-f]*' AND json_type(NEW.record_json,'$.originalRecord') IN ('object','null') AND json_extract(NEW.record_json,'$.reason') IN ('invalid-event-progress-outbox','canonical-data-cutover'),0)
  ) THEN RAISE(ABORT,'invalid-canonical-event-progress-archive') END;
END;
CREATE INDEX idx_event_progress_outboxes_canonical_due
  ON event_progress_outboxes_canonical(status, last_queued_at_ms, outbox_id);
CREATE INDEX idx_event_progress_outboxes_canonical_event
  ON event_progress_outboxes_canonical(event_id, status, outbox_id);
CREATE INDEX idx_event_progress_outboxes_canonical_reconcile
  ON event_progress_outboxes_canonical(status, next_reconcile_at_ms, last_queued_at_ms, outbox_id);
CREATE TRIGGER event_progress_outboxes_canonical_reset_reconciliation
AFTER UPDATE OF event_id, status, run_at_ms, last_queued_at_ms, record_json
ON event_progress_outboxes_canonical
WHEN OLD.event_id IS NOT NEW.event_id
  OR OLD.status IS NOT NEW.status
  OR OLD.run_at_ms IS NOT NEW.run_at_ms
  OR OLD.last_queued_at_ms IS NOT NEW.last_queued_at_ms
  OR OLD.record_json IS NOT NEW.record_json
BEGIN
  UPDATE event_progress_outboxes_canonical
  SET next_reconcile_at_ms = 0
  WHERE status = NEW.status AND outbox_id = NEW.outbox_id AND next_reconcile_at_ms != 0;
END;

CREATE TABLE event_profile_game_projection_outboxes_canonical (
  event_id TEXT PRIMARY KEY CHECK(event_id != '' AND instr(event_id, '/') = 0),
  request_id TEXT NOT NULL CHECK (request_id != ''),
  status TEXT NOT NULL CHECK (status IN ('pending', 'dead')),
  last_queued_at_ms INTEGER NOT NULL CHECK (last_queued_at_ms BETWEEN 0 AND 9007199254740991),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) IS 'object' AND
    json_type(record_json, '$.schemaVersion') IS 'integer' AND
    json_extract(record_json, '$.schemaVersion') IS CASE status WHEN 'pending' THEN 1 ELSE 2 END AND
    json_extract(record_json, '$.status') IS status AND
    json_type(record_json, '$.requestId') IS 'text' AND json_extract(record_json, '$.requestId') IS request_id AND
    (status != 'dead' OR (json_type(record_json, '$.deadAtMs') IS 'integer' AND json_extract(record_json, '$.deadAtMs') BETWEEN 0 AND 9007199254740991 AND json_extract(record_json, '$.reason') IS 'invalid-record' AND json_type(record_json, '$.sourceDigest') IS 'text' AND length(json_extract(record_json, '$.sourceDigest')) = 64 AND json_extract(record_json, '$.sourceDigest') NOT GLOB '*[^a-f0-9]*' AND (json_type(record_json, '$.originalRecord') IS 'null' OR (json_type(record_json, '$.originalRecord') IS 'object' AND json_extract(record_json, '$.originalRecord.schemaVersion') IS 1 AND json_extract(record_json, '$.originalRecord.status') IS 'pending' AND json_extract(record_json, '$.originalRecord.requestId') IS request_id)))) AND
    ((status = 'pending' AND json_type(record_json, '$.lastQueuedAtMs') IS 'integer' AND json_extract(record_json, '$.lastQueuedAtMs') IS last_queued_at_ms AND (json_type(record_json, '$.cleanupOwnerProfileIds') IS NULL OR json_type(record_json, '$.cleanupOwnerProfileIds') IS 'object') AND (json_type(record_json, '$.reason') IS NULL OR json_type(record_json, '$.reason') IS 'text')) OR (status = 'dead' AND json_extract(record_json, '$.deadAtMs') IS last_queued_at_ms))
  ),
  FOREIGN KEY(event_id) REFERENCES event_records_canonical(event_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TRIGGER event_profile_game_projection_outboxes_canonical_fields_insert BEFORE INSERT ON event_profile_game_projection_outboxes_canonical
BEGIN
  SELECT CASE WHEN NEW.status = 'pending' AND ((SELECT count(*) FROM json_each(NEW.record_json)) NOT BETWEEN 4 AND 6 OR EXISTS (SELECT 1 FROM json_each(NEW.record_json) WHERE key NOT IN ('schemaVersion','status','requestId','lastQueuedAtMs','cleanupOwnerProfileIds','reason'))) THEN RAISE(ABORT, 'invalid-canonical-event-projection') END;
  SELECT CASE WHEN NEW.status = 'dead' AND ((SELECT count(*) FROM json_each(NEW.record_json)) != 7 OR EXISTS (SELECT 1 FROM json_each(NEW.record_json) WHERE key NOT IN ('schemaVersion','status','requestId','reason','deadAtMs','sourceDigest','originalRecord'))) THEN RAISE(ABORT, 'invalid-canonical-event-projection-dead') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.record_json, '$.cleanupOwnerProfileIds') WHERE type != 'true' OR key = '' OR instr(key, '/') > 0) THEN RAISE(ABORT, 'invalid-canonical-event-projection-cleanup') END;
  SELECT CASE WHEN NEW.status = 'dead' AND json_type(NEW.record_json, '$.originalRecord') IS 'object' AND ((SELECT count(*) FROM json_each(NEW.record_json, '$.originalRecord')) NOT BETWEEN 4 AND 6 OR EXISTS (SELECT 1 FROM json_each(NEW.record_json, '$.originalRecord') WHERE key NOT IN ('schemaVersion','status','requestId','lastQueuedAtMs','cleanupOwnerProfileIds','reason')) OR json_type(NEW.record_json, '$.originalRecord.lastQueuedAtMs') IS NOT 'integer' OR json_extract(NEW.record_json, '$.originalRecord.lastQueuedAtMs') NOT BETWEEN 0 AND 9007199254740991 OR (json_type(NEW.record_json, '$.originalRecord.reason') IS NOT NULL AND json_type(NEW.record_json, '$.originalRecord.reason') IS NOT 'text') OR (json_type(NEW.record_json, '$.originalRecord.cleanupOwnerProfileIds') IS NOT NULL AND json_type(NEW.record_json, '$.originalRecord.cleanupOwnerProfileIds') IS NOT 'object') OR EXISTS (SELECT 1 FROM json_each(NEW.record_json, '$.originalRecord.cleanupOwnerProfileIds') WHERE type != 'true' OR key = '' OR instr(key, '/') > 0)) THEN RAISE(ABORT, 'invalid-canonical-event-projection-original') END;
END;
CREATE TRIGGER event_profile_game_projection_outboxes_canonical_fields_update BEFORE UPDATE ON event_profile_game_projection_outboxes_canonical
BEGIN
  SELECT CASE WHEN NEW.status = 'pending' AND ((SELECT count(*) FROM json_each(NEW.record_json)) NOT BETWEEN 4 AND 6 OR EXISTS (SELECT 1 FROM json_each(NEW.record_json) WHERE key NOT IN ('schemaVersion','status','requestId','lastQueuedAtMs','cleanupOwnerProfileIds','reason'))) THEN RAISE(ABORT, 'invalid-canonical-event-projection') END;
  SELECT CASE WHEN NEW.status = 'dead' AND ((SELECT count(*) FROM json_each(NEW.record_json)) != 7 OR EXISTS (SELECT 1 FROM json_each(NEW.record_json) WHERE key NOT IN ('schemaVersion','status','requestId','reason','deadAtMs','sourceDigest','originalRecord'))) THEN RAISE(ABORT, 'invalid-canonical-event-projection-dead') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.record_json, '$.cleanupOwnerProfileIds') WHERE type != 'true' OR key = '' OR instr(key, '/') > 0) THEN RAISE(ABORT, 'invalid-canonical-event-projection-cleanup') END;
  SELECT CASE WHEN NEW.status = 'dead' AND json_type(NEW.record_json, '$.originalRecord') IS 'object' AND ((SELECT count(*) FROM json_each(NEW.record_json, '$.originalRecord')) NOT BETWEEN 4 AND 6 OR EXISTS (SELECT 1 FROM json_each(NEW.record_json, '$.originalRecord') WHERE key NOT IN ('schemaVersion','status','requestId','lastQueuedAtMs','cleanupOwnerProfileIds','reason')) OR json_type(NEW.record_json, '$.originalRecord.lastQueuedAtMs') IS NOT 'integer' OR json_extract(NEW.record_json, '$.originalRecord.lastQueuedAtMs') NOT BETWEEN 0 AND 9007199254740991 OR (json_type(NEW.record_json, '$.originalRecord.reason') IS NOT NULL AND json_type(NEW.record_json, '$.originalRecord.reason') IS NOT 'text') OR (json_type(NEW.record_json, '$.originalRecord.cleanupOwnerProfileIds') IS NOT NULL AND json_type(NEW.record_json, '$.originalRecord.cleanupOwnerProfileIds') IS NOT 'object') OR EXISTS (SELECT 1 FROM json_each(NEW.record_json, '$.originalRecord.cleanupOwnerProfileIds') WHERE type != 'true' OR key = '' OR instr(key, '/') > 0)) THEN RAISE(ABORT, 'invalid-canonical-event-projection-original') END;
END;
CREATE INDEX idx_event_profile_game_projection_outboxes_canonical_due
  ON event_profile_game_projection_outboxes_canonical(status, last_queued_at_ms, event_id);

CREATE TABLE event_telegram_projection_outboxes_canonical (
  event_id TEXT PRIMARY KEY CHECK(event_id != '' AND instr(event_id, '/') = 0),
  request_id TEXT NOT NULL CHECK (request_id != ''),
  status TEXT NOT NULL CHECK (status IN ('pending', 'dead')),
  first_queued_at_ms INTEGER NOT NULL CHECK (first_queued_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN first_queued_at_ms AND 9007199254740991),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json) AND json_type(record_json) IS 'object' AND
    json_type(record_json, '$.schemaVersion') IS 'integer' AND
    json_extract(record_json, '$.schemaVersion') IS CASE status WHEN 'pending' THEN 1 ELSE 2 END AND
    json_extract(record_json, '$.status') IS status AND
    json_type(record_json, '$.requestId') IS 'text' AND json_extract(record_json, '$.requestId') IS request_id AND
    (status != 'dead' OR (json_type(record_json, '$.deadAtMs') IS 'integer' AND json_extract(record_json, '$.deadAtMs') BETWEEN 0 AND 9007199254740991 AND json_extract(record_json, '$.reason') IS 'invalid-record' AND json_type(record_json, '$.sourceDigest') IS 'text' AND length(json_extract(record_json, '$.sourceDigest')) = 64 AND json_extract(record_json, '$.sourceDigest') NOT GLOB '*[^a-f0-9]*' AND (json_type(record_json, '$.originalRecord') IS 'null' OR (json_type(record_json, '$.originalRecord') IS 'object' AND json_extract(record_json, '$.originalRecord.schemaVersion') IS 1 AND json_extract(record_json, '$.originalRecord.status') IS 'pending' AND json_extract(record_json, '$.originalRecord.requestId') IS request_id)))) AND
    ((status = 'pending' AND json_type(record_json, '$.firstQueuedAtMs') IS 'integer' AND json_extract(record_json, '$.firstQueuedAtMs') IS first_queued_at_ms AND json_type(record_json, '$.updatedAtMs') IS 'integer' AND json_extract(record_json, '$.updatedAtMs') IS updated_at_ms) OR (status = 'dead' AND json_extract(record_json, '$.deadAtMs') IS first_queued_at_ms AND json_extract(record_json, '$.deadAtMs') IS updated_at_ms))
  ),
  FOREIGN KEY(event_id) REFERENCES event_records_canonical(event_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE TRIGGER event_telegram_projection_outboxes_canonical_fields_insert BEFORE INSERT ON event_telegram_projection_outboxes_canonical
BEGIN
  SELECT CASE WHEN NEW.status = 'pending' AND ((SELECT count(*) FROM json_each(NEW.record_json)) != 5 OR EXISTS (SELECT 1 FROM json_each(NEW.record_json) WHERE key NOT IN ('schemaVersion','status','requestId','firstQueuedAtMs','updatedAtMs'))) THEN RAISE(ABORT, 'invalid-canonical-event-projection') END;
  SELECT CASE WHEN NEW.status = 'dead' AND ((SELECT count(*) FROM json_each(NEW.record_json)) != 7 OR EXISTS (SELECT 1 FROM json_each(NEW.record_json) WHERE key NOT IN ('schemaVersion','status','requestId','reason','deadAtMs','sourceDigest','originalRecord'))) THEN RAISE(ABORT, 'invalid-canonical-event-projection-dead') END;
  SELECT CASE WHEN NEW.status = 'dead' AND json_type(NEW.record_json, '$.originalRecord') IS 'object' AND ((SELECT count(*) FROM json_each(NEW.record_json, '$.originalRecord')) != 5 OR EXISTS (SELECT 1 FROM json_each(NEW.record_json, '$.originalRecord') WHERE key NOT IN ('schemaVersion','status','requestId','firstQueuedAtMs','updatedAtMs')) OR json_type(NEW.record_json, '$.originalRecord.firstQueuedAtMs') IS NOT 'integer' OR json_type(NEW.record_json, '$.originalRecord.updatedAtMs') IS NOT 'integer' OR json_extract(NEW.record_json, '$.originalRecord.firstQueuedAtMs') NOT BETWEEN 0 AND 9007199254740991 OR json_extract(NEW.record_json, '$.originalRecord.updatedAtMs') NOT BETWEEN json_extract(NEW.record_json, '$.originalRecord.firstQueuedAtMs') AND 9007199254740991) THEN RAISE(ABORT, 'invalid-canonical-event-projection-original') END;
END;
CREATE TRIGGER event_telegram_projection_outboxes_canonical_fields_update BEFORE UPDATE ON event_telegram_projection_outboxes_canonical
BEGIN
  SELECT CASE WHEN NEW.status = 'pending' AND ((SELECT count(*) FROM json_each(NEW.record_json)) != 5 OR EXISTS (SELECT 1 FROM json_each(NEW.record_json) WHERE key NOT IN ('schemaVersion','status','requestId','firstQueuedAtMs','updatedAtMs'))) THEN RAISE(ABORT, 'invalid-canonical-event-projection') END;
  SELECT CASE WHEN NEW.status = 'dead' AND ((SELECT count(*) FROM json_each(NEW.record_json)) != 7 OR EXISTS (SELECT 1 FROM json_each(NEW.record_json) WHERE key NOT IN ('schemaVersion','status','requestId','reason','deadAtMs','sourceDigest','originalRecord'))) THEN RAISE(ABORT, 'invalid-canonical-event-projection-dead') END;
  SELECT CASE WHEN NEW.status = 'dead' AND json_type(NEW.record_json, '$.originalRecord') IS 'object' AND ((SELECT count(*) FROM json_each(NEW.record_json, '$.originalRecord')) != 5 OR EXISTS (SELECT 1 FROM json_each(NEW.record_json, '$.originalRecord') WHERE key NOT IN ('schemaVersion','status','requestId','firstQueuedAtMs','updatedAtMs')) OR json_type(NEW.record_json, '$.originalRecord.firstQueuedAtMs') IS NOT 'integer' OR json_type(NEW.record_json, '$.originalRecord.updatedAtMs') IS NOT 'integer' OR json_extract(NEW.record_json, '$.originalRecord.firstQueuedAtMs') NOT BETWEEN 0 AND 9007199254740991 OR json_extract(NEW.record_json, '$.originalRecord.updatedAtMs') NOT BETWEEN json_extract(NEW.record_json, '$.originalRecord.firstQueuedAtMs') AND 9007199254740991) THEN RAISE(ABORT, 'invalid-canonical-event-projection-original') END;
END;
CREATE INDEX idx_event_telegram_projection_outboxes_canonical_due
  ON event_telegram_projection_outboxes_canonical(status, updated_at_ms, event_id);

CREATE TABLE event_telegram_projection_state_canonical (
  event_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 9007199254740991),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  state_json TEXT NOT NULL CHECK (
    json_valid(state_json) AND json_type(state_json) IS 'object' AND
    json_type(state_json, '$.schemaVersion') IS 'integer' AND json_extract(state_json, '$.schemaVersion') IS 3 AND
    json_type(state_json, '$.upcomingText') IS 'text' AND
    json_type(state_json, '$.reminderText') IS 'text' AND
    json_type(state_json, '$.startedText') IS 'text' AND
    json_type(state_json, '$.endedText') IS 'text' AND
    json_type(state_json, '$.endedAnnouncementArmed') IN ('true', 'false') AND
    json_type(state_json, '$.startedMatchKeys') IS 'array' AND
    json_type(state_json, '$.startedMatchLinesByKey') IS 'object' AND
    json_type(state_json, '$.lastProjectedSignature') IS 'text' AND
    (json_extract(state_json, '$.lastProjectedSignature') IS '' OR (length(json_extract(state_json, '$.lastProjectedSignature')) = 64 AND json_extract(state_json, '$.lastProjectedSignature') NOT GLOB '*[^a-f0-9]*')) AND
    json_type(state_json, '$.updatedAtMs') IS 'integer' AND json_extract(state_json, '$.updatedAtMs') BETWEEN 0 AND 9007199254740991 AND
    (json_type(state_json, '$.eventTelegramProjectionGuard') IS 'null' OR (
      json_type(state_json, '$.eventTelegramProjectionGuard') IS 'object' AND
      json_extract(state_json, '$.eventTelegramProjectionGuard.eventId') IS event_id AND
      json_type(state_json, '$.eventTelegramProjectionGuard.generation') IS 'integer' AND
      json_extract(state_json, '$.eventTelegramProjectionGuard.generation') BETWEEN 0 AND generation AND
      json_type(state_json, '$.eventTelegramProjectionGuard.lockId') IS 'text' AND
      json_extract(state_json, '$.eventTelegramProjectionGuard.lockRoot') IS 'eventTelegramProjectionLocks' AND
      json_type(state_json, '$.eventTelegramProjectionGuard.ownerUid') IS 'text'
    ))
  ),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY(event_id) REFERENCES event_records_canonical(event_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
