CREATE TABLE automatch_entries_canonical (
  record_key TEXT PRIMARY KEY NOT NULL CHECK (record_key != '' AND trim(record_key) = record_key AND instr(record_key, '/') = 0),
  payload_json TEXT CHECK (payload_json IS NULL OR COALESCE(json_valid(payload_json) AND json_type(payload_json) = 'object' AND json_remove(payload_json, '$.schemaVersion', '$.uid', '$.profileId', '$.timestamp', '$.rating', '$.hostColor', '$.password', '$.gameVariant', '$.username', '$.ethAddress', '$.solAddress', '$.emojiId', '$.telegramDeliveryVersion') = '{}' AND
      json_type(payload_json, '$.schemaVersion') = 'integer' AND json_extract(payload_json, '$.schemaVersion') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.uid') = 'text' AND
      json_type(payload_json, '$.profileId') IN ('text', 'null') AND
      json_type(payload_json, '$.timestamp') = 'integer' AND json_extract(payload_json, '$.timestamp') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.rating') IN ('integer', 'real') AND json_extract(payload_json, '$.rating') BETWEEN 0 AND 1.7976931348623157e308 AND
      json_type(payload_json, '$.hostColor') = 'text' AND
      json_type(payload_json, '$.password') = 'text' AND
      json_type(payload_json, '$.gameVariant') = 'text' AND
      json_type(payload_json, '$.username') = 'text' AND
      json_type(payload_json, '$.ethAddress') = 'text' AND
      json_type(payload_json, '$.solAddress') = 'text' AND
      json_type(payload_json, '$.emojiId') = 'integer' AND json_extract(payload_json, '$.emojiId') BETWEEN 0 AND 9007199254740991 AND
      (json_type(payload_json, '$.telegramDeliveryVersion') = 'null' OR (json_type(payload_json, '$.telegramDeliveryVersion') = 'integer' AND json_extract(payload_json, '$.telegramDeliveryVersion') = 2)) AND
      json_extract(payload_json, '$.schemaVersion') = 1 AND json_extract(payload_json, '$.hostColor') IN ('white','black') AND json_extract(payload_json, '$.gameVariant') != '', 0)),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_automatch_entries_uid_canonical ON automatch_entries_canonical (json_extract(payload_json, '$.uid'), record_key) WHERE payload_json IS NOT NULL;
CREATE INDEX idx_automatch_entries_profile_canonical ON automatch_entries_canonical (json_extract(payload_json, '$.profileId'), record_key) WHERE payload_json IS NOT NULL;

CREATE TABLE automatch_telegram_sources_canonical (
  record_key TEXT PRIMARY KEY NOT NULL CHECK (record_key != '' AND trim(record_key) = record_key AND instr(record_key, '/') = 0),
  payload_json TEXT CHECK (payload_json IS NULL OR COALESCE(json_valid(payload_json) AND json_type(payload_json) = 'object' AND json_remove(payload_json, '$.schemaVersion', '$.version', '$.generation', '$.lifecycle', '$.waitingText', '$.canceledText', '$.waitingInstanceKey', '$.matchedText', '$.matchedInstanceKey', '$.createdAtMs', '$.updatedAtMs', '$.results') = '{}' AND
      json_type(payload_json, '$.schemaVersion') = 'integer' AND json_extract(payload_json, '$.schemaVersion') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.version') = 'integer' AND json_extract(payload_json, '$.version') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.generation') = 'integer' AND json_extract(payload_json, '$.generation') BETWEEN 1 AND 9007199254740991 AND
      json_type(payload_json, '$.lifecycle') = 'text' AND
      json_type(payload_json, '$.waitingText') = 'text' AND
      json_type(payload_json, '$.canceledText') = 'text' AND
      json_type(payload_json, '$.waitingInstanceKey') = 'text' AND
      json_type(payload_json, '$.matchedText') IN ('text', 'null') AND
      json_type(payload_json, '$.matchedInstanceKey') IN ('text', 'null') AND
      json_type(payload_json, '$.createdAtMs') = 'integer' AND json_extract(payload_json, '$.createdAtMs') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.updatedAtMs') = 'integer' AND json_extract(payload_json, '$.updatedAtMs') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.results') = 'object' AND
      json_extract(payload_json, '$.schemaVersion') = 1 AND json_extract(payload_json, '$.version') = 2 AND json_extract(payload_json, '$.lifecycle') IN ('pending','matched','canceled') AND json_extract(payload_json, '$.updatedAtMs') >= json_extract(payload_json, '$.createdAtMs'), 0)),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

CREATE TABLE automatch_telegram_projection_outbox_canonical (
  record_key TEXT PRIMARY KEY NOT NULL CHECK (record_key != '' AND trim(record_key) = record_key AND instr(record_key, '/') = 0),
  payload_json TEXT CHECK (payload_json IS NULL OR ((COALESCE(json_valid(payload_json) AND json_type(payload_json) = 'object' AND json_remove(payload_json, '$.schemaVersion', '$.status', '$.requestId', '$.updatedAtMs') = '{}' AND
      json_type(payload_json, '$.schemaVersion') = 'integer' AND json_extract(payload_json, '$.schemaVersion') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.status') = 'text' AND
      json_type(payload_json, '$.requestId') = 'text' AND
      json_type(payload_json, '$.updatedAtMs') = 'integer' AND json_extract(payload_json, '$.updatedAtMs') BETWEEN 0 AND 9007199254740991 AND
      json_extract(payload_json, '$.schemaVersion') = 2 AND json_extract(payload_json, '$.status') = 'pending', 0)) OR (COALESCE(json_valid(payload_json) AND json_type(payload_json) = 'object' AND json_remove(payload_json, '$.schemaVersion', '$.status', '$.requestId', '$.updatedAtMs', '$.deadAtMs', '$.reason') = '{}' AND
      json_type(payload_json, '$.schemaVersion') = 'integer' AND json_extract(payload_json, '$.schemaVersion') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.status') = 'text' AND
      json_type(payload_json, '$.requestId') = 'text' AND
      json_type(payload_json, '$.updatedAtMs') = 'null' AND
      json_type(payload_json, '$.deadAtMs') = 'integer' AND json_extract(payload_json, '$.deadAtMs') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.reason') = 'text' AND
      json_extract(payload_json, '$.schemaVersion') = 2 AND json_extract(payload_json, '$.status') = 'dead', 0)) OR (COALESCE(json_valid(payload_json) AND json_type(payload_json) = 'object' AND json_remove(payload_json, '$.schemaVersion', '$.status', '$.requestId', '$.updatedAtMs', '$.sourceUpdatedAtMs', '$.retirement') = '{}' AND
      json_type(payload_json, '$.schemaVersion') = 'integer' AND json_extract(payload_json, '$.schemaVersion') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.status') = 'text' AND
      json_type(payload_json, '$.requestId') = 'text' AND
      json_type(payload_json, '$.updatedAtMs') = 'null' AND
      json_type(payload_json, '$.sourceUpdatedAtMs') = 'integer' AND json_extract(payload_json, '$.sourceUpdatedAtMs') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.retirement') = 'object' AND
      json_extract(payload_json, '$.schemaVersion') = 2 AND json_extract(payload_json, '$.status') = 'cancelled', 0)))),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

CREATE TABLE game_session_projection_outbox_canonical (
  record_key TEXT PRIMARY KEY NOT NULL CHECK (record_key != '' AND trim(record_key) = record_key AND instr(record_key, '/') = 0),
  payload_json TEXT CHECK (payload_json IS NULL OR ((COALESCE(json_valid(payload_json) AND json_type(payload_json) = 'object' AND json_remove(payload_json, '$.schemaVersion', '$.status', '$.requestId', '$.reason', '$.sourceUpdatedAtMs', '$.lastQueuedAtMs', '$.historicalMatches', '$.archiveRetry') = '{}' AND
      json_type(payload_json, '$.schemaVersion') = 'integer' AND json_extract(payload_json, '$.schemaVersion') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.status') = 'text' AND
      json_type(payload_json, '$.requestId') = 'text' AND
      json_type(payload_json, '$.reason') = 'text' AND
      json_type(payload_json, '$.sourceUpdatedAtMs') = 'integer' AND json_extract(payload_json, '$.sourceUpdatedAtMs') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.lastQueuedAtMs') = 'integer' AND json_extract(payload_json, '$.lastQueuedAtMs') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.historicalMatches') = 'object' AND
      json_type(payload_json, '$.archiveRetry') IN ('object','null') AND
      json_extract(payload_json, '$.schemaVersion') = 2 AND json_extract(payload_json, '$.status') = 'pending', 0)) OR (COALESCE(json_valid(payload_json) AND json_type(payload_json) = 'object' AND json_remove(payload_json, '$.schemaVersion', '$.status', '$.requestId', '$.reason', '$.sourceUpdatedAtMs', '$.lastQueuedAtMs', '$.historicalMatches', '$.archiveRetry', '$.retirement') = '{}' AND
      json_type(payload_json, '$.schemaVersion') = 'integer' AND json_extract(payload_json, '$.schemaVersion') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.status') = 'text' AND
      json_type(payload_json, '$.requestId') = 'text' AND
      json_type(payload_json, '$.reason') = 'text' AND
      json_type(payload_json, '$.sourceUpdatedAtMs') = 'integer' AND json_extract(payload_json, '$.sourceUpdatedAtMs') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.lastQueuedAtMs') = 'integer' AND json_extract(payload_json, '$.lastQueuedAtMs') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.historicalMatches') = 'object' AND
      json_type(payload_json, '$.archiveRetry') IN ('object','null') AND
      json_type(payload_json, '$.retirement') = 'object' AND
      json_extract(payload_json, '$.schemaVersion') = 2 AND json_extract(payload_json, '$.status') = 'cancelled', 0)))),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

CREATE TABLE game_session_mutation_receipts_canonical (
  record_key TEXT PRIMARY KEY NOT NULL CHECK (record_key != '' AND trim(record_key) = record_key AND instr(record_key, '/') = 0),
  payload_json TEXT CHECK (payload_json IS NULL OR ((COALESCE(json_valid(payload_json) AND json_type(payload_json) = 'object' AND json_remove(payload_json, '$.schemaVersion', '$.kind', '$.completedAtMs', '$.inviteId', '$.operationId', '$.requesterUid', '$.response', '$.effects', '$.aura', '$.emojiId', '$.profileProjectionRequestId', '$.telegramProjection') = '{}' AND
      json_type(payload_json, '$.schemaVersion') = 'integer' AND json_extract(payload_json, '$.schemaVersion') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.kind') = 'text' AND
      json_type(payload_json, '$.completedAtMs') = 'integer' AND json_extract(payload_json, '$.completedAtMs') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.inviteId') = 'text' AND
      json_type(payload_json, '$.operationId') = 'text' AND
      json_type(payload_json, '$.requesterUid') = 'text' AND
      json_type(payload_json, '$.response') = 'object' AND
      json_type(payload_json, '$.effects') = 'object' AND
      json_type(payload_json, '$.aura') = 'text' AND
      json_type(payload_json, '$.emojiId') = 'integer' AND json_extract(payload_json, '$.emojiId') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.profileProjectionRequestId') IN ('text', 'null') AND
      json_type(payload_json, '$.telegramProjection') IN ('true','false') AND
      json_extract(payload_json, '$.schemaVersion') = 2 AND json_extract(payload_json, '$.kind') = 'automatch-start', 0)) OR (COALESCE(json_valid(payload_json) AND json_type(payload_json) = 'object' AND json_remove(payload_json, '$.schemaVersion', '$.kind', '$.completedAtMs', '$.inviteId', '$.operationId', '$.requesterUid', '$.response', '$.effects', '$.fingerprint', '$.projectionRequestId') = '{}' AND
      json_type(payload_json, '$.schemaVersion') = 'integer' AND json_extract(payload_json, '$.schemaVersion') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.kind') = 'text' AND
      json_type(payload_json, '$.completedAtMs') = 'integer' AND json_extract(payload_json, '$.completedAtMs') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.inviteId') = 'text' AND
      json_type(payload_json, '$.operationId') = 'text' AND
      json_type(payload_json, '$.requesterUid') = 'text' AND
      json_type(payload_json, '$.response') = 'object' AND
      json_type(payload_json, '$.effects') = 'object' AND
      json_type(payload_json, '$.fingerprint') = 'text' AND
      json_type(payload_json, '$.projectionRequestId') IN ('text', 'null') AND
      json_extract(payload_json, '$.schemaVersion') = 2 AND json_extract(payload_json, '$.kind') IN ('invite-create','invite-join','match-ensure','rematch-end','rematch-propose'), 0)))),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  expiration_json TEXT CHECK (expiration_json IS NULL OR COALESCE(json_valid(expiration_json) AND json_type(expiration_json) = 'object' AND json_remove(expiration_json, '$.schemaVersion', '$.completedAtMs') = '{}' AND json_extract(expiration_json, '$.schemaVersion') = 1 AND json_type(expiration_json, '$.completedAtMs') = 'integer' AND json_extract(expiration_json, '$.completedAtMs') BETWEEN 0 AND 9007199254740991, 0)),
  expiration_revision INTEGER NOT NULL DEFAULT 0 CHECK (expiration_revision BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (revision > 0 OR expiration_revision > 0)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_game_session_receipt_completed_canonical ON game_session_mutation_receipts_canonical (json_extract(payload_json, '$.completedAtMs'), record_key) WHERE payload_json IS NOT NULL;
CREATE INDEX idx_game_session_receipt_expiration_canonical ON game_session_mutation_receipts_canonical (json_extract(expiration_json, '$.completedAtMs'), record_key) WHERE expiration_json IS NOT NULL;

CREATE TABLE game_session_transitions_canonical (
  transition_id TEXT PRIMARY KEY NOT NULL CHECK (transition_id != '' AND trim(transition_id) = transition_id),
  invite_id TEXT NOT NULL CHECK (invite_id != '' AND trim(invite_id) = invite_id),
  payload_json TEXT NOT NULL CHECK (COALESCE(json_valid(payload_json) AND json_type(payload_json) = 'object' AND json_remove(payload_json, '$.version', '$.inviteId', '$.inviteSourceEpoch', '$.inviteMutations', '$.transitionId', '$.operationDigest', '$.resources', '$.mutations', '$.creations', '$.createdAtMs') = '{}' AND
      json_type(payload_json, '$.version') = 'integer' AND json_extract(payload_json, '$.version') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.inviteId') = 'text' AND
      json_type(payload_json, '$.inviteSourceEpoch') = 'integer' AND json_extract(payload_json, '$.inviteSourceEpoch') BETWEEN 1 AND 9007199254740991 AND
      json_type(payload_json, '$.inviteMutations') = 'array' AND
      json_type(payload_json, '$.transitionId') = 'text' AND
      json_type(payload_json, '$.operationDigest') = 'text' AND
      json_type(payload_json, '$.resources') = 'array' AND
      json_type(payload_json, '$.mutations') = 'array' AND
      json_type(payload_json, '$.creations') = 'array' AND
      json_type(payload_json, '$.createdAtMs') = 'integer' AND json_extract(payload_json, '$.createdAtMs') BETWEEN 0 AND 9007199254740991 AND
      json_extract(payload_json, '$.version') = 3 AND json_extract(payload_json, '$.transitionId') = transition_id AND json_extract(payload_json, '$.inviteId') = invite_id, 0)),
  status TEXT NOT NULL CHECK (status IN ('pending','completed','cancelled','blocked')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991 AND updated_at_ms >= created_at_ms),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 9007199254740991),
  last_error TEXT,
  retirement_json TEXT CHECK (retirement_json IS NULL OR COALESCE(json_valid(retirement_json) AND json_type(retirement_json) = 'object' AND json_remove(retirement_json, '$.state', '$.retiredAtMs', '$.sourceDigest') = '{}' AND json_extract(retirement_json, '$.state') = 'retired' AND json_type(retirement_json, '$.retiredAtMs') = 'integer' AND json_extract(retirement_json, '$.retiredAtMs') BETWEEN 0 AND 9007199254740991 AND json_type(retirement_json, '$.sourceDigest') = 'text' AND length(json_extract(retirement_json, '$.sourceDigest')) = 64, 0)),
  CHECK ((status IN ('pending','completed') AND retirement_json IS NULL) OR (status IN ('cancelled','blocked') AND retirement_json IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_game_session_transitions_pending_canonical ON game_session_transitions_canonical (status, updated_at_ms, transition_id);
CREATE TABLE game_session_transition_resources_canonical (
  resource_key TEXT PRIMARY KEY NOT NULL CHECK (resource_key != '' AND trim(resource_key) = resource_key),
  transition_id TEXT NOT NULL REFERENCES game_session_transitions_canonical(transition_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_game_session_transition_resources_intent_canonical ON game_session_transition_resources_canonical (transition_id);

CREATE TABLE automatch_live_tickets_canonical (
  invite_id TEXT PRIMARY KEY NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision BETWEEN 1 AND 9007199254740991),
  uid TEXT NOT NULL CHECK (uid != '' AND trim(uid) = uid),
  profile_id_hint TEXT,
  enqueued_at_ms INTEGER NOT NULL CHECK (enqueued_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_automatch_live_tickets_fifo_canonical
ON automatch_live_tickets_canonical (enqueued_at_ms, invite_id);

CREATE INDEX idx_automatch_live_tickets_uid_canonical
ON automatch_live_tickets_canonical (uid, enqueued_at_ms, invite_id);

CREATE TABLE automatch_pending_enqueues_canonical (
  transition_id TEXT PRIMARY KEY NOT NULL REFERENCES game_session_transitions_canonical(transition_id) ON DELETE CASCADE,
  invite_id TEXT NOT NULL,
  uid TEXT NOT NULL CHECK (uid != '' AND trim(uid) = uid),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  enqueued_at_ms INTEGER NOT NULL CHECK (enqueued_at_ms BETWEEN 0 AND 9007199254740991),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cancelled','blocked')),
  retirement_json TEXT CHECK (retirement_json IS NULL OR COALESCE(json_valid(retirement_json) AND json_type(retirement_json) = 'object' AND json_remove(retirement_json, '$.state', '$.retiredAtMs', '$.sourceDigest') = '{}' AND json_extract(retirement_json, '$.state') = 'retired' AND json_type(retirement_json, '$.retiredAtMs') = 'integer' AND json_extract(retirement_json, '$.retiredAtMs') BETWEEN 0 AND 9007199254740991 AND length(json_extract(retirement_json, '$.sourceDigest')) = 64, 0)),
  CHECK ((status = 'pending' AND retirement_json IS NULL) OR (status IN ('cancelled','blocked') AND retirement_json IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_automatch_pending_enqueues_order_canonical
ON automatch_pending_enqueues_canonical (status, created_at_ms, transition_id);

CREATE VIEW automatch_expected_live_tickets_canonical AS
SELECT record_key AS invite_id, revision AS source_revision,
  CASE WHEN json_type(payload_json, '$.uid') = 'text'
    THEN json_extract(payload_json, '$.uid') END AS uid,
  CASE WHEN json_type(payload_json, '$.profileId') = 'text'
    THEN json_extract(payload_json, '$.profileId') END AS profile_id_hint,
  CASE WHEN json_type(payload_json, '$.timestamp') IN ('integer', 'real')
    AND json_extract(payload_json, '$.timestamp') BETWEEN 0 AND 9007199254740991
    AND CAST(json_extract(payload_json, '$.timestamp') AS INTEGER) = json_extract(payload_json, '$.timestamp')
    THEN CAST(json_extract(payload_json, '$.timestamp') AS INTEGER) END AS enqueued_at_ms
FROM automatch_entries_canonical WHERE payload_json IS NOT NULL;

CREATE VIEW automatch_expected_pending_enqueues_canonical AS
SELECT transition.transition_id, transition.invite_id,
  CASE WHEN json_type(mutation.value, '$.value.uid') = 'text'
    THEN json_extract(mutation.value, '$.value.uid') END AS uid,
  transition.created_at_ms,
  CASE WHEN json_type(mutation.value, '$.value.timestamp') IN ('integer', 'real')
    AND json_extract(mutation.value, '$.value.timestamp') BETWEEN 0 AND 9007199254740991
    AND CAST(json_extract(mutation.value, '$.value.timestamp') AS INTEGER) = json_extract(mutation.value, '$.value.timestamp')
    THEN CAST(json_extract(mutation.value, '$.value.timestamp') AS INTEGER) END AS enqueued_at_ms,
  'pending' AS status, NULL AS retirement_json
FROM game_session_transitions_canonical AS transition, json_each(transition.payload_json, '$.mutations') AS mutation
WHERE transition.status = 'pending'
  AND json_extract(mutation.value, '$.current.root') = 'automatch'
  AND json_type(mutation.value, '$.current.value') = 'null'
  AND json_type(mutation.value, '$.value') IS NOT NULL
  AND json_type(mutation.value, '$.value') != 'null';

CREATE VIEW automatch_ready_tickets_canonical AS
SELECT ticket.* FROM automatch_live_tickets_canonical AS ticket INDEXED BY idx_automatch_live_tickets_fifo_canonical
WHERE NOT EXISTS (
  SELECT 1 FROM game_session_transition_resources_canonical AS resource
  JOIN game_session_transitions_canonical AS reservation ON reservation.transition_id = resource.transition_id
  WHERE resource.resource_key = ticket.invite_id
    AND (reservation.status IN ('blocked','cancelled') OR (reservation.status = 'pending'
    AND EXISTS (
      SELECT 1 FROM json_each(reservation.payload_json, '$.mutations') AS mutation
      WHERE json_extract(mutation.value, '$.current.root') = 'automatch'
        AND json_extract(mutation.value, '$.current.key') = ticket.invite_id
        AND json_type(mutation.value, '$.value') = 'null'
    )))
);

CREATE TRIGGER automatch_live_tickets_insert_canonical
AFTER INSERT ON automatch_entries_canonical
BEGIN
  INSERT INTO automatch_live_tickets_canonical
  SELECT * FROM automatch_expected_live_tickets_canonical WHERE invite_id = NEW.record_key;
END;

CREATE TRIGGER automatch_live_tickets_update_canonical
AFTER UPDATE ON automatch_entries_canonical
BEGIN
  DELETE FROM automatch_live_tickets_canonical WHERE invite_id = OLD.record_key;
  INSERT INTO automatch_live_tickets_canonical
  SELECT * FROM automatch_expected_live_tickets_canonical WHERE invite_id = NEW.record_key;
END;

CREATE TRIGGER automatch_live_tickets_delete_canonical
AFTER DELETE ON automatch_entries_canonical
BEGIN
  DELETE FROM automatch_live_tickets_canonical WHERE invite_id = OLD.record_key;
END;

CREATE TRIGGER automatch_pending_enqueues_insert_canonical
AFTER INSERT ON game_session_transitions_canonical
BEGIN
  INSERT INTO automatch_pending_enqueues_canonical
  SELECT * FROM automatch_expected_pending_enqueues_canonical WHERE transition_id = NEW.transition_id;
END;

CREATE TRIGGER automatch_pending_enqueues_update_canonical
AFTER UPDATE OF status, payload_json ON game_session_transitions_canonical
BEGIN
  DELETE FROM automatch_pending_enqueues_canonical WHERE transition_id = OLD.transition_id;
  INSERT INTO automatch_pending_enqueues_canonical
  SELECT * FROM automatch_expected_pending_enqueues_canonical WHERE transition_id = NEW.transition_id;
END;

CREATE TRIGGER automatch_fifo_enqueue_guard_canonical
BEFORE INSERT ON game_session_transitions_canonical
WHEN NEW.status = 'pending'
  AND EXISTS (
    SELECT 1 FROM json_each(NEW.payload_json, '$.mutations') AS receipt
    WHERE json_extract(receipt.value, '$.current.root') = 'gameplayMutationReceipts'
      AND json_extract(receipt.value, '$.value.kind') = 'automatch-start'
      AND json_extract(receipt.value, '$.value.response.mode') = 'pending'
  )
  AND EXISTS (
    SELECT 1 FROM json_each(NEW.payload_json, '$.mutations') AS mutation
    WHERE json_extract(mutation.value, '$.current.root') = 'automatch'
      AND json_type(mutation.value, '$.current.value') = 'null'
      AND json_type(mutation.value, '$.value') IS NOT NULL
      AND json_type(mutation.value, '$.value') != 'null'
  )
BEGIN
  SELECT RAISE(ABORT, 'automatch-selection-stale')
  WHERE EXISTS (SELECT 1 FROM automatch_ready_tickets_canonical)
    OR EXISTS (SELECT 1 FROM automatch_pending_enqueues_canonical WHERE status = 'pending');
END;

CREATE TRIGGER automatch_fifo_claim_guard_canonical
BEFORE INSERT ON game_session_transitions_canonical
WHEN NEW.status = 'pending'
  AND EXISTS (
    SELECT 1 FROM json_each(NEW.payload_json, '$.mutations') AS receipt
    WHERE json_extract(receipt.value, '$.current.root') = 'gameplayMutationReceipts'
      AND json_extract(receipt.value, '$.value.kind') = 'automatch-start'
      AND json_extract(receipt.value, '$.value.response.mode') = 'matched'
  )
  AND EXISTS (
    SELECT 1 FROM json_each(NEW.payload_json, '$.mutations') AS mutation
    WHERE json_extract(mutation.value, '$.current.root') = 'automatch'
      AND json_type(mutation.value, '$.current.value') != 'null'
      AND json_type(mutation.value, '$.value') = 'null'
  )
BEGIN
  SELECT RAISE(ABORT, 'automatch-selection-stale')
  WHERE NEW.invite_id IS NOT (
    SELECT invite_id FROM automatch_ready_tickets_canonical
    ORDER BY enqueued_at_ms, invite_id LIMIT 1
  );
END;


ALTER TABLE automatch_telegram_projection_outbox_canonical
ADD COLUMN recovery_sort_rank INTEGER GENERATED ALWAYS AS (
  CASE json_type(payload_json, '$.updatedAtMs')
    WHEN 'false' THEN 1 WHEN 'true' THEN 2
    WHEN 'integer' THEN 3 WHEN 'real' THEN 3 WHEN 'text' THEN 4
    WHEN 'array' THEN 5 WHEN 'object' THEN 5 ELSE 0
  END
) VIRTUAL;

ALTER TABLE automatch_telegram_projection_outbox_canonical
ADD COLUMN recovery_sort_value INTEGER GENERATED ALWAYS AS (
  CASE WHEN recovery_sort_rank IN (3, 4)
    THEN json_extract(payload_json, '$.updatedAtMs') END
) VIRTUAL;

ALTER TABLE automatch_telegram_projection_outbox_canonical
ADD COLUMN recovery_key_integer INTEGER GENERATED ALWAYS AS (
  CASE WHEN length((CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END)) BETWEEN 1 AND 10
    AND (CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END) NOT GLOB '*[^0-9]*'
    AND CAST(record_key AS INTEGER) BETWEEN -2147483648 AND 2147483647
    THEN CAST(record_key AS INTEGER) END
) VIRTUAL;

ALTER TABLE automatch_telegram_projection_outbox_canonical
ADD COLUMN recovery_key_rank INTEGER GENERATED ALWAYS AS (
  CASE WHEN recovery_key_integer IS NULL THEN 1 ELSE 0 END
) VIRTUAL;

ALTER TABLE automatch_telegram_projection_outbox_canonical
ADD COLUMN recovery_key_length INTEGER GENERATED ALWAYS AS (
  CASE WHEN recovery_key_integer IS NOT NULL THEN length(record_key) ELSE 0 END
) VIRTUAL;

CREATE INDEX idx_automatch_telegram_projection_recovery_canonical
ON automatch_telegram_projection_outbox_canonical (
  recovery_sort_rank, recovery_sort_value,
  recovery_key_rank, recovery_key_integer, recovery_key_length,
  record_key COLLATE BINARY
)
WHERE payload_json IS NOT NULL;

ALTER TABLE game_session_projection_outbox_canonical
ADD COLUMN recovery_sort_rank INTEGER GENERATED ALWAYS AS (
  CASE json_type(payload_json, '$.lastQueuedAtMs')
    WHEN 'false' THEN 1 WHEN 'true' THEN 2
    WHEN 'integer' THEN 3 WHEN 'real' THEN 3 WHEN 'text' THEN 4
    WHEN 'array' THEN 5 WHEN 'object' THEN 5 ELSE 0
  END
) VIRTUAL;

ALTER TABLE game_session_projection_outbox_canonical
ADD COLUMN recovery_sort_value INTEGER GENERATED ALWAYS AS (
  CASE WHEN recovery_sort_rank IN (3, 4)
    THEN json_extract(payload_json, '$.lastQueuedAtMs') END
) VIRTUAL;

ALTER TABLE game_session_projection_outbox_canonical
ADD COLUMN recovery_key_integer INTEGER GENERATED ALWAYS AS (
  CASE WHEN length((CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END)) BETWEEN 1 AND 10
    AND (CASE WHEN substr(record_key, 1, 1) = '-' THEN substr(record_key, 2) ELSE record_key END) NOT GLOB '*[^0-9]*'
    AND CAST(record_key AS INTEGER) BETWEEN -2147483648 AND 2147483647
    THEN CAST(record_key AS INTEGER) END
) VIRTUAL;

ALTER TABLE game_session_projection_outbox_canonical
ADD COLUMN recovery_key_rank INTEGER GENERATED ALWAYS AS (
  CASE WHEN recovery_key_integer IS NULL THEN 1 ELSE 0 END
) VIRTUAL;

ALTER TABLE game_session_projection_outbox_canonical
ADD COLUMN recovery_key_length INTEGER GENERATED ALWAYS AS (
  CASE WHEN recovery_key_integer IS NOT NULL THEN length(record_key) ELSE 0 END
) VIRTUAL;

CREATE INDEX idx_game_session_projection_recovery_canonical
ON game_session_projection_outbox_canonical (
  recovery_sort_rank, recovery_sort_value,
  recovery_key_rank, recovery_key_integer, recovery_key_length,
  record_key COLLATE BINARY
)
WHERE payload_json IS NOT NULL;

CREATE TRIGGER login_match_discovery_completion_guard_canonical
BEFORE UPDATE OF status ON game_session_transitions_canonical
WHEN NEW.status = 'completed'
  AND OLD.status != 'completed'
  AND (SELECT capture_enforced FROM login_match_discovery_control WHERE singleton = 1) = 1
  AND EXISTS (
    SELECT 1
    FROM (
      SELECT json_extract(value, '$.path') AS path
      FROM json_each(NEW.payload_json, '$.creations')
    ) AS creation
    WHERE NOT EXISTS (
      SELECT 1 FROM login_match_discovery_canonical AS discovery
      WHERE discovery.login_uid = substr(creation.path, 9, instr(substr(creation.path, 9), '/') - 1)
        AND discovery.match_id = substr(creation.path, instr(substr(creation.path, 9), '/') + 17)
        AND discovery.invite_id = NEW.invite_id
        AND discovery.resolution = 'resolved'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'login-match-discovery-capture-required');
END;

CREATE TRIGGER match_presentation_manual_completion_guard_canonical
BEFORE UPDATE OF status ON game_session_transitions_canonical
WHEN NEW.status = 'completed' AND OLD.status != 'completed'
  AND COALESCE((SELECT phase FROM match_presentation_control WHERE singleton = 1), 'capture') != 'legacy'
  AND EXISTS (
    SELECT 1 FROM json_each(NEW.payload_json, '$.creations') AS creation
    WHERE NOT EXISTS (
      SELECT 1 FROM match_presentation_registrations_canonical AS registration
      WHERE registration.invite_id = NEW.invite_id
        AND 'players/' || registration.actor_uid || '/matches/' || registration.match_id = json_extract(creation.value, '$.path')
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'match-presentation-capture-required');
END;


CREATE TABLE profile_game_projections_canonical (
  profile_id TEXT NOT NULL CHECK (profile_id != '' AND trim(profile_id) = profile_id),
  projection_id TEXT NOT NULL CHECK (projection_id != '' AND trim(projection_id) = projection_id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('game','event')),
  status TEXT NOT NULL CHECK (status IN ('pending','waiting','active','ended','dismissed')),
  sort_bucket INTEGER NOT NULL CHECK (sort_bucket = CASE status WHEN 'pending' THEN 20 WHEN 'waiting' THEN 30 WHEN 'active' THEN 40 ELSE 50 END),
  list_sort_at_ms INTEGER NOT NULL CHECK (list_sort_at_ms BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 1 AND 9007199254740991),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
  payload_json TEXT NOT NULL CHECK ((COALESCE(json_valid(payload_json) AND json_type(payload_json) = 'object' AND json_remove(payload_json, '$.schemaVersion', '$.projectorVersion', '$.source', '$.entityType', '$.inviteId', '$.kind', '$.hostLoginId', '$.guestLoginId', '$.hostProfileId', '$.guestProfileId', '$.status', '$.sortBucket', '$.isPendingAutomatch', '$.automatchStateHint', '$.automatchCanceledAt', '$.latestMatchId', '$.ownerProfileId', '$.ownerRole', '$.ownerLoginId', '$.opponentProfileId', '$.opponentLoginId', '$.opponentName', '$.opponentEmoji', '$.listSortAt', '$.createdAt', '$.updatedAt', '$.endedAt', '$.lastEventFingerprint', '$.lastEventType', '$.lastEventReason', '$.lastEventAt') = '{}' AND
      json_type(payload_json, '$.schemaVersion') = 'integer' AND json_extract(payload_json, '$.schemaVersion') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.projectorVersion') = 'integer' AND json_extract(payload_json, '$.projectorVersion') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.source') = 'text' AND
      json_type(payload_json, '$.entityType') = 'text' AND
      json_type(payload_json, '$.inviteId') = 'text' AND
      json_type(payload_json, '$.kind') = 'text' AND
      json_type(payload_json, '$.hostLoginId') IN ('text', 'null') AND
      json_type(payload_json, '$.guestLoginId') IN ('text', 'null') AND
      json_type(payload_json, '$.hostProfileId') IN ('text', 'null') AND
      json_type(payload_json, '$.guestProfileId') IN ('text', 'null') AND
      json_type(payload_json, '$.status') = 'text' AND
      json_type(payload_json, '$.sortBucket') = 'integer' AND json_extract(payload_json, '$.sortBucket') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.isPendingAutomatch') IN ('true','false') AND
      json_type(payload_json, '$.automatchStateHint') IN ('text', 'null') AND
      (json_type(payload_json, '$.automatchCanceledAt') = 'null' OR (json_type(payload_json, '$.automatchCanceledAt') = 'integer' AND json_extract(payload_json, '$.automatchCanceledAt') BETWEEN 0 AND 9007199254740991)) AND
      json_type(payload_json, '$.latestMatchId') = 'text' AND
      json_type(payload_json, '$.ownerProfileId') = 'text' AND
      json_type(payload_json, '$.ownerRole') = 'text' AND
      json_type(payload_json, '$.ownerLoginId') IN ('text', 'null') AND
      json_type(payload_json, '$.opponentProfileId') IN ('text', 'null') AND
      json_type(payload_json, '$.opponentLoginId') IN ('text', 'null') AND
      json_type(payload_json, '$.opponentName') IN ('text', 'null') AND
      (json_type(payload_json, '$.opponentEmoji') = 'null' OR (json_type(payload_json, '$.opponentEmoji') = 'integer' AND json_extract(payload_json, '$.opponentEmoji') BETWEEN 0 AND 9007199254740991)) AND
      json_type(payload_json, '$.listSortAt') = 'integer' AND json_extract(payload_json, '$.listSortAt') BETWEEN 1 AND 9007199254740991 AND
      json_type(payload_json, '$.createdAt') = 'integer' AND json_extract(payload_json, '$.createdAt') BETWEEN 1 AND 9007199254740991 AND
      json_type(payload_json, '$.updatedAt') = 'integer' AND json_extract(payload_json, '$.updatedAt') BETWEEN 1 AND 9007199254740991 AND
      (json_type(payload_json, '$.endedAt') = 'null' OR (json_type(payload_json, '$.endedAt') = 'integer' AND json_extract(payload_json, '$.endedAt') BETWEEN 0 AND 9007199254740991)) AND
      json_type(payload_json, '$.lastEventFingerprint') = 'text' AND
      json_type(payload_json, '$.lastEventType') IN ('text', 'null') AND
      json_type(payload_json, '$.lastEventReason') IN ('text', 'null') AND
      json_type(payload_json, '$.lastEventAt') = 'integer' AND json_extract(payload_json, '$.lastEventAt') BETWEEN 1 AND 9007199254740991 AND
      json_extract(payload_json, '$.schemaVersion') = 3 AND json_extract(payload_json, '$.projectorVersion') = 3 AND json_extract(payload_json, '$.source') = 'game-projector' AND json_extract(payload_json, '$.entityType') = 'game' AND json_extract(payload_json, '$.kind') IN ('auto','direct') AND json_extract(payload_json, '$.ownerRole') IN ('host','guest') AND json_extract(payload_json, '$.inviteId') = projection_id, 0)) OR (COALESCE(json_valid(payload_json) AND json_type(payload_json) = 'object' AND json_remove(payload_json, '$.schemaVersion', '$.source', '$.entityType', '$.id', '$.eventId', '$.status', '$.sortBucket', '$.listSortAt', '$.ownerProfileId', '$.startAt', '$.updatedAt', '$.endedAt', '$.participantCount', '$.participantPreview', '$.winnerDisplayName') = '{}' AND
      json_type(payload_json, '$.schemaVersion') = 'integer' AND json_extract(payload_json, '$.schemaVersion') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.source') = 'text' AND
      json_type(payload_json, '$.entityType') = 'text' AND
      json_type(payload_json, '$.id') = 'text' AND
      json_type(payload_json, '$.eventId') = 'text' AND
      json_type(payload_json, '$.status') = 'text' AND
      json_type(payload_json, '$.sortBucket') = 'integer' AND json_extract(payload_json, '$.sortBucket') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.listSortAt') = 'integer' AND json_extract(payload_json, '$.listSortAt') BETWEEN 1 AND 9007199254740991 AND
      json_type(payload_json, '$.ownerProfileId') = 'text' AND
      (json_type(payload_json, '$.startAt') = 'null' OR (json_type(payload_json, '$.startAt') = 'integer' AND json_extract(payload_json, '$.startAt') BETWEEN 0 AND 9007199254740991)) AND
      json_type(payload_json, '$.updatedAt') = 'integer' AND json_extract(payload_json, '$.updatedAt') BETWEEN 1 AND 9007199254740991 AND
      (json_type(payload_json, '$.endedAt') = 'null' OR (json_type(payload_json, '$.endedAt') = 'integer' AND json_extract(payload_json, '$.endedAt') BETWEEN 0 AND 9007199254740991)) AND
      json_type(payload_json, '$.participantCount') = 'integer' AND json_extract(payload_json, '$.participantCount') BETWEEN 0 AND 9007199254740991 AND
      json_type(payload_json, '$.participantPreview') = 'array' AND
      json_type(payload_json, '$.winnerDisplayName') IN ('text', 'null') AND
      json_extract(payload_json, '$.schemaVersion') = 2 AND json_extract(payload_json, '$.source') = 'event-projector' AND json_extract(payload_json, '$.entityType') = 'event' AND json_extract(payload_json, '$.id') = projection_id AND json_extract(payload_json, '$.id') = 'event_' || json_extract(payload_json, '$.eventId') AND json_array_length(payload_json, '$.participantPreview') <= 6, 0))),
  PRIMARY KEY (profile_id, projection_id),
  CHECK (json_extract(payload_json, '$.ownerProfileId') = profile_id AND json_extract(payload_json, '$.entityType') = entity_type AND json_extract(payload_json, '$.status') = status AND json_extract(payload_json, '$.sortBucket') = sort_bucket AND json_extract(payload_json, '$.listSortAt') = list_sort_at_ms AND json_extract(payload_json, '$.updatedAt') = updated_at_ms)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_profile_game_projections_page_canonical ON profile_game_projections_canonical (profile_id, sort_bucket ASC, list_sort_at_ms DESC, projection_id ASC);
