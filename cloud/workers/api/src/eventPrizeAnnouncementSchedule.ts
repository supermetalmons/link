import type {
  EventCommand,
  EventCommitPlan,
} from "../../../runtime/eventCommands.js";
import {
  EVENT_ANNOUNCEMENT_KINDS,
  EVENT_ANNOUNCEMENT_SPECS,
  type EventAnnouncementKind,
} from "./eventAnnouncementKinds.ts";
import {
  buildEventProgressPlan,
  parseEventProgressOutbox,
  type EventProgressPlan,
} from "./eventProgressCodec.ts";
import { ensureEventProgressWorkflow } from "./eventProgressDispatch.ts";
import type { EventGameplayRepository } from "./eventRepository.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import type { EventProgressWorkExecutor } from "./eventProgressExecution.ts";
import type {
  EventMutationReads,
  PreparedEventMutation,
} from "./eventMutationCommit.ts";

export const EVENT_PRIZE_ANNOUNCEMENT_REASON =
  EVENT_ANNOUNCEMENT_SPECS.prizes.reason;
export const SUNDAY_MONS_REMINDER_REASON =
  EVENT_ANNOUNCEMENT_SPECS.reminder.reason;
const SCHEDULE_FIELDS = new Set(["isSundayMons", "startAtMs", "status"]);

type ScheduleRepository = Pick<
  EventGameplayRepository,
  "readEventProgressOutbox" | "commitEventPlan" | "readEvent"
>;

type ScheduleDependencies = {
  enqueue?: (plan: EventProgressPlan) => Promise<void>;
  logger?: Pick<Console, "error">;
  now?: () => number;
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
  repository: Pick<ScheduleRepository, "readEventProgressOutbox">,
  plan: EventProgressPlan,
  signal?: AbortSignal,
): Promise<EventProgressPlan> {
  const existing = await parseEventProgressOutbox(
    plan.outboxId,
    await repository.readEventProgressOutbox(plan.outboxId, signal),
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
  execute: EventProgressWorkExecutor = (_workflowId, work) => work(),
): Promise<void> {
  const candidate = await buildEventAnnouncementPlan(
    eventId,
    event,
    nowMs,
    kind,
  );
  if (!candidate) return;
  await execute(candidate.workflowId, async () => {
    const plan = await preserveSchedule(repository, candidate);
    await repository.commitEventPlan([
      { kind: "progress-outbox", outboxId: plan.outboxId, value: plan.outbox },
    ]);
    await ensureEventProgressWorkflow(env, plan);
  });
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
  execute?: EventProgressWorkExecutor,
): Promise<void> {
  const results = await Promise.allSettled(
    EVENT_ANNOUNCEMENT_KINDS.map((kind) =>
      scheduleEventAnnouncement(
        env,
        repository,
        eventId,
        event,
        nowMs,
        kind,
        execute,
      ),
    ),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(failures, "event-announcement-scheduling-failed");
}

export async function prepareEventAnnouncementSchedule(
  env: Env,
  updates: readonly EventCommand[],
  reads: EventMutationReads,
  dependencies: ScheduleDependencies = {},
): Promise<PreparedEventMutation | null> {
  const now = dependencies.now || Date.now;
  const enqueue =
    dependencies.enqueue ||
    ((plan: EventProgressPlan) => ensureEventProgressWorkflow(env, plan));
  const logger = dependencies.logger || console;
  const eventIds = new Set<string>();
  for (const command of updates) {
    if (
      (command.kind === "event" ||
        (command.kind === "event-field" &&
          SCHEDULE_FIELDS.has(command.field))) &&
      isSafeRecordKey(command.eventId)
    )
      eventIds.add(command.eventId);
  }
  const plans: EventProgressPlan[] = [];
  const commands: EventCommitPlan = [];
  for (const eventId of eventIds) {
    const replacement = updates.findLast(
      (command) => command.kind === "event" && command.eventId === eventId,
    );
    const event = toRecord(
      replacement?.kind === "event"
        ? replacement.value
        : await reads.readEvent(eventId),
    );
    if (!event) continue;
    const nextEvent = { ...event };
    for (const command of updates)
      if (
        command.kind === "event-field" &&
        command.eventId === eventId &&
        SCHEDULE_FIELDS.has(command.field)
      )
        nextEvent[command.field] = command.value;
    const discoveredAtMs = now();
    for (const kind of EVENT_ANNOUNCEMENT_KINDS) {
      const candidate = await buildEventAnnouncementPlan(
        eventId,
        nextEvent,
        discoveredAtMs,
        kind,
      );
      if (!candidate) continue;
      const plan = await preserveSchedule(reads, candidate);
      commands.push({
        kind: "progress-outbox",
        outboxId: plan.outboxId,
        value: plan.outbox,
      });
      plans.push(plan);
    }
  }
  if (plans.length === 0) return null;
  return {
    commands,
    async dispatch() {
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
    },
  };
}
