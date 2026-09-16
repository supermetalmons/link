export const AUTOMATCH_QUEUE_AUDIT_SQL = `SELECT
  (SELECT COUNT(*) FROM automatch_live_tickets) AS live_tickets,
  (SELECT COUNT(*) FROM automatch_pending_enqueues) AS pending_enqueues,
  (SELECT COUNT(*) FROM automatch_expected_live_tickets AS expected
    LEFT JOIN automatch_live_tickets AS actual ON actual.invite_id = expected.invite_id
    WHERE actual.invite_id IS NULL
      OR actual.source_revision IS NOT expected.source_revision
      OR actual.uid IS NOT expected.uid
      OR actual.profile_id_hint IS NOT expected.profile_id_hint
      OR actual.enqueued_at_ms IS NOT expected.enqueued_at_ms) AS live_mismatches,
  (SELECT COUNT(*) FROM automatch_live_tickets AS actual
    WHERE NOT EXISTS (SELECT 1 FROM automatch_expected_live_tickets AS expected
      WHERE expected.invite_id = actual.invite_id)) AS extra_live_tickets,
  (SELECT COUNT(*) FROM automatch_expected_pending_enqueues AS expected
    LEFT JOIN automatch_pending_enqueues AS actual ON actual.transition_id = expected.transition_id
    WHERE actual.transition_id IS NULL OR actual.invite_id IS NOT expected.invite_id
      OR actual.uid IS NOT expected.uid
      OR actual.created_at_ms IS NOT expected.created_at_ms
      OR actual.enqueued_at_ms IS NOT expected.enqueued_at_ms) AS pending_mismatches,
  (SELECT COUNT(*) FROM automatch_pending_enqueues AS actual
    WHERE NOT EXISTS (SELECT 1 FROM automatch_expected_pending_enqueues AS expected
      WHERE expected.transition_id = actual.transition_id)) AS extra_pending_enqueues,
  (SELECT COUNT(*) FROM automatch_live_tickets
    WHERE enqueued_at_ms IS NULL OR uid IS NULL OR trim(uid) = '') AS malformed_live_tickets,
  (SELECT COUNT(*) FROM automatch_pending_enqueues
    WHERE uid IS NULL OR trim(uid) = '' OR enqueued_at_ms IS NULL) AS malformed_pending_enqueues,
  (SELECT COUNT(*) FROM automatch_pending_enqueues AS pending
    WHERE NOT EXISTS (SELECT 1 FROM game_session_transition_resources AS resource
      WHERE resource.resource_key = pending.invite_id
        AND resource.transition_id = pending.transition_id)) AS unrecoverable_pending_enqueues`;

export const AUTOMATCH_QUEUE_INVALID_COLUMNS = [
  "live_mismatches",
  "extra_live_tickets",
  "pending_mismatches",
  "extra_pending_enqueues",
  "malformed_live_tickets",
  "malformed_pending_enqueues",
  "unrecoverable_pending_enqueues",
] as const;

export const AUTOMATCH_QUEUE_SCHEMA_OBJECTS = [
  "automatch_live_tickets",
  "automatch_pending_enqueues",
  "automatch_expected_live_tickets",
  "automatch_expected_pending_enqueues",
  "automatch_ready_tickets",
  "idx_automatch_live_tickets_fifo",
  "idx_automatch_live_tickets_uid",
  "idx_automatch_pending_enqueues_order",
  "automatch_live_tickets_insert",
  "automatch_live_tickets_update",
  "automatch_live_tickets_delete",
  "automatch_pending_enqueues_insert",
  "automatch_pending_enqueues_update",
  "automatch_fifo_enqueue_guard",
  "automatch_fifo_claim_guard",
] as const;
