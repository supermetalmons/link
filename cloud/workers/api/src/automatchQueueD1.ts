import {
  AutomatchD1Failure,
  decodeSnapshot,
  type AutomatchRuntimeControl,
} from "./automatchD1.ts";

export type AutomatchQueueHead =
  | { kind: "ready"; inviteId: string; value: unknown }
  | { kind: "pending"; inviteId: string; transitionId: string };

export function isFifoAutomatchQueue(
  control: Pick<AutomatchRuntimeControl, "metadata">,
): boolean {
  const metadata = control.metadata;
  return Boolean(
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    "queueSelection" in metadata &&
    metadata.queueSelection === "fifo",
  );
}

export function isAutomatchQueueSelectionConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = error; current instanceof Error && !seen.has(current);) {
    seen.add(current);
    if (current.message.includes("automatch-selection-stale")) return true;
    current = current.cause;
  }
  return false;
}

export const AUTOMATCH_QUEUE_HEAD_SQL = `WITH ready AS (
  SELECT ticket.invite_id, source.payload_json, source.revision,
    resource.transition_id,
    (resource.resource_key IS NULL OR reservation.status = 'pending') AS recoverable
  FROM automatch_ready_tickets AS ticket
  CROSS JOIN automatch_entries AS source ON source.record_key = ticket.invite_id
    AND source.revision = ticket.source_revision AND source.payload_json IS NOT NULL
  LEFT JOIN game_session_transition_resources AS resource ON resource.resource_key = ticket.invite_id
  LEFT JOIN game_session_transitions AS reservation ON reservation.transition_id = resource.transition_id
  ORDER BY ticket.enqueued_at_ms, ticket.invite_id LIMIT 1
), pending AS (
  SELECT invite_id, NULL AS payload_json, 0 AS revision, transition_id,
    EXISTS (SELECT 1 FROM game_session_transition_resources AS resource
      JOIN game_session_transitions AS reservation ON reservation.transition_id = resource.transition_id
      WHERE resource.resource_key = pending.invite_id
        AND resource.transition_id = pending.transition_id
        AND reservation.status = 'pending') AS recoverable
  FROM automatch_pending_enqueues AS pending
  ORDER BY created_at_ms, transition_id LIMIT 1
)
SELECT * FROM ready UNION ALL SELECT * FROM pending
WHERE NOT EXISTS (SELECT 1 FROM ready)`;

export async function readAutomatchQueueHead(
  db: D1Database,
  signal?: AbortSignal,
): Promise<AutomatchQueueHead | null> {
  signal?.throwIfAborted();
  const row = await db
    .withSession("first-primary")
    .prepare(AUTOMATCH_QUEUE_HEAD_SQL)
    .first<{
      invite_id: string;
      payload_json: string | null;
      revision: number;
      transition_id: string | null;
      recoverable: number;
    }>();
  signal?.throwIfAborted();
  if (!row) return null;
  if (row.transition_id) {
    if (row.recoverable !== 1)
      throw new AutomatchD1Failure(
        "automatch-queue-pending-resource-unavailable",
      );
    return {
      kind: "pending",
      inviteId: row.invite_id,
      transitionId: row.transition_id,
    };
  }
  return {
    kind: "ready",
    inviteId: row.invite_id,
    value: decodeSnapshot("automatch", {
      record_key: row.invite_id,
      payload_json: row.payload_json,
      revision: row.revision,
    }).value,
  };
}
