import { getOwnerProfileIds } from "../../../functions/events/eventProjectionModel.js";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import type { GameplayRepository } from "./gameplayRepository.ts";
import { buildEventProfileGameProjectionOutboxUpdates } from "./profileGameProjectionOutbox.ts";
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
  updates: Record<string, unknown>,
): string[] {
  const eventIds = new Set<string>();
  for (const path of Object.keys(updates)) {
    const [root, eventId, field] = path.split("/");
    if (
      root === "events" &&
      eventId &&
      isSafeFirebaseKey(eventId) &&
      (field === undefined || PROFILE_GAME_EVENT_FIELDS.has(field))
    ) {
      eventIds.add(eventId);
    }
  }
  return Array.from(eventIds).sort();
}

export function createEventProfileGameProjectionRepository(
  env: Env,
  repository: GameplayRepository,
  dependencies: ProducerDependencies = {},
): GameplayRepository {
  const createRequestId =
    dependencies.createRequestId || (() => crypto.randomUUID());
  const enqueue =
    dependencies.enqueue ||
    ((task: EventProfileGameProjectionTask) =>
      env.PROFILE_GAME_PROJECTION_QUEUE.send(task));
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  return {
    ...repository,
    async patchRtdbRoot(updates, signal) {
      const eventIds = eventIdsFromProfileGameProjectionUpdates(updates);
      if (eventIds.length === 0) {
        await repository.patchRtdbRoot(updates, signal);
        return;
      }
      const previousEvents = await Promise.all(
        eventIds.map((eventId) =>
          repository.getRtdbPath(`events/${eventId}`, undefined, signal),
        ),
      );
      const timestamp = now();
      const tasks = eventIds.map((eventId) => ({
        kind: "event-profile-game-projection" as const,
        eventId,
        requestId: createRequestId(),
      }));
      const nextUpdates = { ...updates };
      for (let index = 0; index < tasks.length; index += 1) {
        const event = toRecord(previousEvents[index]);
        const participants = toRecord(event?.participants) || {};
        Object.assign(
          nextUpdates,
          buildEventProfileGameProjectionOutboxUpdates({
            cleanupOwnerProfileIds: getOwnerProfileIds(participants).filter(
              (profileId): profileId is string =>
                typeof profileId === "string" && profileId.length > 0,
            ),
            eventId: tasks[index].eventId,
            requestId: tasks[index].requestId,
            timestamp,
          }),
        );
      }
      await repository.patchRtdbRoot(nextUpdates, signal);
      const dispatch = async () => {
        const results = await Promise.allSettled(tasks.map(enqueue));
        for (let index = 0; index < results.length; index += 1) {
          if (results[index].status === "rejected") {
            logger.error(
              JSON.stringify({
                event: "event_profile_game_projection_enqueue_failed",
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
