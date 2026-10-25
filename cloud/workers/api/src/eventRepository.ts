import type {
  EventProgressDocument,
  EventProgressRecordKind,
} from "../../../runtime/eventProgressRecords.js";
import type {
  TransactionDecision,
  TransactionResult,
} from "../../../runtime/transactions.js";
import * as eventD1 from "./eventD1.ts";
import type { EventLeaseKey } from "../../../runtime/eventLeases.js";
import type {
  EventProgressOutboxWriter,
  EventStore,
} from "./eventStoreContracts.ts";
import type { MatchStatePort } from "./repositoryContracts.ts";
import { createEventReadRepository } from "./eventReadRepository.ts";
import { createEventOutboxReadRepository } from "./eventOutboxReadRepository.ts";
import { createMatchStateSource } from "./matchStateSource.ts";
import { withEventWriteAdmission } from "./eventWriteAdmission.ts";
import { commitEventMutations, type EventWriteAdmission } from "./eventD1.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import {
  prepareCreatedMatchPresentations,
  type PrepareMatchPresentations,
} from "./matchPresentationRegistry.ts";
import { createEventTransitionCoordinator } from "./eventTransitionCoordinator.ts";
import { transactProfileEventPrizeWithAdmission } from "./eventPrizeRepository.ts";

export type EventGameplayRepository = GameplayRepository & EventStore;
export type EventStateRepository = MatchStatePort & EventStore;
type EventRepositoryOptions = {
  schedule?: (work: Promise<void>) => void;
};
export type AuthRecoveryPrizeStore = Pick<
  EventStore,
  | "readProfileEventPrizeAssignment"
  | "listProfileEventPrizeAssignments"
  | "transactEventLease"
  | "transactStoredProfileEventPrizeWithEventLease"
>;

export function createEventProgressOutboxWriter(
  db: D1Database,
): EventProgressOutboxWriter {
  return {
    putEventProgressOutbox: (outboxId, record) =>
      withEventWriteAdmission(
        db,
        { kind: "mutation", context: "event-root-patch" },
        async (admission) => {
          await commitEventMutations(
            db,
            [{ kind: "progress-outbox", outboxId, value: record }],
            { admission },
          );
        },
      ),
  };
}

function createEventRawClient(env: Env): MatchStatePort {
  return createMatchStateSource(env);
}

export async function recoverEventTransitionIntents(
  env: Env,
  limit = 100,
  raw: MatchStatePort = createEventRawClient(env),
  prepareMatchPresentations: PrepareMatchPresentations = (creations) =>
    prepareCreatedMatchPresentations(env, creations),
): Promise<number> {
  return createEventTransitionCoordinator({
    env,
    matchState: raw,
    prepareMatchPresentations,
  }).recoverPendingIntents(limit);
}

export function createEventGameplayRepository(
  env: Env,
  base: GameplayRepository = createGameplayRepository(env),
  options: EventRepositoryOptions = {},
): EventGameplayRepository {
  return {
    ...base,
    ...createEventStateRepository(env, base, base, undefined, options),
  };
}
function leaseStorageKey(key: EventLeaseKey): string {
  switch (key.kind) {
    case "event":
      return key.id;
    case "telegram-projection":
      return `telegram:${key.id}`;
    case "profile-game-projection":
      return `profile-game:${key.id}`;
    case "transition":
      return `transition:${key.id}`;
  }
}
type EventProgressTransaction<Kind extends EventProgressRecordKind> = (
  id: string,
  updater: (
    current: EventProgressDocument<Kind> | null,
  ) => TransactionDecision<EventProgressDocument<Kind>>,
  signal?: AbortSignal,
) => Promise<TransactionResult<EventProgressDocument<Kind>>>;
type EventStoreImplementation = EventStore & {
  transactEventProgressOutbox: EventProgressTransaction<"pending">;
  transactEventProgressDeadOutbox: EventProgressTransaction<"dead">;
};
function createEventStore(
  db: D1Database,
  commit: EventStore["commitEventPlan"],
): EventStoreImplementation {
  const admit = <T>(work: (admission: EventWriteAdmission) => Promise<T>) =>
    withEventWriteAdmission(
      db,
      { kind: "mutation", context: "event-path-transaction" },
      work,
    );
  const read = <T>(work: () => Promise<T>, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    return work();
  };
  return {
    ...createEventReadRepository(db),
    ...createEventOutboxReadRepository(db),
    commitEventPlan: commit,
    putEventProgressOutbox: (outboxId, record, signal) =>
      commit([{ kind: "progress-outbox", outboxId, value: record }], signal),
    transactEventLease: (key, updater, signal) => {
      signal?.throwIfAborted();
      return admit((admission) =>
        eventD1.transactEventLease(db, leaseStorageKey(key), updater, {
          admission,
        }),
      );
    },
    transactEventSyncThrottle: (eventId, updater, signal) => {
      signal?.throwIfAborted();
      return admit((admission) =>
        eventD1.transactEventSyncThrottle(db, eventId, updater, { admission }),
      );
    },
    transactEventPrizeSelection: (eventId, profileId, updater, signal) =>
      admit((admission) =>
        eventD1.transactEventPrizeSelection(db, eventId, profileId, updater, {
          admission,
          signal,
        }),
      ),
    transactProfileEventPrize: (profileId, eventId, updater, signal) =>
      transactProfileEventPrizeWithAdmission(
        db,
        profileId,
        eventId,
        updater,
        signal,
      ),
    transactStoredProfileEventPrizeWithEventLease: (
      profileId,
      eventId,
      updater,
      guard,
      signal,
    ) => {
      if (guard.lockRoot !== "eventLocks" || guard.eventId !== eventId)
        throw new Error("event-lock-guard-path-unsupported");
      return admit((admission) =>
        eventD1.transactStoredProfileEventPrize(
          db,
          profileId,
          eventId,
          updater,
          {
            admission,
            signal,
            eventLease: guard,
          },
        ),
      );
    },
    readEventProgressOutbox: (id, signal) =>
      read(() => eventD1.readEventProgressOutbox(db, id), signal),
    readEventProfileGameProjectionOutbox: (id, signal) =>
      read(() => eventD1.readEventProfileGameProjectionOutbox(db, id), signal),
    readEventTelegramProjectionOutbox: (id, signal) =>
      read(() => eventD1.readEventTelegramProjectionOutbox(db, id), signal),
    readEventTelegramProjectionState: (id, signal) =>
      read(() => eventD1.readEventTelegramProjectionState(db, id), signal),
    transactEventProgressOutbox: (id, updater, signal) =>
      admit((admission) =>
        eventD1.transactEventProgressOutbox(db, id, updater, {
          admission,
          signal,
        }),
      ),
    transactEventProgressDeadOutbox: (id, updater, signal) =>
      admit((admission) =>
        eventD1.transactEventProgressDeadOutbox(db, id, updater, {
          admission,
          signal,
        }),
      ),
    claimEventProfileGameProjectionOutbox: (
      id,
      requestId,
      expected,
      nowMs,
      signal,
    ) =>
      admit((admission) =>
        eventD1.claimEventProfileGameProjectionOutbox(
          db,
          id,
          requestId,
          expected,
          nowMs,
          { admission, signal },
        ),
      ),
    acknowledgeEventProfileGameProjectionOutbox: (id, requestId, signal) =>
      admit((admission) =>
        eventD1.acknowledgeEventProfileGameProjectionOutbox(db, id, requestId, {
          admission,
          signal,
        }),
      ),
    claimEventTelegramProjectionOutbox: (
      id,
      requestId,
      expected,
      nowMs,
      signal,
    ) =>
      admit((admission) =>
        eventD1.claimEventTelegramProjectionOutbox(
          db,
          id,
          requestId,
          expected,
          nowMs,
          { admission, signal },
        ),
      ),
    acknowledgeEventTelegramProjectionOutbox: (id, requestId, signal) =>
      admit((admission) =>
        eventD1.acknowledgeEventTelegramProjectionOutbox(db, id, requestId, {
          admission,
          signal,
        }),
      ),
    transactEventTelegramProjectionState: (id, updater, signal) =>
      admit((admission) =>
        eventD1.transactEventTelegramProjectionState(db, id, updater, {
          admission,
          signal,
        }),
      ),
  };
}
export function createD1AuthRecoveryPrizeStore(
  db: D1Database,
): AuthRecoveryPrizeStore {
  const store = createEventStore(db, async () => {
    throw new Error("auth-recovery-prize-path-unsupported");
  });
  return {
    readProfileEventPrizeAssignment: store.readProfileEventPrizeAssignment,
    listProfileEventPrizeAssignments: store.listProfileEventPrizeAssignments,
    transactEventLease: (key, updater, signal) => {
      if (key.kind !== "event")
        return Promise.reject(
          new Error("auth-recovery-prize-path-unsupported"),
        );
      return store.transactEventLease(key, updater, signal);
    },
    transactStoredProfileEventPrizeWithEventLease:
      store.transactStoredProfileEventPrizeWithEventLease,
  };
}
export function createEventStateRepository(
  env: Env,
  base: MatchStatePort = createEventRawClient(env),
  raw: MatchStatePort = base,
  prepareMatchPresentations: PrepareMatchPresentations = (creations) =>
    prepareCreatedMatchPresentations(env, creations),
  options: EventRepositoryOptions = {},
): EventStateRepository {
  const transitions = createEventTransitionCoordinator({
    env,
    matchState: raw,
    prepareMatchPresentations,
    schedule: options.schedule,
  });
  return {
    ...base,
    ...createEventStore(env.EVENT_DB, transitions.commitEventPlan),
  };
}
