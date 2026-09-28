import type {
  EventCommand,
  EventCommitPlan,
} from "../../../runtime/eventCommands.js";
import { getOwnerProfileIds } from "../../../runtime/events/eventProjectionModel.js";
import { isSafeRecordKey } from "./recordKeys.ts";
import type { EventGameplayRepository } from "./eventRepository.ts";
import {
  commitPreparedEventMutation,
  createEventMutationReads,
  type EventMutationReads,
  type PreparedEventMutation,
} from "./eventMutationCommit.ts";
import type { EventProfileGameProjectionTask } from "./profileGameProjectionTasks.ts";

const PROFILE_GAME_EVENT_FIELDS = new Set([
  "createdAtMs",
  "endedAtMs",
  "participants",
  "startAtMs",
  "startedAtMs",
  "status",
  "winnerDisplayName",
]);

type ProducerDependencies = {
  createRequestId?: () => string;
  enqueue?: (task: EventProfileGameProjectionTask) => Promise<unknown>;
  logger?: Pick<Console, "error">;
  now?: () => number;
  schedule?: (work: Promise<void>) => void;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function eventIdsFromProfileGameProjectionUpdates(
  updates: readonly EventCommand[],
): string[] {
  return [
    ...new Set(
      updates.flatMap((command) =>
        (command.kind === "event" ||
          (command.kind === "event-field" &&
            PROFILE_GAME_EVENT_FIELDS.has(command.field)) ||
          command.kind === "event-participant") &&
        "eventId" in command &&
        isSafeRecordKey(command.eventId)
          ? [command.eventId]
          : [],
      ),
    ),
  ].sort();
}

export async function prepareEventProfileGameProjection(
  env: Env,
  updates: readonly EventCommand[],
  reads: Pick<EventMutationReads, "readEvent">,
  dependencies: ProducerDependencies = {},
): Promise<PreparedEventMutation | null> {
  const createRequestId =
    dependencies.createRequestId || (() => crypto.randomUUID());
  const enqueue =
    dependencies.enqueue ||
    ((task: EventProfileGameProjectionTask) =>
      env.EVENT_PROFILE_GAME_PROJECTION_QUEUE.send(task));
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const eventIds = eventIdsFromProfileGameProjectionUpdates(updates);
  if (eventIds.length === 0) return null;
  const previousEvents = await Promise.all(
    eventIds.map((eventId) => reads.readEvent(eventId)),
  );
  const timestamp = now();
  const tasks = eventIds.map((eventId) => ({
    kind: "event-profile-game-projection" as const,
    eventId,
    requestId: createRequestId(),
  }));
  const commands: EventCommitPlan = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const event = toRecord(previousEvents[index]);
    const participants = toRecord(event?.participants) || {};
    const eventId = tasks[index].eventId;
    commands.push(
      {
        kind: "profile-game-outbox-field",
        eventId,
        field: "schemaVersion",
        value: 1,
      },
      {
        kind: "profile-game-outbox-field",
        eventId,
        field: "status",
        value: "pending",
      },
      {
        kind: "profile-game-outbox-field",
        eventId,
        field: "requestId",
        value: tasks[index].requestId,
      },
      {
        kind: "profile-game-outbox-field",
        eventId,
        field: "lastQueuedAtMs",
        value: timestamp,
      },
      {
        kind: "profile-game-outbox-field",
        eventId,
        field: "reason",
        value: null,
      },
      {
        kind: "profile-game-outbox-field",
        eventId,
        field: "deadAtMs",
        value: null,
      },
    );
    for (const profileId of new Set(getOwnerProfileIds(participants))) {
      if (typeof profileId !== "string" || profileId.length === 0) continue;
      if (!isSafeRecordKey(profileId))
        throw new TypeError("invalid event projection cleanup profile id");
      commands.push({
        kind: "profile-game-outbox-cleanup",
        eventId,
        profileId,
        value: true,
      });
    }
  }
  return {
    commands,
    async dispatch() {
      const results = await Promise.allSettled(tasks.map(enqueue));
      for (let index = 0; index < results.length; index += 1) {
        if (results[index].status === "rejected") {
          logger.error(
            JSON.stringify({
              event: "event_profile_game_projection_enqueue_failed",
              kind: tasks[index].kind,
              eventId: tasks[index].eventId,
              requestId: tasks[index].requestId,
              outcome: "failed",
            }),
          );
        }
      }
    },
  };
}

export function createEventProfileGameProjectionRepository(
  env: Env,
  repository: EventGameplayRepository,
  dependencies: ProducerDependencies = {},
): EventGameplayRepository {
  return {
    ...repository,
    async commitEventPlan(updates, signal, options) {
      const prepared = await prepareEventProfileGameProjection(
        env,
        updates,
        createEventMutationReads(repository, signal),
        dependencies,
      );
      await commitPreparedEventMutation(
        repository,
        updates,
        [prepared],
        signal,
        dependencies.schedule,
        options,
      );
    },
  };
}
