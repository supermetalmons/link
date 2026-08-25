import {
  EVENT_TELEGRAM_PROJECTION_GUARD_FIELD,
  EVENT_TELEGRAM_PROJECTION_LOCK_ROOT,
  EVENT_TELEGRAM_PROJECTION_ROOT,
  addEventTelegramProjectionGuard,
  buildEventTelegramDispatches,
  buildEventTelegramProjection,
  buildEventTelegramProjectionUpdates,
  isV2TelegramEvent,
  loadEndedMatchResults,
  splitEventTelegramProjectionUpdates,
} from "../../../functions/telegram/eventProjectionCore.js";
import { createEventLockManagerCore } from "../../../functions/events/lockManagerCore.js";
import type { FirebaseRtdbClient } from "./firebaseRtdb.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import type { RatingProjectionRepository } from "./gameplayRepository.ts";
import {
  EVENT_TELEGRAM_PROJECTION_OUTBOX_ROOT,
  EVENT_TELEGRAM_PROJECTION_SCHEMA_VERSION,
  getEventTelegramProjectionGenerationPath,
  getEventTelegramProjectionOutboxPath,
} from "./eventTelegramProjectionProducer.ts";
import type {
  EventTelegramProjectionTask,
  TelegramProjectionTask,
} from "./telegramProjectionTasks.ts";
import type { InitialTelegramDelivery } from "./telegramDeliveryTasks.ts";

const EVENT_TELEGRAM_PROJECTION_OWNER_UID = "event-telegram-projector";
const EVENT_PROJECTION_SWEEP_LIMIT = 100;

type EventOutbox = {
  firstQueuedAtMs: number;
  requestId: string;
  schemaVersion: number;
  status: string;
  updatedAtMs: number;
};

export type EventProjectionSweepCandidate = {
  task: EventTelegramProjectionTask;
  updatedAtMs: number;
};

type EventProjectionSweepEntry =
  | { kind: "candidate"; value: EventProjectionSweepCandidate }
  | { eventId: string; kind: "invalid" };

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asObject(value: unknown): Record<string, unknown> {
  return toRecord(value) || {};
}

export function parseEventProjectionOutbox(value: unknown): EventOutbox | null {
  const record = toRecord(value);
  const updatedAtMs = record?.updatedAtMs;
  const firstQueuedAtMs = record?.firstQueuedAtMs ?? updatedAtMs;
  return record?.schemaVersion === EVENT_TELEGRAM_PROJECTION_SCHEMA_VERSION &&
    record.status === "pending" &&
    typeof record.requestId === "string" &&
    isSafeFirebaseKey(record.requestId) &&
    typeof updatedAtMs === "number" &&
    Number.isSafeInteger(updatedAtMs) &&
    updatedAtMs >= 0 &&
    typeof firstQueuedAtMs === "number" &&
    Number.isSafeInteger(firstQueuedAtMs) &&
    firstQueuedAtMs >= 0
    ? {
        schemaVersion: EVENT_TELEGRAM_PROJECTION_SCHEMA_VERSION,
        status: "pending",
        requestId: record.requestId,
        firstQueuedAtMs,
        updatedAtMs,
      }
    : null;
}

async function settleEventOutbox(
  rtdb: FirebaseRtdbClient,
  task: EventTelegramProjectionTask,
): Promise<boolean> {
  const result = await rtdb.transactPath(
    getEventTelegramProjectionOutboxPath(task.eventId),
    (current) => {
      const outbox = parseEventProjectionOutbox(current);
      if (!outbox || outbox.requestId !== task.requestId) {
        return { commit: false, decision: "stale" };
      }
      return { value: null, decision: "cleared" };
    },
  );
  return result.committed;
}

function createProjectionLockManager(rtdb: FirebaseRtdbClient) {
  return createEventLockManagerCore({
    lockRoot: EVENT_TELEGRAM_PROJECTION_LOCK_ROOT,
    createLockId: () => crypto.randomUUID(),
    transactPath: rtdb.transactPath,
    logger: {
      error: (_message, error) => {
        console.error(
          JSON.stringify({
            event: "event_telegram_projection_lock_failure",
            code: error instanceof Error ? error.message : "unknown",
          }),
        );
      },
    },
  });
}

function readProjectionGeneration(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function persistedProjectionGeneration(value: unknown): number {
  const record = toRecord(value);
  const guard = toRecord(record?.[EVENT_TELEGRAM_PROJECTION_GUARD_FIELD]);
  return readProjectionGeneration(guard?.generation);
}

async function commitFencedProjectionUpdate(
  rtdb: FirebaseRtdbClient,
  path: string,
  value: unknown,
  generation: number,
): Promise<boolean> {
  const result = await rtdb.transactPath(path, (current) => {
    if (persistedProjectionGeneration(current) > generation) {
      return { commit: false, decision: "newer-projection" };
    }
    return { value, decision: "projection-committed" };
  });
  return result.committed;
}

export async function processEventProjectionTask(
  task: EventTelegramProjectionTask,
  rtdb: FirebaseRtdbClient,
  rating: RatingProjectionRepository,
  enqueueDelivery: (input: InitialTelegramDelivery) => Promise<unknown>,
  now: () => number,
): Promise<string> {
  const outbox = parseEventProjectionOutbox(
    await rtdb.getPath(getEventTelegramProjectionOutboxPath(task.eventId)),
  );
  if (!outbox || outbox.requestId !== task.requestId) {
    return "stale";
  }
  const lockManager = createProjectionLockManager(rtdb);
  const lockHandle = await lockManager.acquireEventLock(
    task.eventId,
    EVENT_TELEGRAM_PROJECTION_OWNER_UID,
  );
  if (!lockHandle) {
    throw new Error("event-telegram-lock-busy");
  }
  const stopHeartbeat = lockManager.startEventLockHeartbeat(lockHandle);
  try {
    const [eventData, rawState, rawGeneration] = await Promise.all([
      rtdb.getPath(`events/${task.eventId}`),
      rtdb.getPath(`${EVENT_TELEGRAM_PROJECTION_ROOT}/${task.eventId}`),
      rtdb.getPath(getEventTelegramProjectionGenerationPath(task.eventId)),
    ]);
    if (!isV2TelegramEvent(eventData)) {
      await settleEventOutbox(rtdb, task);
      return eventData === null ? "missing" : "not-v2";
    }
    const event = asObject(eventData);
    const state = asObject(rawState);
    const generation = readProjectionGeneration(rawGeneration);
    const endedMatchResults =
      event.announceOnTelegram === true &&
      event.status === "ended" &&
      state.endedAnnouncementArmed === true &&
      (typeof state.endedText !== "string" || state.endedText === "")
        ? await loadEndedMatchResults(eventData, {
            readRatingUpdate: (operationId) =>
              rating.readRatingUpdate(operationId),
          })
        : {};
    const projection = buildEventTelegramProjection({
      eventId: task.eventId,
      eventData,
      endedMatchResults,
      state: rawState,
      nowMs: now(),
    });
    if (projection.action !== "project") {
      await settleEventOutbox(rtdb, task);
      return projection.action;
    }
    const updates = addEventTelegramProjectionGuard({
      updates: buildEventTelegramProjectionUpdates({
        eventId: task.eventId,
        projection,
      }),
      guard: {
        ...lockManager.getEventLockGuard(lockHandle),
        generation,
      },
    });
    const { desiredUpdates, stateUpdates } =
      splitEventTelegramProjectionUpdates({
        eventId: task.eventId,
        updates,
      });
    const refreshLock = async () => {
      if (!(await lockManager.refreshEventLock(lockHandle))) {
        throw new Error("event-telegram-lock-lost");
      }
    };
    if (Object.keys(desiredUpdates).length > 0) {
      await refreshLock();
      const committedDesiredUpdates: Record<string, unknown> = {};
      for (const [path, value] of Object.entries(desiredUpdates)) {
        if (await commitFencedProjectionUpdate(rtdb, path, value, generation)) {
          committedDesiredUpdates[path] = value;
        }
      }
      const dispatches = buildEventTelegramDispatches({
        eventId: task.eventId,
        desiredUpdates: committedDesiredUpdates,
      });
      await Promise.all(
        dispatches.map((dispatch) =>
          enqueueDelivery({
            ...dispatch,
            producer: "event-projection",
          }),
        ),
      );
    }
    await refreshLock();
    const stateEntries = Object.entries(stateUpdates);
    const stateCommitted = await commitFencedProjectionUpdate(
      rtdb,
      stateEntries[0][0],
      stateEntries[0][1],
      generation,
    );
    await settleEventOutbox(rtdb, task);
    return stateCommitted ? "projected" : "superseded";
  } finally {
    stopHeartbeat();
    await lockManager.releaseEventLock(lockHandle);
  }
}

export function eventProjectionSweepEntries(
  value: unknown,
): EventProjectionSweepEntry[] {
  const records = toRecord(value) || {};
  return Object.entries(records).map(([eventId, raw]) => {
    const outbox = parseEventProjectionOutbox(raw);
    return outbox && isSafeFirebaseKey(eventId)
      ? {
          kind: "candidate" as const,
          value: {
            task: {
              kind: "event-telegram-projection" as const,
              eventId,
              requestId: outbox.requestId,
            },
            updatedAtMs: outbox.updatedAtMs,
          },
        }
      : { kind: "invalid" as const, eventId };
  });
}

export async function claimEventProjectionSweepCandidate(
  rtdb: FirebaseRtdbClient,
  candidate: EventProjectionSweepCandidate,
  nowMs: number,
): Promise<boolean> {
  const result = await rtdb.transactPath(
    getEventTelegramProjectionOutboxPath(candidate.task.eventId),
    (current) => {
      const outbox = parseEventProjectionOutbox(current);
      if (
        !outbox ||
        outbox.requestId !== candidate.task.requestId ||
        outbox.updatedAtMs !== candidate.updatedAtMs ||
        outbox.updatedAtMs > nowMs
      ) {
        return { commit: false, decision: "not-due" };
      }
      return {
        value: {
          ...asObject(current),
          firstQueuedAtMs: outbox.firstQueuedAtMs,
          updatedAtMs: nowMs,
        },
        decision: "claimed",
      };
    },
  );
  return result.committed;
}

async function markInvalidEventProjectionSweepEntry(
  rtdb: FirebaseRtdbClient,
  eventId: string,
  nowMs: number,
): Promise<void> {
  await rtdb.transactPath(
    `${EVENT_TELEGRAM_PROJECTION_OUTBOX_ROOT}/${eventId}`,
    (current) => {
      const record = toRecord(current);
      const updatedAtMs = record?.updatedAtMs;
      if (
        !record ||
        (parseEventProjectionOutbox(current) && isSafeFirebaseKey(eventId)) ||
        typeof updatedAtMs !== "number" ||
        !Number.isFinite(updatedAtMs) ||
        updatedAtMs > nowMs
      ) {
        return { commit: false, decision: "changed" };
      }
      return {
        value: {
          ...record,
          status: "dead",
          reason: "invalid-record",
          updatedAtMs: null,
          deadAtMs: nowMs,
        },
        decision: "dead",
      };
    },
  );
}

export async function sweepEventTelegramProjections(
  queue: Queue<TelegramProjectionTask>,
  rtdb: FirebaseRtdbClient,
  nowMs: number,
): Promise<number> {
  const value = await rtdb.getPath(EVENT_TELEGRAM_PROJECTION_OUTBOX_ROOT, {
    orderBy: "updatedAtMs",
    startAt: 0,
    endAt: nowMs,
    limitToFirst: EVENT_PROJECTION_SWEEP_LIMIT,
  });
  const entries = eventProjectionSweepEntries(value);
  const candidates = entries.flatMap((entry) =>
    entry.kind === "candidate" ? [entry.value] : [],
  );
  const invalidEventIds = entries.flatMap((entry) =>
    entry.kind === "invalid" ? [entry.eventId] : [],
  );
  const failures: Error[] = [];
  for (const eventId of invalidEventIds) {
    try {
      await markInvalidEventProjectionSweepEntry(rtdb, eventId, nowMs);
    } catch (error) {
      failures.push(
        error instanceof Error ? error : new Error("invalid-record-failed"),
      );
    }
  }
  const tasks: EventTelegramProjectionTask[] = [];
  for (const candidate of candidates) {
    try {
      if (await claimEventProjectionSweepCandidate(rtdb, candidate, nowMs)) {
        tasks.push(candidate.task);
      }
    } catch (error) {
      failures.push(
        error instanceof Error ? error : new Error("event-claim-failed"),
      );
    }
  }
  for (let index = 0; index < tasks.length; index += 100) {
    await queue.sendBatch(
      tasks.slice(index, index + 100).map((task) => ({ body: task })),
    );
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "event-projection-sweep-failed");
  }
  return tasks.length;
}

export { EVENT_PROJECTION_SWEEP_LIMIT, settleEventOutbox };
