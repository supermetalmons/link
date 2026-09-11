import {
  EVENT_ANNOUNCEMENT_KINDS,
  EVENT_ANNOUNCEMENT_SPECS,
  type EventAnnouncementKind,
} from "./eventAnnouncementKinds.ts";
import {
  buildEventProgressPlan,
  ensureEventProgressWorkflow,
  parseEventProgressOutbox,
  type EventProgressPlan,
} from "./eventProgress.ts";
import type { GameplayRepository } from "./gameplayRepository.ts";
import { isSafeRecordKey } from "./recordKeys.ts";

export const EVENT_PRIZE_ANNOUNCEMENT_REASON =
  EVENT_ANNOUNCEMENT_SPECS.prizes.reason;
export const SUNDAY_MONS_REMINDER_REASON =
  EVENT_ANNOUNCEMENT_SPECS.reminder.reason;
const SCHEDULE_FIELDS = new Set(["isSundayMons", "startAtMs", "status"]);

type ScheduleRepository = Pick<
  GameplayRepository,
  "getStatePath" | "patchStateRoot"
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

export async function buildEventAnnouncementPlan(
  eventId: string,
  event: unknown,
  nowMs: number,
  kind: EventAnnouncementKind,
): Promise<EventProgressPlan | null> {
  const spec = EVENT_ANNOUNCEMENT_SPECS[kind];
  if (!isSafeRecordKey(eventId) || !spec.isEligible(eventId, event)) {
    return null;
  }
  const startAtMs = toRecord(event)?.startAtMs;
  if (typeof startAtMs !== "number") return null;
  const runAtMs = startAtMs - spec.leadMs;
  if (runAtMs < 0 || nowMs > runAtMs) return null;
  return buildEventProgressPlan(
    {
      eventId,
      sourceKey: `${kind}:${eventId}:${startAtMs}`,
      reason: spec.reason,
      runAtMs,
    },
    nowMs,
  );
}

export const buildEventPrizeAnnouncementPlan = (
  eventId: string,
  event: unknown,
  nowMs: number,
) => buildEventAnnouncementPlan(eventId, event, nowMs, "prizes");

export const buildSundayMonsReminderPlan = (
  eventId: string,
  event: unknown,
  nowMs: number,
) => buildEventAnnouncementPlan(eventId, event, nowMs, "reminder");

async function preserveSchedule(
  repository: ScheduleRepository,
  plan: EventProgressPlan,
  signal?: AbortSignal,
): Promise<EventProgressPlan> {
  const existing = await parseEventProgressOutbox(
    plan.outboxId,
    await repository.getStatePath(
      `eventProgressOutbox/${plan.outboxId}`,
      undefined,
      signal,
    ),
  );
  return existing || plan;
}

async function scheduleEventAnnouncement(
  env: Env,
  repository: ScheduleRepository,
  eventId: string,
  event: unknown,
  nowMs: number,
  kind: EventAnnouncementKind,
): Promise<void> {
  const candidate = await buildEventAnnouncementPlan(
    eventId,
    event,
    nowMs,
    kind,
  );
  if (!candidate) return;
  const plan = await preserveSchedule(repository, candidate);
  await repository.patchStateRoot({
    [`eventProgressOutbox/${plan.outboxId}`]: plan.outbox,
  });
  await ensureEventProgressWorkflow(env, plan);
}

export const scheduleEventPrizeAnnouncement = (
  env: Env,
  repository: ScheduleRepository,
  eventId: string,
  event: unknown,
  nowMs: number,
) =>
  scheduleEventAnnouncement(env, repository, eventId, event, nowMs, "prizes");

export async function scheduleEventAnnouncements(
  env: Env,
  repository: ScheduleRepository,
  eventId: string,
  event: unknown,
  nowMs: number,
): Promise<void> {
  const results = await Promise.allSettled(
    EVENT_ANNOUNCEMENT_KINDS.map((kind) =>
      scheduleEventAnnouncement(env, repository, eventId, event, nowMs, kind),
    ),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(failures, "event-announcement-scheduling-failed");
}

export function createEventAnnouncementScheduleRepository(
  env: Env,
  repository: GameplayRepository,
  dependencies: ScheduleDependencies = {},
): GameplayRepository {
  const now = dependencies.now || Date.now;
  const enqueue =
    dependencies.enqueue ||
    ((plan: EventProgressPlan) => ensureEventProgressWorkflow(env, plan));
  const logger = dependencies.logger || console;
  return {
    ...repository,
    async patchStateRoot(updates, signal) {
      const eventIds = new Set<string>();
      for (const path of Object.keys(updates)) {
        const [root, eventId, field, ...nested] = path.split("/");
        if (
          root === "events" &&
          eventId &&
          isSafeRecordKey(eventId) &&
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
            : await repository.getStatePath(path, undefined, signal),
        );
        if (!event) continue;
        const nextEvent = { ...event };
        for (const field of SCHEDULE_FIELDS) {
          if (Object.hasOwn(updates, `${path}/${field}`)) {
            nextEvent[field] = updates[`${path}/${field}`];
          }
        }
        const discoveredAtMs = now();
        for (const kind of EVENT_ANNOUNCEMENT_KINDS) {
          const candidate = await buildEventAnnouncementPlan(
            eventId,
            nextEvent,
            discoveredAtMs,
            kind,
          );
          if (!candidate) continue;
          const plan = await preserveSchedule(repository, candidate, signal);
          nextUpdates[`eventProgressOutbox/${plan.outboxId}`] = plan.outbox;
          plans.push(plan);
        }
      }
      await repository.patchStateRoot(nextUpdates, signal);
      if (plans.length === 0) return;
      const dispatch = async () => {
        const results = await Promise.allSettled(plans.map(enqueue));
        results.forEach((result, index) => {
          if (result.status === "rejected") {
            logger.error(
              JSON.stringify({
                event: "event_announcement_enqueue_failed",
                eventId: plans[index].params.eventId,
                reason: plans[index].params.reason,
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

export const createEventPrizeAnnouncementScheduleRepository =
  createEventAnnouncementScheduleRepository;
