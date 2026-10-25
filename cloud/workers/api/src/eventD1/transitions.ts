import type {
  EventD1Connection,
  EventTransitionIntent,
  EventWriteAdmission,
} from "./types.ts";
import {
  validateTransitionIntent,
  encodeJson,
  decodeJson,
  exactKey,
  safeInteger,
} from "./validation.ts";
import {
  eventWriteAdmissionGuard,
  eventRevisionGuard,
  guardStatement,
  rethrowEventBatchFailure,
} from "./guards.ts";

export async function createEventTransitionIntent(
  db: EventD1Connection,
  rawIntent: EventTransitionIntent,
  options: { admission: EventWriteAdmission },
): Promise<void> {
  const intent = validateTransitionIntent(rawIntent);
  const encoded = encodeJson(intent);
  try {
    await db.batch([
      eventWriteAdmissionGuard(db, options.admission),
      eventRevisionGuard(db, intent.eventId, intent.expectedRevision),
      guardStatement(
        db,
        `EXISTS (
           SELECT 1 FROM event_records
           WHERE event_id = ? AND pending_transition_id IS NOT NULL
             AND pending_transition_id != ?
         )`,
        [intent.eventId, intent.transitionId],
        "invariant",
      ),
      db
        .prepare(
          `INSERT INTO event_transition_intents (
             transition_id, event_id, expected_revision, status, intent_json,
             attempts, last_error, created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, 'pending', ?, 0, NULL, ?, ?)
           ON CONFLICT (transition_id) DO NOTHING`,
        )
        .bind(
          intent.transitionId,
          intent.eventId,
          intent.expectedRevision,
          encoded,
          intent.createdAtMs,
          intent.updatedAtMs,
        ),
      guardStatement(
        db,
        `NOT EXISTS (
           SELECT 1 FROM event_transition_intents
           WHERE transition_id = ? AND event_id = ?
             AND expected_revision = ? AND status = 'pending'
             AND intent_json = ?
         )`,
        [intent.transitionId, intent.eventId, intent.expectedRevision, encoded],
        "invariant",
      ),
      db
        .prepare(
          `UPDATE event_records SET pending_transition_id = ?
           WHERE event_id = ? AND revision = ?`,
        )
        .bind(intent.transitionId, intent.eventId, intent.expectedRevision),
    ]);
  } catch (error) {
    await rethrowEventBatchFailure(db, error, options);
  }
}

function parseTransitionRow(row: {
  intent_json: string;
}): EventTransitionIntent {
  return validateTransitionIntent(decodeJson(row.intent_json));
}

export async function readEventTransitionIntent(
  db: EventD1Connection,
  transitionId: string,
): Promise<EventTransitionIntent | null> {
  const row = await db
    .prepare(
      `SELECT intent_json FROM event_transition_intents
       WHERE transition_id = ? AND status = 'pending'`,
    )
    .bind(exactKey(transitionId))
    .first<{ intent_json: string }>();
  return row ? parseTransitionRow(row) : null;
}

export async function listPendingEventTransitionIntents(
  db: EventD1Connection,
  limit = 100,
): Promise<Array<EventTransitionIntent & { attempts: number }>> {
  safeInteger(limit, 1);
  const rows = await db
    .prepare(
      `SELECT intent_json, attempts FROM event_transition_intents
       WHERE status = 'pending'
       ORDER BY updated_at_ms, transition_id LIMIT ?`,
    )
    .bind(Math.min(limit, 100))
    .all<{ attempts: number; intent_json: string }>();
  return rows.results.map((row) => ({
    ...parseTransitionRow(row),
    attempts: safeInteger(row.attempts),
  }));
}

export async function recordEventTransitionAttempt(
  db: EventD1Connection,
  input: { error?: string | null; nowMs: number; transitionId: string },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE event_transition_intents
       SET attempts = attempts + 1, last_error = ?, updated_at_ms = ?
       WHERE transition_id = ? AND status = 'pending'`,
    )
    .bind(
      input.error?.slice(0, 1024) || null,
      safeInteger(input.nowMs),
      exactKey(input.transitionId),
    )
    .run();
  return result.meta.changes === 1;
}
