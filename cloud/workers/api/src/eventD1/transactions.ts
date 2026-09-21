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
import { cloneJson, decodeJson } from "./validation.ts";

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
  for (let attempt = 0; attempt < MAX_EVENT_TRANSACTION_ATTEMPTS; attempt++) {
    options.signal?.throwIfAborted();
    const loaded = await load();
    options.signal?.throwIfAborted();
    const decision = updater(loaded.value);
    options.signal?.throwIfAborted();
    if ("commit" in decision)
      return {
        committed: false,
        decision: decision.decision,
        value: loaded.value,
      };
    try {
      await commitEventMutationsInternal(
        db,
        [loaded.mutation(decision.value)],
        { ...options, ...loaded.options },
      );
      return {
        committed: true,
        decision: decision.decision,
        value: decision.value,
      };
    } catch (error) {
      if (error instanceof EventD1Conflict) {
        options.signal?.throwIfAborted();
        continue;
      }
      throw error;
    }
  }
  throw new EventD1Conflict();
}

export function transactEventPrizeSelection(
  db: EventD1Connection,
  eventId: string,
  profileId: string,
  updater: (current: string | null) => TransactionDecision<string>,
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
        value: snapshot.prizeSelections[profileId] ?? null,
        mutation: (value: string | null): EventMutation => ({
          kind: "prize-selection",
          eventId,
          profileId,
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
