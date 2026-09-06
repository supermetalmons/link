import {
  EVENT_PRIZE_ANNOUNCEMENT_LEAD_MS,
  isEventPrizeAnnouncementEvent,
} from "../../../functions/telegram/eventPrizeAnnouncement.js";
import {
  buildEventProgressPlan,
  ensureEventProgressWorkflow,
  parseEventProgressOutbox,
  type EventProgressPlan,
} from "./eventProgress.ts";
import type { GameplayRepository } from "./gameplayRepository.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";

export const EVENT_PRIZE_ANNOUNCEMENT_REASON = "event-prize-announcement";
const SCHEDULE_FIELDS = new Set(["isSundayMons", "startAtMs", "status"]);

type ScheduleRepository = Pick<
  GameplayRepository,
  "getRtdbPath" | "patchRtdbRoot"
>;

type ScheduleDependencies = {
  enqueue?: (plan: EventProgressPlan) => Promise<void>;
  logger?: Pick<Console, "error">;
  now?: () => number;
  schedule?: (work: Promise<void>) => void;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function buildEventPrizeAnnouncementPlan(
  eventId: string,
  event: unknown,
  nowMs: number,
): Promise<EventProgressPlan | null> {
  if (
    !isSafeFirebaseKey(eventId) ||
    !isEventPrizeAnnouncementEvent(eventId, event)
  ) {
    return null;
  }
  const startAtMs = toRecord(event)?.startAtMs;
  if (typeof startAtMs !== "number") return null;
  const runAtMs = startAtMs - EVENT_PRIZE_ANNOUNCEMENT_LEAD_MS;
  if (runAtMs < 0 || nowMs > runAtMs) return null;
  return buildEventProgressPlan(
    {
      eventId,
      sourceKey: `prizes:${eventId}:${startAtMs}`,
      reason: EVENT_PRIZE_ANNOUNCEMENT_REASON,
      runAtMs,
    },
    nowMs,
  );
}

async function preserveSchedule(
  repository: ScheduleRepository,
  plan: EventProgressPlan,
  signal?: AbortSignal,
): Promise<EventProgressPlan> {
  const existing = await parseEventProgressOutbox(
    plan.outboxId,
    await repository.getRtdbPath(
      `eventProgressOutbox/${plan.outboxId}`,
      undefined,
      signal,
    ),
  );
  return existing || plan;
}

export async function scheduleEventPrizeAnnouncement(
  env: Env,
  repository: ScheduleRepository,
  eventId: string,
  event: unknown,
  nowMs: number,
): Promise<void> {
  const candidate = await buildEventPrizeAnnouncementPlan(
    eventId,
    event,
    nowMs,
  );
  if (!candidate) return;
  const plan = await preserveSchedule(repository, candidate);
  await repository.patchRtdbRoot({
    [`eventProgressOutbox/${plan.outboxId}`]: plan.outbox,
  });
  await ensureEventProgressWorkflow(env.EVENT_PROGRESS_WORKFLOW, plan);
}

export function createEventPrizeAnnouncementScheduleRepository(
  env: Env,
  repository: GameplayRepository,
  dependencies: ScheduleDependencies = {},
): GameplayRepository {
  const now = dependencies.now || Date.now;
  const enqueue =
    dependencies.enqueue ||
    ((plan: EventProgressPlan) =>
      ensureEventProgressWorkflow(env.EVENT_PROGRESS_WORKFLOW, plan));
  const logger = dependencies.logger || console;
  return {
    ...repository,
    async patchRtdbRoot(updates, signal) {
      const eventIds = new Set<string>();
      for (const path of Object.keys(updates)) {
        const [root, eventId, field, ...nested] = path.split("/");
        if (
          root === "events" &&
          eventId &&
          isSafeFirebaseKey(eventId) &&
          nested.length === 0 &&
          (field === undefined || SCHEDULE_FIELDS.has(field))
        ) {
          eventIds.add(eventId);
        }
      }
      const plans: EventProgressPlan[] = [];
      const nextUpdates = { ...updates };
      for (const eventId of eventIds) {
        const path = `events/${eventId}`;
        const event = toRecord(
          Object.hasOwn(updates, path)
            ? updates[path]
            : await repository.getRtdbPath(path, undefined, signal),
        );
        if (!event) continue;
        const nextEvent = { ...event };
        for (const field of SCHEDULE_FIELDS) {
          if (Object.hasOwn(updates, `${path}/${field}`)) {
            nextEvent[field] = updates[`${path}/${field}`];
          }
        }
        const candidate = await buildEventPrizeAnnouncementPlan(
          eventId,
          nextEvent,
          now(),
        );
        if (!candidate) continue;
        const plan = await preserveSchedule(repository, candidate, signal);
        nextUpdates[`eventProgressOutbox/${plan.outboxId}`] = plan.outbox;
        plans.push(plan);
      }
      await repository.patchRtdbRoot(nextUpdates, signal);
      if (plans.length === 0) return;
      const dispatch = async () => {
        const results = await Promise.allSettled(plans.map(enqueue));
        results.forEach((result, index) => {
          if (result.status === "rejected") {
            logger.error(
              JSON.stringify({
                event: "event_prize_announcement_enqueue_failed",
                eventId: plans[index].params.eventId,
              }),
            );
          }
        });
      };
      const work = dispatch();
      if (dependencies.schedule) {
        dependencies.schedule(work);
      } else {
        await work;
      }
    },
  };
}
