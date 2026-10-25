import { parseEventProfileGameProjectionOutbox } from "../profileGameProjectionOutbox.ts";
import { parseEventProjectionOutbox } from "../telegramProjectionOutbox.ts";
import { runOptimisticTransaction } from "../optimisticTransaction.ts";
import {
  eventLeaseGuard,
  eventWriteAdmissionGuard,
  rethrowEventBatchFailure,
} from "./guards.ts";
import {
  prepareProjectionOutboxRead,
  type ProjectionOutboxKind,
  type ProjectionOutboxSnapshot,
} from "./reads.ts";
import {
  EventD1Conflict,
  MAX_EVENT_TRANSACTION_ATTEMPTS,
  type EventD1Connection,
  type EventTransactionOptions,
} from "./types.ts";
import {
  decodeJson,
  encodeJson,
  safeInteger,
  validateProjectionOutbox,
} from "./validation.ts";

type ProjectionClaim = { expectedTimestamp: number; nowMs: number };
type ProjectionOutboxWrite = {
  recordJson: string;
  raw: unknown;
  parsed:
    | NonNullable<ReturnType<typeof parseEventProfileGameProjectionOutbox>>
    | NonNullable<ReturnType<typeof parseEventProjectionOutbox>>;
  timestamp: number;
};

async function mutateProjectionOutbox(
  db: EventD1Connection,
  kind: ProjectionOutboxKind,
  eventId: string,
  requestId: string,
  claim: ProjectionClaim | null,
  options: EventTransactionOptions,
  initialRecordJson?: string,
): Promise<boolean> {
  const table =
    kind === "profile-game"
      ? "event_profile_game_projection_outboxes"
      : "event_telegram_projection_outboxes";
  let seededRecordJson = initialRecordJson;
  const transaction = await runOptimisticTransaction({
    maxAttempts: MAX_EVENT_TRANSACTION_ATTEMPTS,
    signal: options.signal,
    async read() {
      if (seededRecordJson !== undefined) {
        const record_json = seededRecordJson;
        seededRecordJson = undefined;
        return { record_json };
      }
      return prepareProjectionOutboxRead(db, table, eventId).first<{
        record_json: string;
      }>();
    },
    getValue: (row) => row,
    decide(row): { commit: false } | { value: ProjectionOutboxWrite } {
      const raw = row ? decodeJson(row.record_json) : null;
      const parsed =
        kind === "profile-game"
          ? parseEventProfileGameProjectionOutbox(raw)
          : parseEventProjectionOutbox(raw);
      if (!row || !parsed || parsed.requestId !== requestId)
        return { commit: false };
      const timestamp =
        "lastQueuedAtMs" in parsed ? parsed.lastQueuedAtMs : parsed.updatedAtMs;
      if (
        claim &&
        (timestamp !== claim.expectedTimestamp || timestamp > claim.nowMs)
      ) {
        return { commit: false };
      }
      return { value: { recordJson: row.record_json, raw, parsed, timestamp } };
    },
    async write(row, { recordJson, raw, parsed, timestamp }) {
      safeInteger((options.now || Date.now)());
      let mutation: D1PreparedStatement;
      if (claim) {
        const next = validateProjectionOutbox(kind, eventId, {
          ...(raw as Record<string, unknown>),
          ...(kind === "profile-game"
            ? { lastQueuedAtMs: claim.nowMs }
            : {
                firstQueuedAtMs:
                  "firstQueuedAtMs" in parsed
                    ? parsed.firstQueuedAtMs
                    : timestamp,
                updatedAtMs: claim.nowMs,
              }),
        });
        const canonical = recordJson === encodeJson(raw);
        mutation =
          kind === "profile-game"
            ? db
                .prepare(
                  `UPDATE event_profile_game_projection_outboxes
                 SET request_id = ?, status = 'pending', last_queued_at_ms = ?,
                   record_json = ${canonical ? "json_set(record_json, '$.lastQueuedAtMs', CAST(? AS INTEGER))" : "?"}
                 WHERE event_id = ? AND status = 'pending' AND record_json = ?`,
                )
                .bind(
                  next.requestId,
                  next.lastQueuedAtMs,
                  canonical ? next.lastQueuedAtMs : encodeJson(next.raw),
                  eventId,
                  recordJson,
                )
            : db
                .prepare(
                  `UPDATE event_telegram_projection_outboxes
                 SET request_id = ?, status = 'pending', first_queued_at_ms = ?,
                   updated_at_ms = ?, record_json = ${canonical ? "json_set(record_json, '$.firstQueuedAtMs', CAST(? AS INTEGER), '$.updatedAtMs', CAST(? AS INTEGER))" : "?"}
                 WHERE event_id = ? AND status = 'pending' AND record_json = ?`,
                )
                .bind(
                  next.requestId,
                  next.firstQueuedAtMs,
                  next.updatedAtMs,
                  ...(canonical
                    ? [next.firstQueuedAtMs, next.updatedAtMs]
                    : [encodeJson(next.raw)]),
                  eventId,
                  recordJson,
                );
      } else {
        mutation = db
          .prepare(
            `DELETE FROM ${table}
           WHERE event_id = ? AND status = 'pending' AND record_json = ?`,
          )
          .bind(eventId, recordJson);
      }
      const statements = [eventWriteAdmissionGuard(db, options.admission)];
      if (options.eventLease)
        statements.push(eventLeaseGuard(db, options.eventLease));
      statements.push(mutation);
      options.signal?.throwIfAborted();
      try {
        const results = await db
          .batch(statements)
          .catch((error) => rethrowEventBatchFailure(db, error, options));
        return {
          applied: results[results.length - 1].meta.changes === 1,
          value: row,
        };
      } catch (error) {
        if (!(error instanceof EventD1Conflict)) throw error;
        options.signal?.throwIfAborted();
        return { applied: false, value: row };
      }
    },
    conflictError: () => new EventD1Conflict(),
  });
  return transaction.committed;
}

export function claimEventProjectionOutboxSnapshot<
  Kind extends ProjectionOutboxKind,
>(
  db: EventD1Connection,
  snapshot: ProjectionOutboxSnapshot<Kind>,
  requestId: string,
  expectedTimestamp: number,
  nowMs: number,
  options: EventTransactionOptions,
): Promise<boolean> {
  return mutateProjectionOutbox(
    db,
    snapshot.kind,
    snapshot.eventId,
    requestId,
    { expectedTimestamp, nowMs },
    options,
    snapshot.recordJson,
  );
}

export function claimEventProfileGameProjectionOutbox(
  db: EventD1Connection,
  eventId: string,
  requestId: string,
  expectedLastQueuedAtMs: number,
  nowMs: number,
  options: EventTransactionOptions,
): Promise<boolean> {
  return mutateProjectionOutbox(
    db,
    "profile-game",
    eventId,
    requestId,
    {
      expectedTimestamp: expectedLastQueuedAtMs,
      nowMs,
    },
    options,
  );
}

export function acknowledgeEventProfileGameProjectionOutbox(
  db: EventD1Connection,
  eventId: string,
  requestId: string,
  options: EventTransactionOptions,
): Promise<boolean> {
  return mutateProjectionOutbox(
    db,
    "profile-game",
    eventId,
    requestId,
    null,
    options,
  );
}

export function claimEventTelegramProjectionOutbox(
  db: EventD1Connection,
  eventId: string,
  requestId: string,
  expectedUpdatedAtMs: number,
  nowMs: number,
  options: EventTransactionOptions,
): Promise<boolean> {
  return mutateProjectionOutbox(
    db,
    "telegram",
    eventId,
    requestId,
    {
      expectedTimestamp: expectedUpdatedAtMs,
      nowMs,
    },
    options,
  );
}

export function acknowledgeEventTelegramProjectionOutbox(
  db: EventD1Connection,
  eventId: string,
  requestId: string,
  options: EventTransactionOptions,
): Promise<boolean> {
  return mutateProjectionOutbox(
    db,
    "telegram",
    eventId,
    requestId,
    null,
    options,
  );
}
