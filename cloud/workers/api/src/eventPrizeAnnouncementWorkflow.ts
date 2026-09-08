import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { EVENT_PRIZE_ANNOUNCEMENT_GRACE_MS } from "../../../functions/telegram/eventPrizeAnnouncement.js";
import {
  InvalidEventProgressPayloadError,
  parseEventProgressOutbox,
  parseEventProgressParams,
  type EventProgressWorkflowParams,
} from "./eventProgress.ts";
import {
  EVENT_ANNOUNCEMENT_SPECS,
  getEventAnnouncementKind,
} from "./eventAnnouncementKinds.ts";
import type {
  EventPrizeAnnouncementDeliveryInput,
  EventPrizeAnnouncementDeliveryResult,
} from "./eventPrizeAnnouncement.ts";
import type { SundayMonsReminderRefreshResult } from "./eventReminderProjection.ts";

export type EventPrizeAnnouncementWorkflowDependencies = {
  acknowledge(outboxId: string): Promise<void>;
  deliver(
    input: EventPrizeAnnouncementDeliveryInput,
  ): Promise<EventPrizeAnnouncementDeliveryResult>;
  readOutbox(outboxId: string): Promise<unknown>;
  refreshReminder(eventId: string): Promise<SundayMonsReminderRefreshResult>;
  now?: () => number;
};

export async function runEventAnnouncementWorkflow(
  event: Readonly<WorkflowEvent<EventProgressWorkflowParams>>,
  step: WorkflowStep,
  dependencies: EventPrizeAnnouncementWorkflowDependencies,
): Promise<EventPrizeAnnouncementDeliveryResult> {
  const params = await parseEventProgressParams(event.payload);
  const kind = getEventAnnouncementKind(params?.reason);
  let leadMs: number = kind ? EVENT_ANNOUNCEMENT_SPECS[kind].leadMs : 0;
  if (
    params &&
    kind === "reminder" &&
    params.runAtMs !== null &&
    params.sourceKey ===
      `reminder:${params.eventId}:${params.runAtMs + 10_800_000}`
  ) {
    leadMs = 10_800_000;
  }
  if (
    !params ||
    !kind ||
    params.runAtMs === null ||
    params.sourceKey !== `${kind}:${params.eventId}:${params.runAtMs + leadMs}`
  ) {
    throw new InvalidEventProgressPayloadError(
      "invalid-event-announcement-payload",
    );
  }
  const now = dependencies.now || Date.now;
  const { stepName } = EVENT_ANNOUNCEMENT_SPECS[kind];
  const runAtMs = params.runAtMs;
  const deadline = runAtMs + EVENT_PRIZE_ANNOUNCEMENT_GRACE_MS;
  await step.sleepUntil(`wait for ${stepName}`, runAtMs);
  let result: EventPrizeAnnouncementDeliveryResult = {
    status: "skipped",
    reason: "expired",
  };
  for (let attempt = 0; attempt <= 60; attempt += 1) {
    result = await step.do(
      `deliver ${stepName} ${attempt}`,
      { retries: { limit: 0, delay: "1 second" }, timeout: "30 seconds" },
      async () => {
        if (now() >= deadline)
          return { status: "skipped" as const, reason: "expired" };
        try {
          const plan = await parseEventProgressOutbox(
            params.outboxId,
            await dependencies.readOutbox(params.outboxId),
          );
          if (
            !plan ||
            plan.params.reason !== params.reason ||
            plan.params.runAtMs !== runAtMs ||
            plan.outbox.firstQueuedAtMs > runAtMs
          ) {
            return {
              status: "skipped" as const,
              reason: "not-scheduled-on-time",
            };
          }
          const delivery = await dependencies.deliver({
            ...(kind === "reminder" ? { kind } : {}),
            eventId: params.eventId,
            startAtMs: runAtMs + leadMs,
            runAtMs,
            firstQueuedAtMs: plan.outbox.firstQueuedAtMs,
          });
          return delivery.status === "retryable"
            ? {
                ...delivery,
                retryAtMs: Math.max(delivery.retryAtMs || 0, now() + 1_000),
              }
            : delivery;
        } catch {
          return {
            status: "retryable" as const,
            reason: "unavailable",
            retryAtMs: now() + 1_000,
          };
        }
      },
    );
    if (result.status !== "retryable") break;
    const retryAtMs = result.retryAtMs ?? deadline;
    if (retryAtMs >= deadline || attempt === 60) {
      result = { status: "skipped", reason: "expired" };
      break;
    }
    await step.sleepUntil(`retry ${stepName} ${attempt}`, retryAtMs);
  }
  if (kind === "reminder") {
    await step.do(
      "refresh sunday mons reminder participants",
      {
        retries: { limit: 12, delay: "1 second", backoff: "exponential" },
        timeout: "30 seconds",
      },
      () => dependencies.refreshReminder(params.eventId),
    );
  }
  await step.do(
    `acknowledge ${stepName} outbox`,
    {
      retries: { limit: 12, delay: "1 second", backoff: "exponential" },
      timeout: "30 seconds",
    },
    async () => {
      await dependencies.acknowledge(params.outboxId);
      return { acknowledged: true };
    },
  );
  return result;
}

export const runEventPrizeAnnouncementWorkflow = runEventAnnouncementWorkflow;
