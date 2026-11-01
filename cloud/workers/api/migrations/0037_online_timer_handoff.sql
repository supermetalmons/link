CREATE TABLE timer_storage_handoffs (
  handoff_id TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL UNIQUE,
  object_id TEXT NOT NULL UNIQUE CHECK(length(object_id) = 64 AND object_id NOT GLOB '*[^a-f0-9]*'),
  ownership_digest TEXT NOT NULL CHECK(length(ownership_digest) = 64 AND ownership_digest NOT GLOB '*[^a-f0-9]*'),
  ownership_json TEXT NOT NULL CHECK(json_valid(ownership_json) AND json_type(ownership_json) = 'array'),
  markers_json TEXT NOT NULL CHECK(json_valid(markers_json) AND json_type(markers_json) = 'array'),
  phase TEXT NOT NULL CHECK(phase IN ('copying', 'local')),
  snapshot_digest TEXT CHECK(snapshot_digest IS NULL OR (length(snapshot_digest) = 64 AND snapshot_digest NOT GLOB '*[^a-f0-9]*')),
  copy_receipt_json TEXT CHECK(copy_receipt_json IS NULL OR (json_valid(copy_receipt_json) AND json_type(copy_receipt_json) = 'object')),
  copy_receipt_digest TEXT CHECK(copy_receipt_digest IS NULL OR (length(copy_receipt_digest) = 64 AND copy_receipt_digest NOT GLOB '*[^a-f0-9]*')),
  acknowledgement_json TEXT CHECK(acknowledgement_json IS NULL OR (json_valid(acknowledgement_json) AND json_type(acknowledgement_json) = 'object')),
  CHECK((copy_receipt_json IS NULL) = (copy_receipt_digest IS NULL)),
  CHECK(phase != 'local' OR (snapshot_digest IS NOT NULL AND copy_receipt_json IS NOT NULL AND acknowledgement_json IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE TABLE timer_storage_handoff_owners (
  actor_uid TEXT NOT NULL,
  match_id TEXT NOT NULL,
  opponent_uid TEXT CHECK(opponent_uid IS NULL OR opponent_uid != actor_uid),
  handoff_id TEXT NOT NULL REFERENCES timer_storage_handoffs(handoff_id),
  route_epoch INTEGER NOT NULL CHECK(route_epoch > 0),
  PRIMARY KEY(actor_uid, match_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX timer_storage_handoff_owners_operation ON timer_storage_handoff_owners(handoff_id, match_id, actor_uid);

CREATE TABLE timer_storage_handoff_delete_context (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  handoff_id TEXT NOT NULL REFERENCES timer_storage_handoffs(handoff_id),
  copy_receipt_digest TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL
) STRICT;

CREATE TRIGGER timer_storage_handoffs_insert_guard BEFORE INSERT ON timer_storage_handoffs
WHEN NEW.phase != 'copying' OR NEW.copy_receipt_json IS NOT NULL OR NEW.acknowledgement_json IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'timer-handoff-invalid-initial-state'); END;
CREATE TRIGGER timer_storage_handoffs_update_guard BEFORE UPDATE ON timer_storage_handoffs
WHEN OLD.handoff_id IS NOT NEW.handoff_id OR OLD.invite_id IS NOT NEW.invite_id OR OLD.object_id IS NOT NEW.object_id
  OR OLD.ownership_digest IS NOT NEW.ownership_digest OR OLD.ownership_json IS NOT NEW.ownership_json
  OR OLD.markers_json IS NOT NEW.markers_json OR (OLD.phase = 'local' AND OLD.phase IS NOT NEW.phase)
  OR (OLD.snapshot_digest IS NOT NULL AND OLD.snapshot_digest IS NOT NEW.snapshot_digest)
  OR (OLD.copy_receipt_json IS NOT NULL AND OLD.copy_receipt_json IS NOT NEW.copy_receipt_json)
  OR (OLD.copy_receipt_digest IS NOT NULL AND OLD.copy_receipt_digest IS NOT NEW.copy_receipt_digest)
  OR (OLD.acknowledgement_json IS NOT NULL AND OLD.acknowledgement_json IS NOT NEW.acknowledgement_json)
BEGIN SELECT RAISE(ABORT, 'timer-handoff-immutable'); END;
CREATE TRIGGER timer_storage_handoffs_delete_guard BEFORE DELETE ON timer_storage_handoffs
BEGIN SELECT RAISE(ABORT, 'timer-handoff-immutable'); END;
CREATE TRIGGER timer_storage_handoff_owners_insert_guard BEFORE INSERT ON timer_storage_handoff_owners
WHEN NOT EXISTS (
  SELECT 1 FROM timer_storage_handoffs h, json_each(h.ownership_json) owner
  JOIN match_state_routes_canonical r ON r.actor_uid = NEW.actor_uid AND r.match_id = NEW.match_id
  WHERE h.handoff_id = NEW.handoff_id AND h.phase = 'copying'
    AND json_extract(owner.value, '$.actorUid') = NEW.actor_uid
    AND json_extract(owner.value, '$.matchId') = NEW.match_id
    AND json_extract(owner.value, '$.opponentUid') IS NEW.opponent_uid
    AND r.kind = 'durable' AND r.invite_id = h.invite_id AND r.epoch = NEW.route_epoch
)
BEGIN SELECT RAISE(ABORT, 'timer-handoff-owner-invalid'); END;
CREATE TRIGGER timer_storage_handoff_owners_update_guard BEFORE UPDATE ON timer_storage_handoff_owners
BEGIN SELECT RAISE(ABORT, 'timer-handoff-owner-immutable'); END;
CREATE TRIGGER timer_storage_handoff_owners_delete_guard BEFORE DELETE ON timer_storage_handoff_owners
BEGIN SELECT RAISE(ABORT, 'timer-handoff-owner-immutable'); END;

CREATE TRIGGER timer_storage_handoff_route_insert_guard BEFORE INSERT ON match_state_routes_canonical
WHEN (EXISTS (SELECT 1 FROM timer_storage_handoffs WHERE invite_id = NEW.invite_id AND phase = 'copying')
  OR EXISTS (SELECT 1 FROM timer_storage_handoff_owners WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id)
) AND NOT EXISTS (SELECT 1 FROM match_state_routes_canonical WHERE actor_uid = NEW.actor_uid AND match_id = NEW.match_id AND kind IS NEW.kind AND invite_id IS NEW.invite_id AND epoch IS NEW.epoch)
BEGIN SELECT RAISE(ABORT, 'timer-handoff-route-fenced'); END;
CREATE TRIGGER timer_storage_handoff_route_update_guard BEFORE UPDATE ON match_state_routes_canonical
WHEN (EXISTS (SELECT 1 FROM timer_storage_handoffs WHERE invite_id IN (OLD.invite_id, NEW.invite_id))
  OR EXISTS (SELECT 1 FROM timer_storage_handoff_owners WHERE (actor_uid = OLD.actor_uid AND match_id = OLD.match_id) OR (actor_uid = NEW.actor_uid AND match_id = NEW.match_id))
) AND (OLD.actor_uid IS NOT NEW.actor_uid OR OLD.match_id IS NOT NEW.match_id OR OLD.kind IS NOT NEW.kind OR OLD.invite_id IS NOT NEW.invite_id OR OLD.epoch IS NOT NEW.epoch)
BEGIN SELECT RAISE(ABORT, 'timer-handoff-route-fenced'); END;
CREATE TRIGGER timer_storage_handoff_route_delete_guard BEFORE DELETE ON match_state_routes_canonical
WHEN EXISTS (SELECT 1 FROM timer_storage_handoffs WHERE invite_id = OLD.invite_id)
  OR EXISTS (SELECT 1 FROM timer_storage_handoff_owners WHERE actor_uid = OLD.actor_uid AND match_id = OLD.match_id)
BEGIN SELECT RAISE(ABORT, 'timer-handoff-route-fenced'); END;

CREATE TRIGGER timer_storage_handoff_timer_insert_guard BEFORE INSERT ON match_timer_starts_canonical
WHEN EXISTS (SELECT 1 FROM timer_storage_handoff_owners WHERE actor_uid = NEW.player_id AND match_id = NEW.match_id)
  OR EXISTS (SELECT 1 FROM match_state_routes_canonical r JOIN timer_storage_handoffs h ON h.invite_id = r.invite_id WHERE r.actor_uid = NEW.player_id AND r.match_id = NEW.match_id)
BEGIN SELECT RAISE(ABORT, 'timer-handoff-write-fenced'); END;
CREATE TRIGGER timer_storage_handoff_timer_update_guard BEFORE UPDATE ON match_timer_starts_canonical
WHEN EXISTS (SELECT 1 FROM timer_storage_handoff_owners WHERE (actor_uid = OLD.player_id AND match_id = OLD.match_id) OR (actor_uid = NEW.player_id AND match_id = NEW.match_id))
  OR EXISTS (SELECT 1 FROM match_state_routes_canonical r JOIN timer_storage_handoffs h ON h.invite_id = r.invite_id WHERE (r.actor_uid = OLD.player_id AND r.match_id = OLD.match_id) OR (r.actor_uid = NEW.player_id AND r.match_id = NEW.match_id))
BEGIN SELECT RAISE(ABORT, 'timer-handoff-write-fenced'); END;
CREATE TRIGGER timer_storage_handoff_timer_delete_guard BEFORE DELETE ON match_timer_starts_canonical
WHEN (
  EXISTS (SELECT 1 FROM timer_storage_handoff_owners WHERE actor_uid = OLD.player_id AND match_id = OLD.match_id)
  OR EXISTS (SELECT 1 FROM match_state_routes_canonical r JOIN timer_storage_handoffs h ON h.invite_id = r.invite_id WHERE r.actor_uid = OLD.player_id AND r.match_id = OLD.match_id)
) AND NOT EXISTS (
  SELECT 1 FROM timer_storage_handoff_delete_context c
  JOIN timer_storage_handoffs h ON h.handoff_id = c.handoff_id
  JOIN timer_storage_handoff_owners owner ON owner.handoff_id = h.handoff_id
  JOIN json_each(h.markers_json) marker
  WHERE c.singleton = 1 AND h.phase = 'copying'
    AND h.copy_receipt_digest = c.copy_receipt_digest AND h.snapshot_digest = c.snapshot_digest
    AND owner.actor_uid = OLD.player_id AND owner.match_id = OLD.match_id
    AND json_extract(marker.value, '$.playerId') = OLD.player_id
    AND json_extract(marker.value, '$.matchId') = OLD.match_id
    AND json_extract(marker.value, '$.opponentId') = OLD.opponent_id
    AND json_extract(marker.value, '$.turnNumber') = OLD.turn_number
    AND json_extract(marker.value, '$.deadlineAtMs') = OLD.deadline_at_ms
    AND json_extract(marker.value, '$.updatedAtMs') = OLD.updated_at_ms
)
BEGIN SELECT RAISE(ABORT, 'timer-handoff-write-fenced'); END;

CREATE TRIGGER timer_storage_handoff_context_insert_guard BEFORE INSERT ON timer_storage_handoff_delete_context
WHEN NOT EXISTS (SELECT 1 FROM timer_storage_handoffs h WHERE h.handoff_id = NEW.handoff_id AND h.phase = 'copying' AND h.copy_receipt_digest = NEW.copy_receipt_digest AND h.snapshot_digest = NEW.snapshot_digest)
BEGIN SELECT RAISE(ABORT, 'timer-handoff-delete-unauthorized'); END;
CREATE TRIGGER timer_storage_handoff_context_update_guard BEFORE UPDATE ON timer_storage_handoff_delete_context
BEGIN SELECT RAISE(ABORT, 'timer-handoff-delete-unauthorized'); END;
