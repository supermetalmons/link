import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import { firebaseRtdbIncrement } from "./firebaseRtdb.ts";
import type { GameplayRepository } from "./gameplayRepository.ts";
import type { EventTelegramProjectionTask } from "./telegramProjectionTasks.ts";

export const EVENT_TELEGRAM_PROJECTION_OUTBOX_ROOT =
  "telegramProjectionOutbox/event";
export const EVENT_TELEGRAM_PROJECTION_GENERATION_ROOT =
  "eventTelegramProjectionGenerations";
export const EVENT_TELEGRAM_PROJECTION_SCHEMA_VERSION = 1;

type ProducerDependencies = {
  createRequestId?: () => string;
  enqueue?: (task: EventTelegramProjectionTask) => Promise<unknown>;
  logger?: Pick<Console, "error">;
  now?: () => number;
  schedule?: (work: Promise<void>) => void;
};

function eventIdsFromUpdates(updates: Record<string, unknown>): string[] {
  const eventIds = new Set<string>();
  for (const path of Object.keys(updates)) {
    const [root, eventId] = path.split("/");
    if (root === "events" && eventId && isSafeFirebaseKey(eventId)) {
      eventIds.add(eventId);
    }
  }
  return Array.from(eventIds).sort();
}

export function getEventTelegramProjectionOutboxPath(eventId: string): string {
  if (!isSafeFirebaseKey(eventId)) {
    throw new TypeError("eventId must be a safe Firebase key");
  }
  return `${EVENT_TELEGRAM_PROJECTION_OUTBOX_ROOT}/${eventId}`;
}

export function getEventTelegramProjectionGenerationPath(
  eventId: string,
): string {
  if (!isSafeFirebaseKey(eventId)) {
    throw new TypeError("eventId must be a safe Firebase key");
  }
  return `${EVENT_TELEGRAM_PROJECTION_GENERATION_ROOT}/${eventId}`;
}

export function buildEventTelegramProjectionOutbox(
  requestId: string,
  updatedAtMs: number,
): Record<string, unknown> {
  if (!isSafeFirebaseKey(requestId)) {
    throw new TypeError("requestId must be a safe Firebase key");
  }
  if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) {
    throw new TypeError("updatedAtMs must be a non-negative integer");
  }
  return {
    schemaVersion: EVENT_TELEGRAM_PROJECTION_SCHEMA_VERSION,
    status: "pending",
    requestId,
    firstQueuedAtMs: updatedAtMs,
    updatedAtMs,
  };
}

export function createEventTelegramProjectionRepository(
  env: Env,
  repository: GameplayRepository,
  dependencies: ProducerDependencies = {},
): GameplayRepository {
  const createRequestId =
    dependencies.createRequestId || (() => crypto.randomUUID());
  const enqueue =
    dependencies.enqueue ||
    ((task: EventTelegramProjectionTask) =>
      env.TELEGRAM_PROJECTION_QUEUE.send(task));
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  return {
    ...repository,
    async patchRtdbRoot(updates, signal) {
      const eventIds = eventIdsFromUpdates(updates);
      if (eventIds.length === 0) {
        await repository.patchRtdbRoot(updates, signal);
        return;
      }
      const updatedAtMs = now();
      const tasks = eventIds.map((eventId) => ({
        kind: "event-telegram-projection" as const,
        eventId,
        requestId: createRequestId(),
      }));
      const nextUpdates = { ...updates };
      for (const task of tasks) {
        nextUpdates[getEventTelegramProjectionOutboxPath(task.eventId)] =
          buildEventTelegramProjectionOutbox(task.requestId, updatedAtMs);
        nextUpdates[getEventTelegramProjectionGenerationPath(task.eventId)] =
          firebaseRtdbIncrement(1);
      }
      await repository.patchRtdbRoot(nextUpdates, signal);
      const dispatch = async () => {
        const results = await Promise.allSettled(tasks.map(enqueue));
        for (let index = 0; index < results.length; index += 1) {
          if (results[index].status === "rejected") {
            logger.error(
              JSON.stringify({
                event: "event_telegram_projection_enqueue_failed",
                eventId: tasks[index].eventId,
              }),
            );
          }
        }
      };
      const work = dispatch();
      if (dependencies.schedule) {
        dependencies.schedule(work);
        return;
      }
      await work;
    },
  };
}

export { eventIdsFromUpdates };
