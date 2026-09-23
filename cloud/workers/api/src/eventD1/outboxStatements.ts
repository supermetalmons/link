import {
  isRecord,
  cloneJson,
  encodeJson,
  safeInteger,
  exactKey,
  validateEventProgressOutbox,
  decodeJson,
  isJsonValue,
  validateProjectionOutbox,
} from "./validation.ts";
import {
  EventD1Failure,
  EventD1Conflict,
  type EventD1Connection,
  type EventMutationOptions,
} from "./types.ts";
import {
  readEventProgressOutboxSnapshot,
  readEventTelegramProjectionState,
} from "./reads.ts";
import {
  recordJsonGuard,
  progressOutboxSnapshotGuard,
  telegramStateRevisionGuard,
} from "./guards.ts";
import { parseEventProgressOutbox } from "../eventProgressCodec.ts";
import type { PreparedEventMutations } from "./mutationPreparation.ts";
import { requiredMutationSnapshot } from "./mutationSnapshots.ts";

export async function buildOutboxStatements(
  db: EventD1Connection,
  {
    snapshots,
    progressOutboxSnapshot,
    progressDispatchSnapshots,
    telegramProjectionSnapshot,
    progressUpdates,
    progressDeadUpdates,
    profileProjectionUpdates,
    telegramProjectionUpdates,
    telegramStateUpdates,
  }: Pick<
    PreparedEventMutations,
    | "snapshots"
    | "progressOutboxSnapshot"
    | "progressDispatchSnapshots"
    | "telegramProjectionSnapshot"
    | "progressUpdates"
    | "progressDeadUpdates"
    | "profileProjectionUpdates"
    | "telegramProjectionUpdates"
    | "telegramStateUpdates"
  >,
  options: EventMutationOptions,
  nowMs: number,
) {
  const guards: D1PreparedStatement[] = [];
  const mutations: D1PreparedStatement[] = [];

  for (const [outboxId, raw] of progressUpdates) {
    if (Object.hasOwn(options.expectedRecords?.progress || {}, outboxId)) {
      guards.push(
        recordJsonGuard(
          db,
          "event_progress_outboxes",
          outboxId,
          options.expectedRecords!.progress![outboxId],
          "pending",
        ),
      );
    }
    if (raw === null) {
      if (progressOutboxSnapshot) {
        guards.push(progressOutboxSnapshotGuard(db, progressOutboxSnapshot));
      }
      mutations.push(
        db
          .prepare(
            `DELETE FROM event_progress_outboxes
             WHERE outbox_id = ? AND status = 'pending'`,
          )
          .bind(outboxId),
      );
      continue;
    }
    let record = validateEventProgressOutbox(outboxId, raw);
    const stored =
      progressOutboxSnapshot ??
      progressDispatchSnapshots.get(outboxId) ??
      (snapshots
        ? requiredMutationSnapshot(snapshots.progress, outboxId)
        : await readEventProgressOutboxSnapshot(db, outboxId));
    guards.push(progressOutboxSnapshotGuard(db, stored));
    const previous =
      stored.recordJson !== null
        ? await parseEventProgressOutbox(
            outboxId,
            decodeJson(stored.recordJson),
          )
        : null;
    if (stored.recordJson !== null && !previous) {
      mutations.push(
        db
          .prepare(
            `INSERT INTO event_progress_outboxes (
               outbox_id, event_id, status, run_at_ms, last_queued_at_ms, record_json
             )
             SELECT outbox_id, event_id, 'dead', NULL, ?,
               json_object(
                 'deadAtMs', ?, 'originalRecord', json(record_json),
                 'reason', 'invalid-event-progress-outbox'
               )
             FROM event_progress_outboxes
             WHERE status = 'pending' AND outbox_id = ? AND record_json = ?
             ON CONFLICT (status, outbox_id) DO UPDATE SET
               event_id = excluded.event_id,
               run_at_ms = NULL,
               last_queued_at_ms = excluded.last_queued_at_ms,
               record_json = excluded.record_json`,
          )
          .bind(nowMs, nowMs, outboxId, stored.recordJson),
      );
    }
    if (
      previous &&
      (record.reason === "event-prize-announcement" ||
        record.reason === "sunday-mons-reminder") &&
      Number.isSafeInteger(record.firstQueuedAtMs)
    ) {
      record = {
        ...record,
        firstQueuedAtMs: Math.min(
          previous.outbox.firstQueuedAtMs,
          Number(record.firstQueuedAtMs),
        ),
      };
    }
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_progress_outboxes (
             outbox_id, event_id, status, run_at_ms, last_queued_at_ms,
             record_json
           ) VALUES (?, ?, 'pending', ?, ?, ?)
           ON CONFLICT (status, outbox_id) DO UPDATE SET
             event_id = excluded.event_id,
             status = 'pending',
             run_at_ms = excluded.run_at_ms,
             last_queued_at_ms = excluded.last_queued_at_ms,
             record_json = excluded.record_json`,
        )
        .bind(
          outboxId,
          record.eventId,
          record.runAtMs,
          record.lastQueuedAtMs,
          encodeJson(record),
        ),
    );
  }

  for (const [outboxId, raw] of progressDeadUpdates) {
    if (Object.hasOwn(options.expectedRecords?.dead || {}, outboxId)) {
      guards.push(
        recordJsonGuard(
          db,
          "event_progress_outboxes",
          outboxId,
          options.expectedRecords!.dead![outboxId],
          "dead",
        ),
      );
    }
    if (raw === null) {
      mutations.push(
        db
          .prepare(
            "DELETE FROM event_progress_outboxes WHERE outbox_id = ? AND status = 'dead'",
          )
          .bind(outboxId),
      );
      continue;
    }
    if (!isRecord(raw) || !isJsonValue(raw)) {
      throw new EventD1Failure("invalid-event-progress-dead-letter");
    }
    const original = isRecord(raw.originalRecord) ? raw.originalRecord : null;
    const eventId = original ? exactKey(original.eventId) : "";
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_progress_outboxes (
             outbox_id, event_id, status, run_at_ms, last_queued_at_ms,
             record_json
           ) VALUES (?, (
             SELECT event_id FROM event_records WHERE event_id = ?
           ), 'dead', NULL, ?, ?)
           ON CONFLICT (status, outbox_id) DO UPDATE SET
             event_id = excluded.event_id,
             status = 'dead',
             run_at_ms = NULL,
             last_queued_at_ms = excluded.last_queued_at_ms,
             record_json = excluded.record_json`,
        )
        .bind(
          outboxId,
          eventId || null,
          safeInteger(raw.deadAtMs),
          encodeJson(raw),
        ),
    );
  }

  for (const [eventId, raw] of profileProjectionUpdates) {
    if (Object.hasOwn(options.expectedRecords?.profileGame || {}, eventId)) {
      guards.push(
        recordJsonGuard(
          db,
          "event_profile_game_projection_outboxes",
          eventId,
          options.expectedRecords!.profileGame![eventId],
        ),
      );
    }
    if (raw === null) {
      mutations.push(
        db
          .prepare(
            "DELETE FROM event_profile_game_projection_outboxes WHERE event_id = ?",
          )
          .bind(eventId),
      );
      continue;
    }
    const record = validateProjectionOutbox("profile-game", eventId, raw);
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_profile_game_projection_outboxes (
             event_id, request_id, status, last_queued_at_ms, record_json
           ) VALUES (?, ?, 'pending', ?, ?)
           ON CONFLICT (event_id) DO UPDATE SET
             request_id = excluded.request_id,
             status = 'pending',
             last_queued_at_ms = excluded.last_queued_at_ms,
             record_json = excluded.record_json`,
        )
        .bind(
          eventId,
          record.requestId,
          record.lastQueuedAtMs,
          encodeJson(record.raw),
        ),
    );
  }

  for (const [eventId, raw] of telegramProjectionUpdates) {
    if (Object.hasOwn(options.expectedRecords?.telegram || {}, eventId)) {
      guards.push(
        recordJsonGuard(
          db,
          "event_telegram_projection_outboxes",
          eventId,
          options.expectedRecords!.telegram![eventId],
        ),
      );
    }
    if (raw === null) {
      mutations.push(
        db
          .prepare(
            "DELETE FROM event_telegram_projection_outboxes WHERE event_id = ?",
          )
          .bind(eventId),
      );
      continue;
    }
    const record = validateProjectionOutbox("telegram", eventId, raw);
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_telegram_projection_outboxes (
             event_id, request_id, status, first_queued_at_ms, updated_at_ms,
             record_json
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (event_id) DO UPDATE SET
             request_id = excluded.request_id,
             status = excluded.status,
             first_queued_at_ms = excluded.first_queued_at_ms,
             updated_at_ms = excluded.updated_at_ms,
             record_json = excluded.record_json`,
        )
        .bind(
          eventId,
          record.requestId,
          record.status,
          record.firstQueuedAtMs,
          record.updatedAtMs,
          encodeJson(record.raw),
        ),
    );
  }

  for (const [eventId, update] of telegramStateUpdates) {
    const current = telegramProjectionSnapshot
      ? telegramProjectionSnapshot.current
      : snapshots
        ? requiredMutationSnapshot(snapshots.telegram, eventId)
        : await readEventTelegramProjectionState(db, eventId);
    const currentRevision = current?.revision || 0;
    const expectedRevision =
      options.expectedTelegramStateRevisions?.[eventId] ?? currentRevision;
    if (expectedRevision !== currentRevision) throw new EventD1Conflict();
    guards.push(telegramStateRevisionGuard(db, eventId, expectedRevision));
    let generation = current?.generation || 0;
    let state = current?.state || {};
    if (update.generation !== undefined) {
      const increment = isRecord(update.generation)
        ? update.generation.increment
        : undefined;
      generation =
        increment === undefined
          ? safeInteger(update.generation)
          : generation + safeInteger(increment);
    }
    if (update.state !== undefined) {
      if (update.state === null) {
        mutations.push(
          db
            .prepare(
              "DELETE FROM event_telegram_projection_state WHERE event_id = ?",
            )
            .bind(eventId),
        );
        continue;
      }
      if (!isRecord(update.state) || !isJsonValue(update.state)) {
        throw new EventD1Failure("invalid-event-telegram-projection-state");
      }
      state = cloneJson(update.state);
    }
    mutations.push(
      db
        .prepare(
          `INSERT INTO event_telegram_projection_state (
             event_id, generation, revision, state_json, updated_at_ms
           ) VALUES (?, ?, 1, ?, ?)
           ON CONFLICT (event_id) DO UPDATE SET
             generation = excluded.generation,
             revision = event_telegram_projection_state.revision + 1,
             state_json = excluded.state_json,
             updated_at_ms = excluded.updated_at_ms`,
        )
        .bind(eventId, generation, encodeJson(state), nowMs),
    );
  }

  return { guards, mutations };
}
