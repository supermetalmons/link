import {
  type EventD1Connection,
  type EventMutationOptions,
  type EventWriteAdmission,
  type EventLeaseGuard,
  MAX_EVENT_TRANSACTION_ATTEMPTS,
  EventD1Conflict,
  type EventTransactionOptions,
  EventD1Failure,
  type EventOutboxRecord,
} from "./types.ts";
import type {
  TransactionDecision,
  TransactionResult,
} from "../../../../runtime/transactions.js";
import type { EventMutation } from "../../../../runtime/eventCommands.js";
import { commitEventMutationsInternal } from "./commit.ts";
import {
  readEventPrizeSelectionSnapshot,
  readStoredEventSnapshotIfChanged,
  readProfilePrizeAssignmentSnapshot,
  readEventProgressOutboxSnapshot,
  readEventProgressDeadOutbox,
  readEventProfileGameProjectionOutbox,
  readEventTelegramProjectionOutbox,
  readEventTelegramProjectionState,
} from "./reads.ts";
import type {
  EventPrizeAssignmentRecord,
  EventJsonRecord,
} from "../../../../runtime/eventReads.js";
import {
  cloneJson,
  decodeJson,
  safeInteger,
  validatePrizeSelection,
} from "./validation.ts";
import {
  eventWriteAdmissionGuard,
  eventLeaseGuard,
  eventMutationGuard,
  rethrowEventBatchFailure,
} from "./guards.ts";
import { runOptimisticTransaction } from "../optimisticTransaction.ts";

async function transactEventValue<T>(
  db: EventD1Connection,
  updater: (current: T | null) => TransactionDecision<T>,
  load: () => Promise<{
    value: T | null;
    mutation: (value: T | null) => EventMutation;
    options?: Partial<EventMutationOptions>;
  }>,
  options: {
    admission: EventWriteAdmission;
    eventLease?: EventLeaseGuard;
    signal?: AbortSignal;
    now?: () => number;
    allowStoredProfilePrizeAssignment?: boolean;
  },
): Promise<TransactionResult<T>> {
  return runOptimisticTransaction({
    maxAttempts: MAX_EVENT_TRANSACTION_ATTEMPTS,
    signal: options.signal,
    read: load,
    getValue: (loaded) => loaded.value,
    decide(value) {
      const decision = updater(value);
      options.signal?.throwIfAborted();
      return decision;
    },
    async write(loaded, value) {
      try {
        await commitEventMutationsInternal(db, [loaded.mutation(value)], {
          ...options,
          ...loaded.options,
        });
        return { applied: true, value };
      } catch (error) {
        if (error instanceof EventD1Conflict) {
          options.signal?.throwIfAborted();
          return { applied: false, value };
        }
        throw error;
      }
    },
    conflictError: () => new EventD1Conflict(),
  });
}

export function transactEventPrizeSelection(
  db: EventD1Connection,
  eventId: string,
  profileId: string,
  updater: (current: string | null) => TransactionDecision<string>,
  options: EventTransactionOptions,
) {
  return runOptimisticTransaction({
    maxAttempts: MAX_EVENT_TRANSACTION_ATTEMPTS,
    signal: options.signal,
    read: () => readEventPrizeSelectionSnapshot(db, eventId, profileId),
    getValue: (snapshot) => snapshot.value,
    decide(current) {
      const decision = updater(current);
      options.signal?.throwIfAborted();
      return decision;
    },
    async write(snapshot, value) {
      const nowMs = safeInteger((options.now || Date.now)());
      if (!snapshot.event) throw new EventD1Failure("event-not-found");
      const selection =
        value === null ? null : validatePrizeSelection(eventId, value);
      if (snapshot.event.pendingTransitionId)
        throw new EventD1Failure("event-transition-pending");
      const statements = [eventWriteAdmissionGuard(db, options.admission)];
      if (options.eventLease)
        statements.push(eventLeaseGuard(db, options.eventLease));
      statements.push(
        eventMutationGuard(db, eventId, snapshot.event),
        db
          .prepare(
            "UPDATE event_records SET revision = revision + 1 WHERE event_id = ?",
          )
          .bind(eventId),
      );
      if (selection !== snapshot.value) {
        statements.push(
          selection === null
            ? db
                .prepare(
                  "DELETE FROM event_prize_selections WHERE event_id = ? AND profile_id = ?",
                )
                .bind(eventId, profileId)
            : db
                .prepare(
                  `INSERT INTO event_prize_selections (
                     event_id, profile_id, prize_id, updated_at_ms
                   ) VALUES (?, ?, ?, ?)
                   ON CONFLICT (event_id, profile_id) DO UPDATE SET
                     prize_id = excluded.prize_id,
                     updated_at_ms = excluded.updated_at_ms`,
                )
                .bind(eventId, profileId, selection, nowMs),
        );
      }
      try {
        await db
          .batch(statements)
          .catch((error) => rethrowEventBatchFailure(db, error, options));
        return { applied: true, value: selection };
      } catch (error) {
        if (error instanceof EventD1Conflict) {
          options.signal?.throwIfAborted();
          return { applied: false, value: selection };
        }
        throw error;
      }
    },
    conflictError: () => new EventD1Conflict(),
  });
}

function transactProfileEventPrizeInternal(
  db: EventD1Connection,
  profileId: string,
  eventId: string,
  updater: (
    current: EventPrizeAssignmentRecord | null,
  ) => TransactionDecision<EventPrizeAssignmentRecord>,
  options: EventTransactionOptions & {
    allowStoredProfilePrizeAssignment?: boolean;
  },
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const snapshot = await readProfilePrizeAssignmentSnapshot(
        db,
        profileId,
        eventId,
      );
      return {
        value: cloneJson(snapshot.assignment),
        mutation: (
          value: EventPrizeAssignmentRecord | null,
        ): EventMutation => ({
          kind: "profile-prize",
          eventId,
          profileId,
          value,
        }),
        options: {
          profilePrizeSnapshot: snapshot,
          expectedProfilePrizeRevisions: { [profileId]: snapshot.revision },
        },
      };
    },
    options,
  );
}

export function transactProfileEventPrize(
  db: EventD1Connection,
  profileId: string,
  eventId: string,
  updater: (
    current: EventPrizeAssignmentRecord | null,
  ) => TransactionDecision<EventPrizeAssignmentRecord>,
  options: EventTransactionOptions,
) {
  return transactProfileEventPrizeInternal(
    db,
    profileId,
    eventId,
    updater,
    options,
  );
}

export function transactStoredProfileEventPrize(
  db: EventD1Connection,
  profileId: string,
  eventId: string,
  updater: (
    current: EventPrizeAssignmentRecord | null,
  ) => TransactionDecision<EventPrizeAssignmentRecord>,
  options: EventTransactionOptions & { eventLease: EventLeaseGuard },
) {
  if (!options.eventLease || options.eventLease.eventId !== eventId)
    throw new EventD1Failure("invalid-event-lease");
  return transactProfileEventPrizeInternal(db, profileId, eventId, updater, {
    ...options,
    allowStoredProfilePrizeAssignment: true,
  });
}

export function transactEventProgressOutbox(
  db: EventD1Connection,
  outboxId: string,
  updater: (
    current: EventOutboxRecord | null,
  ) => TransactionDecision<EventOutboxRecord>,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const snapshot = await readEventProgressOutboxSnapshot(db, outboxId);
      const value =
        snapshot.recordJson === null
          ? null
          : (decodeJson(snapshot.recordJson) as EventOutboxRecord);
      return {
        value,
        mutation: (value: EventOutboxRecord | null): EventMutation => ({
          kind: "progress-outbox",
          outboxId,
          value,
        }),
        options: { progressOutboxSnapshot: snapshot },
      };
    },
    options,
  );
}

export function transactEventProgressDeadOutbox(
  db: EventD1Connection,
  outboxId: string,
  updater: (
    current: EventOutboxRecord | null,
  ) => TransactionDecision<EventOutboxRecord>,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const value = await readEventProgressDeadOutbox(db, outboxId);
      return {
        value,
        mutation: (value: EventOutboxRecord | null): EventMutation => ({
          kind: "progress-dead",
          outboxId,
          value,
        }),
        options: { expectedRecords: { dead: { [outboxId]: value } } },
      };
    },
    options,
  );
}

export function transactEventProfileGameProjectionOutbox(
  db: EventD1Connection,
  eventId: string,
  updater: (
    current: EventOutboxRecord | null,
  ) => TransactionDecision<EventOutboxRecord>,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const value = await readEventProfileGameProjectionOutbox(db, eventId);
      return {
        value,
        mutation: (value: EventOutboxRecord | null): EventMutation => ({
          kind: "profile-game-outbox",
          eventId,
          value,
        }),
        options: { expectedRecords: { profileGame: { [eventId]: value } } },
      };
    },
    options,
  );
}

export function transactEventTelegramProjectionOutbox(
  db: EventD1Connection,
  eventId: string,
  updater: (
    current: EventOutboxRecord | null,
  ) => TransactionDecision<EventOutboxRecord>,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const value = await readEventTelegramProjectionOutbox(db, eventId);
      return {
        value,
        mutation: (value: EventOutboxRecord | null): EventMutation => ({
          kind: "telegram-outbox",
          eventId,
          value,
        }),
        options: { expectedRecords: { telegram: { [eventId]: value } } },
      };
    },
    options,
  );
}

export function transactEventTelegramProjectionState(
  db: EventD1Connection,
  eventId: string,
  updater: (
    current: EventOutboxRecord | null,
  ) => TransactionDecision<EventOutboxRecord>,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const current = await readEventTelegramProjectionState(db, eventId);
      return {
        value: cloneJson(current?.state || null),
        mutation: (value: EventOutboxRecord | null): EventMutation => ({
          kind: "telegram-state",
          eventId,
          value,
        }),
        options: {
          telegramProjectionSnapshot: { eventId, current },
          expectedTelegramStateRevisions: { [eventId]: current?.revision || 0 },
        },
      };
    },
    options,
  );
}

export function transactEventRecord(
  db: EventD1Connection,
  eventId: string,
  updater: (
    current: EventJsonRecord | null,
  ) => TransactionDecision<EventJsonRecord>,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const result = await readStoredEventSnapshotIfChanged(db, eventId);
      if (result.notModified) throw new EventD1Failure();
      const snapshot = result.snapshot;
      return {
        value: cloneJson(snapshot.event),
        mutation: (value: EventJsonRecord | null): EventMutation => ({
          kind: "event",
          eventId,
          value: value!,
        }),
        options: {
          eventSnapshot: snapshot,
          expectedEventRevisions: { [eventId]: snapshot.revision },
        },
      };
    },
    options,
  );
}

export function transactEventField<
  K extends import("../../../../runtime/eventCommands.js").EventField,
>(
  db: EventD1Connection,
  eventId: string,
  field: K,
  updater: (
    current:
      import("../../../../runtime/eventCommands.js").EventFieldValues[K] | null,
  ) => TransactionDecision<
    import("../../../../runtime/eventCommands.js").EventFieldValues[K]
  >,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const result = await readStoredEventSnapshotIfChanged(db, eventId);
      if (result.notModified) throw new EventD1Failure();
      const snapshot = result.snapshot;
      return {
        value: cloneJson(snapshot.event?.[field] ?? null) as
          | import("../../../../runtime/eventCommands.js").EventFieldValues[K]
          | null,
        mutation: (
          value:
            | import("../../../../runtime/eventCommands.js").EventFieldValues[K]
            | null,
        ): EventMutation =>
          ({ kind: "event-field", eventId, field, value }) as EventMutation,
        options: {
          eventSnapshot: snapshot,
          expectedEventRevisions: { [eventId]: snapshot.revision },
        },
      };
    },
    options,
  );
}

export function transactEventPrizeSelections(
  db: EventD1Connection,
  eventId: string,
  updater: (
    current: Record<string, string> | null,
  ) => TransactionDecision<Record<string, string>>,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const result = await readStoredEventSnapshotIfChanged(db, eventId);
      if (result.notModified) throw new EventD1Failure();
      const snapshot = result.snapshot;
      return {
        value: cloneJson(snapshot.prizeSelections),
        mutation: (value: Record<string, string> | null): EventMutation => ({
          kind: "prize-selections",
          eventId,
          value,
        }),
        options: {
          eventSnapshot: snapshot,
          expectedEventRevisions: { [eventId]: snapshot.revision },
        },
      };
    },
    options,
  );
}

export function transactEventTelegramProjectionGeneration(
  db: EventD1Connection,
  eventId: string,
  updater: (current: number | null) => TransactionDecision<number>,
  options: EventTransactionOptions,
) {
  return transactEventValue(
    db,
    updater,
    async () => {
      const current = await readEventTelegramProjectionState(db, eventId);
      return {
        value: current?.generation || 0,
        mutation: (value: number | null): EventMutation => ({
          kind: "telegram-generation",
          eventId,
          value: value!,
        }),
        options: {
          telegramProjectionSnapshot: { eventId, current },
          expectedTelegramStateRevisions: { [eventId]: current?.revision || 0 },
        },
      };
    },
    options,
  );
}
