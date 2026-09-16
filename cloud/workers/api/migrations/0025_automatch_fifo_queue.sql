CREATE TABLE automatch_live_tickets (
  invite_id TEXT PRIMARY KEY NOT NULL,
  source_revision INTEGER NOT NULL,
  uid TEXT,
  profile_id_hint TEXT,
  enqueued_at_ms INTEGER
) WITHOUT ROWID;

CREATE INDEX idx_automatch_live_tickets_fifo
ON automatch_live_tickets (enqueued_at_ms, invite_id);

CREATE INDEX idx_automatch_live_tickets_uid
ON automatch_live_tickets (uid, enqueued_at_ms, invite_id);

CREATE TABLE automatch_pending_enqueues (
  transition_id TEXT PRIMARY KEY NOT NULL REFERENCES game_session_transitions(transition_id) ON DELETE CASCADE,
  invite_id TEXT NOT NULL,
  uid TEXT,
  created_at_ms INTEGER NOT NULL,
  enqueued_at_ms INTEGER
) WITHOUT ROWID;

CREATE INDEX idx_automatch_pending_enqueues_order
ON automatch_pending_enqueues (created_at_ms, transition_id);

CREATE VIEW automatch_expected_live_tickets AS
SELECT record_key AS invite_id, revision AS source_revision,
  CASE WHEN json_type(payload_json, '$.uid') = 'text'
    THEN json_extract(payload_json, '$.uid') END AS uid,
  CASE WHEN json_type(payload_json, '$.profileId') = 'text'
    THEN json_extract(payload_json, '$.profileId') END AS profile_id_hint,
  CASE WHEN json_type(payload_json, '$.timestamp') IN ('integer', 'real')
    AND json_extract(payload_json, '$.timestamp') BETWEEN 0 AND 9007199254740991
    AND CAST(json_extract(payload_json, '$.timestamp') AS INTEGER) = json_extract(payload_json, '$.timestamp')
    THEN CAST(json_extract(payload_json, '$.timestamp') AS INTEGER) END AS enqueued_at_ms
FROM automatch_entries WHERE payload_json IS NOT NULL;

CREATE VIEW automatch_expected_pending_enqueues AS
SELECT transition.transition_id, transition.invite_id,
  CASE WHEN json_type(mutation.value, '$.value.uid') = 'text'
    THEN json_extract(mutation.value, '$.value.uid') END AS uid,
  transition.created_at_ms,
  CASE WHEN json_type(mutation.value, '$.value.timestamp') IN ('integer', 'real')
    AND json_extract(mutation.value, '$.value.timestamp') BETWEEN 0 AND 9007199254740991
    AND CAST(json_extract(mutation.value, '$.value.timestamp') AS INTEGER) = json_extract(mutation.value, '$.value.timestamp')
    THEN CAST(json_extract(mutation.value, '$.value.timestamp') AS INTEGER) END AS enqueued_at_ms
FROM game_session_transitions AS transition, json_each(transition.payload_json, '$.mutations') AS mutation
WHERE transition.status = 'pending'
  AND json_extract(mutation.value, '$.current.root') = 'automatch'
  AND json_type(mutation.value, '$.current.value') = 'null'
  AND json_type(mutation.value, '$.value') IS NOT NULL
  AND json_type(mutation.value, '$.value') != 'null';

CREATE VIEW automatch_ready_tickets AS
SELECT ticket.* FROM automatch_live_tickets AS ticket INDEXED BY idx_automatch_live_tickets_fifo
WHERE NOT EXISTS (
  SELECT 1 FROM game_session_transition_resources AS resource
  JOIN game_session_transitions AS reservation ON reservation.transition_id = resource.transition_id
  WHERE resource.resource_key = ticket.invite_id
    AND reservation.status = 'pending'
    AND EXISTS (
      SELECT 1 FROM json_each(reservation.payload_json, '$.mutations') AS mutation
      WHERE json_extract(mutation.value, '$.current.root') = 'automatch'
        AND json_extract(mutation.value, '$.current.key') = ticket.invite_id
        AND json_type(mutation.value, '$.value') = 'null'
    )
);

CREATE TRIGGER automatch_live_tickets_insert
AFTER INSERT ON automatch_entries
BEGIN
  INSERT INTO automatch_live_tickets
  SELECT * FROM automatch_expected_live_tickets WHERE invite_id = NEW.record_key;
END;

CREATE TRIGGER automatch_live_tickets_update
AFTER UPDATE ON automatch_entries
BEGIN
  DELETE FROM automatch_live_tickets WHERE invite_id = OLD.record_key;
  INSERT INTO automatch_live_tickets
  SELECT * FROM automatch_expected_live_tickets WHERE invite_id = NEW.record_key;
END;

CREATE TRIGGER automatch_live_tickets_delete
AFTER DELETE ON automatch_entries
BEGIN
  DELETE FROM automatch_live_tickets WHERE invite_id = OLD.record_key;
END;

CREATE TRIGGER automatch_pending_enqueues_insert
AFTER INSERT ON game_session_transitions
BEGIN
  INSERT INTO automatch_pending_enqueues
  SELECT * FROM automatch_expected_pending_enqueues WHERE transition_id = NEW.transition_id;
END;

CREATE TRIGGER automatch_pending_enqueues_update
AFTER UPDATE OF status, payload_json ON game_session_transitions
BEGIN
  DELETE FROM automatch_pending_enqueues WHERE transition_id = OLD.transition_id;
  INSERT INTO automatch_pending_enqueues
  SELECT * FROM automatch_expected_pending_enqueues WHERE transition_id = NEW.transition_id;
END;

CREATE TRIGGER automatch_fifo_enqueue_guard
BEFORE INSERT ON game_session_transitions
WHEN NEW.status = 'pending'
  AND EXISTS (
    SELECT 1 FROM automatch_runtime_control
    WHERE singleton = 1 AND json_extract(metadata_json, '$.queueSelection') = 'fifo'
  )
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
  WHERE EXISTS (SELECT 1 FROM automatch_ready_tickets)
    OR EXISTS (SELECT 1 FROM automatch_pending_enqueues);
END;

CREATE TRIGGER automatch_fifo_claim_guard
BEFORE INSERT ON game_session_transitions
WHEN NEW.status = 'pending'
  AND EXISTS (
    SELECT 1 FROM automatch_runtime_control
    WHERE singleton = 1 AND json_extract(metadata_json, '$.queueSelection') = 'fifo'
  )
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
    SELECT invite_id FROM automatch_ready_tickets
    ORDER BY enqueued_at_ms, invite_id LIMIT 1
  );
END;

INSERT INTO automatch_live_tickets SELECT * FROM automatch_expected_live_tickets;
INSERT INTO automatch_pending_enqueues SELECT * FROM automatch_expected_pending_enqueues;
