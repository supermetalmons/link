import type {
  EventCommand,
  EventCommitPlan,
} from "../../../runtime/eventCommands.js";
import { STATE_FAILURE_MESSAGES } from "./stateCompatibility.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import type { EventTelegramProjectionTask } from "./telegramProjectionTasks.ts";
import type { PreparedEventMutation } from "./eventMutationCommit.ts";
import { EVENT_TELEGRAM_PROJECTION_SCHEMA_VERSION } from "./telegramProjectionOutbox.ts";

export { EVENT_TELEGRAM_PROJECTION_SCHEMA_VERSION } from "./telegramProjectionOutbox.ts";

type ProducerDependencies = {
  createRequestId?: () => string;
  enqueue?: (task: EventTelegramProjectionTask) => Promise<unknown>;
  logger?: Pick<Console, "error">;
  now?: () => number;
};

function eventIdsFromUpdates(updates: readonly EventCommand[]): string[] {
  return [
    ...new Set(
      updates.flatMap((command) =>
        [
          "event",
          "event-field",
          "event-participant",
          "event-disqualification",
          "event-round",
          "event-match-status",
        ].includes(command.kind) &&
        "eventId" in command &&
        isSafeRecordKey(command.eventId)
          ? [command.eventId]
          : [],
      ),
    ),
  ].sort();
}

export function buildEventTelegramProjectionOutbox(
  requestId: string,
  updatedAtMs: number,
): Record<string, unknown> {
  if (!isSafeRecordKey(requestId)) {
    throw new TypeError(STATE_FAILURE_MESSAGES.invalidRequestId);
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

export function prepareEventTelegramProjection(
  env: Env,
  updates: readonly EventCommand[],
  dependencies: ProducerDependencies = {},
): PreparedEventMutation | null {
  const createRequestId =
    dependencies.createRequestId || (() => crypto.randomUUID());
  const enqueue =
    dependencies.enqueue ||
    ((task: EventTelegramProjectionTask) =>
      env.TELEGRAM_PROJECTION_QUEUE.send(task));
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const eventIds = eventIdsFromUpdates(updates);
  if (eventIds.length === 0) return null;
  const updatedAtMs = now();
  const tasks = eventIds.map((eventId) => ({
    kind: "event-telegram-projection" as const,
    eventId,
    requestId: createRequestId(),
  }));
  const commands: EventCommitPlan = [];
  for (const task of tasks) {
    commands.push(
      {
        kind: "telegram-outbox",
        eventId: task.eventId,
        value: buildEventTelegramProjectionOutbox(task.requestId, updatedAtMs),
      },
      {
        kind: "telegram-generation",
        eventId: task.eventId,
        value: 1,
        increment: true,
      },
    );
  }
  return {
    commands,
    async dispatch() {
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
    },
  };
}

export { eventIdsFromUpdates };
