SELECT CASE WHEN EXISTS (
  SELECT 1 FROM application_data_control
  WHERE singleton = 1 AND generation = 3 AND data_epoch = 1 AND phase = 'active'
) AND EXISTS (
  SELECT 1 FROM match_state_control
  WHERE singleton = 1 AND backend = 'durable' AND state = 'active' AND epoch > 0
) THEN 1 ELSE json('canonical-timer-retirement-control-mismatch') END;

SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM timer_storage_handoffs
  WHERE phase != 'local' OR snapshot_digest IS NULL OR copy_receipt_json IS NULL
    OR copy_receipt_digest IS NULL OR acknowledgement_json IS NULL
) AND NOT EXISTS (SELECT 1 FROM match_timer_starts_canonical)
  AND NOT EXISTS (SELECT 1 FROM timer_storage_handoff_delete_context)
THEN 1 ELSE json('canonical-timer-retirement-not-drained') END;

WITH expected(type, name, tbl_name, sql, required) AS (
VALUES
  ('index', 'idx_match_timer_starts_canonical_updated', 'match_timer_starts_canonical', 'CREATE INDEX idx_match_timer_starts_canonical_updated ON match_timer_starts_canonical(updated_at_ms, player_id, match_id)', 1),
  ('table', 'match_timer_starts_canonical', 'match_timer_starts_canonical', 'CREATE TABLE match_timer_starts_canonical (
  match_id TEXT NOT NULL CHECK (match_id IS NULL OR (match_id != '''' AND instr(match_id, ''/'') = 0)),
  player_id TEXT NOT NULL CHECK (player_id IS NULL OR (player_id != '''' AND instr(player_id, ''/'') = 0)),
  opponent_id TEXT NOT NULL CHECK (opponent_id IS NULL OR (opponent_id != '''' AND instr(opponent_id, ''/'') = 0)),
  turn_number INTEGER NOT NULL CHECK (turn_number IS NULL OR turn_number BETWEEN 0 AND 9007199254740991),
  deadline_at_ms INTEGER NOT NULL CHECK (deadline_at_ms IS NULL OR deadline_at_ms BETWEEN 1 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms IS NULL OR updated_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (player_id, match_id),
  CHECK (opponent_id != player_id)
) STRICT, WITHOUT ROWID', 1),
  ('table', 'timer_storage_handoff_delete_context', 'timer_storage_handoff_delete_context', 'CREATE TABLE timer_storage_handoff_delete_context (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  handoff_id TEXT NOT NULL REFERENCES timer_storage_handoffs(handoff_id),
  copy_receipt_digest TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL
) STRICT', 1),
  ('trigger', 'match_timer_starts_canonical_application_delete', 'match_timer_starts_canonical', 'CREATE TRIGGER "match_timer_starts_canonical_application_delete" BEFORE DELETE ON "match_timer_starts_canonical"
WHEN NOT EXISTS (
  SELECT 1 FROM application_write_context w
  JOIN application_data_control c ON c.singleton = 1
  WHERE w.singleton = 1 AND w.generation = c.generation AND w.data_epoch = c.data_epoch
  AND ((w.migration_id IS NULL AND c.phase IN (''active'', ''closing''))
    OR (w.migration_id = c.migration_id AND c.phase IN (''closed'', ''verifying'')))
)
BEGIN SELECT RAISE(ABORT, ''application-write-fenced''); END', 0),
  ('trigger', 'match_timer_starts_canonical_application_insert', 'match_timer_starts_canonical', 'CREATE TRIGGER "match_timer_starts_canonical_application_insert" BEFORE INSERT ON "match_timer_starts_canonical"
WHEN NOT EXISTS (
  SELECT 1 FROM application_write_context w
  JOIN application_data_control c ON c.singleton = 1
  WHERE w.singleton = 1 AND w.generation = c.generation AND w.data_epoch = c.data_epoch
  AND ((w.migration_id IS NULL AND c.phase IN (''active'', ''closing''))
    OR (w.migration_id = c.migration_id AND c.phase IN (''closed'', ''verifying'')))
)
BEGIN SELECT RAISE(ABORT, ''application-write-fenced''); END', 0),
  ('trigger', 'match_timer_starts_canonical_application_update', 'match_timer_starts_canonical', 'CREATE TRIGGER "match_timer_starts_canonical_application_update" BEFORE UPDATE ON "match_timer_starts_canonical"
WHEN NOT EXISTS (
  SELECT 1 FROM application_write_context w
  JOIN application_data_control c ON c.singleton = 1
  WHERE w.singleton = 1 AND w.generation = c.generation AND w.data_epoch = c.data_epoch
  AND ((w.migration_id IS NULL AND c.phase IN (''active'', ''closing''))
    OR (w.migration_id = c.migration_id AND c.phase IN (''closed'', ''verifying'')))
)
BEGIN SELECT RAISE(ABORT, ''application-write-fenced''); END', 0),
  ('trigger', 'timer_storage_handoff_context_insert_guard', 'timer_storage_handoff_delete_context', 'CREATE TRIGGER timer_storage_handoff_context_insert_guard BEFORE INSERT ON timer_storage_handoff_delete_context
WHEN NOT EXISTS (SELECT 1 FROM timer_storage_handoffs h WHERE h.handoff_id = NEW.handoff_id AND h.phase = ''copying'' AND h.copy_receipt_digest = NEW.copy_receipt_digest AND h.snapshot_digest = NEW.snapshot_digest)
BEGIN SELECT RAISE(ABORT, ''timer-handoff-delete-unauthorized''); END', 1),
  ('trigger', 'timer_storage_handoff_context_update_guard', 'timer_storage_handoff_delete_context', 'CREATE TRIGGER timer_storage_handoff_context_update_guard BEFORE UPDATE ON timer_storage_handoff_delete_context
BEGIN SELECT RAISE(ABORT, ''timer-handoff-delete-unauthorized''); END', 1),
  ('trigger', 'timer_storage_handoff_delete_context_application_delete', 'timer_storage_handoff_delete_context', 'CREATE TRIGGER "timer_storage_handoff_delete_context_application_delete" BEFORE DELETE ON "timer_storage_handoff_delete_context"
WHEN NOT EXISTS (
  SELECT 1 FROM application_write_context w
  JOIN application_data_control c ON c.singleton = 1
  WHERE w.singleton = 1 AND w.generation = c.generation AND w.data_epoch = c.data_epoch
  AND ((w.migration_id IS NULL AND c.phase IN (''active'', ''closing''))
    OR (w.migration_id = c.migration_id AND c.phase IN (''closed'', ''verifying'')))
)
BEGIN SELECT RAISE(ABORT, ''application-write-fenced''); END', 0),
  ('trigger', 'timer_storage_handoff_delete_context_application_insert', 'timer_storage_handoff_delete_context', 'CREATE TRIGGER "timer_storage_handoff_delete_context_application_insert" BEFORE INSERT ON "timer_storage_handoff_delete_context"
WHEN NOT EXISTS (
  SELECT 1 FROM application_write_context w
  JOIN application_data_control c ON c.singleton = 1
  WHERE w.singleton = 1 AND w.generation = c.generation AND w.data_epoch = c.data_epoch
  AND ((w.migration_id IS NULL AND c.phase IN (''active'', ''closing''))
    OR (w.migration_id = c.migration_id AND c.phase IN (''closed'', ''verifying'')))
)
BEGIN SELECT RAISE(ABORT, ''application-write-fenced''); END', 0),
  ('trigger', 'timer_storage_handoff_delete_context_application_update', 'timer_storage_handoff_delete_context', 'CREATE TRIGGER "timer_storage_handoff_delete_context_application_update" BEFORE UPDATE ON "timer_storage_handoff_delete_context"
WHEN NOT EXISTS (
  SELECT 1 FROM application_write_context w
  JOIN application_data_control c ON c.singleton = 1
  WHERE w.singleton = 1 AND w.generation = c.generation AND w.data_epoch = c.data_epoch
  AND ((w.migration_id IS NULL AND c.phase IN (''active'', ''closing''))
    OR (w.migration_id = c.migration_id AND c.phase IN (''closed'', ''verifying'')))
)
BEGIN SELECT RAISE(ABORT, ''application-write-fenced''); END', 0),
  ('trigger', 'timer_storage_handoff_timer_delete_guard', 'match_timer_starts_canonical', 'CREATE TRIGGER timer_storage_handoff_timer_delete_guard BEFORE DELETE ON match_timer_starts_canonical
WHEN (
  EXISTS (SELECT 1 FROM timer_storage_handoff_owners WHERE actor_uid = OLD.player_id AND match_id = OLD.match_id)
  OR EXISTS (SELECT 1 FROM match_state_routes_canonical r JOIN timer_storage_handoffs h ON h.invite_id = r.invite_id WHERE r.actor_uid = OLD.player_id AND r.match_id = OLD.match_id)
) AND NOT EXISTS (
  SELECT 1 FROM timer_storage_handoff_delete_context c
  JOIN timer_storage_handoffs h ON h.handoff_id = c.handoff_id
  JOIN timer_storage_handoff_owners owner ON owner.handoff_id = h.handoff_id
  JOIN json_each(h.markers_json) marker
  WHERE c.singleton = 1 AND h.phase = ''copying''
    AND h.copy_receipt_digest = c.copy_receipt_digest AND h.snapshot_digest = c.snapshot_digest
    AND owner.actor_uid = OLD.player_id AND owner.match_id = OLD.match_id
    AND json_extract(marker.value, ''$.playerId'') = OLD.player_id
    AND json_extract(marker.value, ''$.matchId'') = OLD.match_id
    AND json_extract(marker.value, ''$.opponentId'') = OLD.opponent_id
    AND json_extract(marker.value, ''$.turnNumber'') = OLD.turn_number
    AND json_extract(marker.value, ''$.deadlineAtMs'') = OLD.deadline_at_ms
    AND json_extract(marker.value, ''$.updatedAtMs'') = OLD.updated_at_ms
)
BEGIN SELECT RAISE(ABORT, ''timer-handoff-write-fenced''); END', 1),
  ('trigger', 'timer_storage_handoff_timer_insert_guard', 'match_timer_starts_canonical', 'CREATE TRIGGER timer_storage_handoff_timer_insert_guard BEFORE INSERT ON match_timer_starts_canonical
WHEN EXISTS (SELECT 1 FROM timer_storage_handoff_owners WHERE actor_uid = NEW.player_id AND match_id = NEW.match_id)
  OR EXISTS (SELECT 1 FROM match_state_routes_canonical r JOIN timer_storage_handoffs h ON h.invite_id = r.invite_id WHERE r.actor_uid = NEW.player_id AND r.match_id = NEW.match_id)
BEGIN SELECT RAISE(ABORT, ''timer-handoff-write-fenced''); END', 1),
  ('trigger', 'timer_storage_handoff_timer_update_guard', 'match_timer_starts_canonical', 'CREATE TRIGGER timer_storage_handoff_timer_update_guard BEFORE UPDATE ON match_timer_starts_canonical
WHEN EXISTS (SELECT 1 FROM timer_storage_handoff_owners WHERE (actor_uid = OLD.player_id AND match_id = OLD.match_id) OR (actor_uid = NEW.player_id AND match_id = NEW.match_id))
  OR EXISTS (SELECT 1 FROM match_state_routes_canonical r JOIN timer_storage_handoffs h ON h.invite_id = r.invite_id WHERE (r.actor_uid = OLD.player_id AND r.match_id = OLD.match_id) OR (r.actor_uid = NEW.player_id AND r.match_id = NEW.match_id))
BEGIN SELECT RAISE(ABORT, ''timer-handoff-write-fenced''); END', 1)
)
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1 FROM expected e WHERE e.required = 1 AND NOT EXISTS (
      SELECT 1 FROM sqlite_schema s
      WHERE s.type = e.type AND s.name = e.name AND s.tbl_name = e.tbl_name AND s.sql IS e.sql
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM sqlite_schema s
    WHERE s.tbl_name IN ('match_timer_starts_canonical', 'timer_storage_handoff_delete_context')
      AND s.name NOT LIKE 'sqlite_%'
      AND NOT EXISTS (
        SELECT 1 FROM expected e
        WHERE s.type = e.type AND s.name = e.name AND s.tbl_name = e.tbl_name AND s.sql IS e.sql
      )
  )
  AND (SELECT COUNT(*) FROM sqlite_schema WHERE name IN (
    'match_timer_starts_canonical_application_insert',
    'match_timer_starts_canonical_application_update',
    'match_timer_starts_canonical_application_delete'
  )) IN (0, 3)
  AND (SELECT COUNT(*) FROM sqlite_schema WHERE name IN (
    'timer_storage_handoff_delete_context_application_insert',
    'timer_storage_handoff_delete_context_application_update',
    'timer_storage_handoff_delete_context_application_delete'
  )) IN (0, 3)
  AND NOT EXISTS (
    SELECT 1 FROM sqlite_schema s
    WHERE s.tbl_name NOT IN ('match_timer_starts_canonical', 'timer_storage_handoff_delete_context')
      AND s.sql IS NOT NULL
      AND (instr(lower(s.sql), 'match_timer_starts_canonical') > 0
        OR instr(lower(s.sql), 'timer_storage_handoff_delete_context') > 0)
  )
THEN 1 ELSE json('canonical-timer-retirement-schema-mismatch') END;

DROP TABLE match_timer_starts_canonical;
DROP TABLE timer_storage_handoff_delete_context;

SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)
THEN 1 ELSE json('canonical-timer-retirement-foreign-key-mismatch') END;
