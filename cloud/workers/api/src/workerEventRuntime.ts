import type { EventRuntimeStore } from "../../../runtime/eventCommands.js";
import { createEventRuntime } from "../../../runtime/events.js";
import { createEventLockManagerCore } from "../../../runtime/events/lockManagerCore.js";
import { createD1EventPrizeWithdrawalReader } from "./eventPrizeWithdrawalD1.ts";
import type { EventGameplayRepository } from "./eventRepository.ts";
import {
  readGameplayMatchPair,
  readGameplayMatchPairs,
} from "./gameplayMatchReads.ts";
import { requireProfileOwnershipSnapshot } from "./profileOwnership.ts";

type RuntimeDependencies = Parameters<typeof createEventRuntime>[0];

type WorkerEventRuntimeOptions = {
  repository: EventGameplayRepository;
  signal: AbortSignal;
  withdrawalDb: D1Database;
  enqueueEventProgressTask: RuntimeDependencies["enqueueEventProgressTask"];
  lockFailureEvent: string;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

function secureRandom(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] / 0x1_0000_0000;
}

export function createEventRuntimeStore(
  repository: EventGameplayRepository,
  signal?: AbortSignal,
): EventRuntimeStore {
  return {
    ...repository,
    readEvent: (id) => repository.readEvent(id, signal),
    readEventPrizeSelections: (id) =>
      repository.readEventPrizeSelections(id, signal),
    readEventSnapshot: (id) => repository.readEventSnapshot(id, signal),
    commitEventPlan: (plan) => repository.commitEventPlan(plan, signal),
    transactEventSyncThrottle: (id, updater) =>
      repository.transactEventSyncThrottle(id, updater, signal),
    transactProfileEventPrize: (profileId, eventId, updater) =>
      repository.transactProfileEventPrize(profileId, eventId, updater, signal),
  };
}

export function createWorkerEventRuntime({
  repository,
  signal,
  withdrawalDb,
  enqueueEventProgressTask,
  lockFailureEvent,
  now,
  random = secureRandom,
  sleep = (milliseconds) => scheduler.wait(milliseconds, { signal }),
}: WorkerEventRuntimeOptions): ReturnType<typeof createEventRuntime> {
  const lockManager = createEventLockManagerCore({
    createLockId: () => crypto.randomUUID(),
    transactEventLease: (key, updater) =>
      repository.transactEventLease(key, updater, signal),
    releaseTransactEventLease: (key, updater) =>
      repository.transactEventLease(key, updater),
    sleep,
    logger: {
      error: (_message, error) => {
        console.error(
          JSON.stringify({
            event: lockFailureEvent,
            kind: error instanceof Error ? error.name : typeof error,
          }),
        );
      },
    },
  });
  return createEventRuntime({
    state: createEventRuntimeStore(repository, signal),
    readMatchPair: (input) => readGameplayMatchPair(repository, input, signal),
    readMatchPairs: (inputs) =>
      readGameplayMatchPairs(repository, inputs, signal),
    enqueueEventProgressTask,
    eventLockManager: lockManager,
    readProfileOwnershipSnapshot: (query) =>
      requireProfileOwnershipSnapshot(repository, query),
    readEventPrizeWithdrawals: createD1EventPrizeWithdrawalReader(withdrawalDb),
    now,
    random,
    sleep,
  });
}
