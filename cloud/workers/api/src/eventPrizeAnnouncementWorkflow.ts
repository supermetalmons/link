import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import {
  EVENT_PRIZE_ANNOUNCEMENT_GRACE_MS,
  EVENT_PRIZE_ANNOUNCEMENT_LEAD_MS,
} from "../../../functions/telegram/eventPrizeAnnouncement.js";
import {
  InvalidEventProgressPayloadError,
  parseEventProgressOutbox,
  parseEventProgressParams,
  type EventProgressWorkflowParams,
} from "./eventProgress.ts";
import { EVENT_PRIZE_ANNOUNCEMENT_REASON } from "./eventPrizeAnnouncementSchedule.ts";
import type {
  EventPrizeAnnouncementDeliveryInput,
  EventPrizeAnnouncementDeliveryResult,
} from "./eventPrizeAnnouncement.ts";

export type EventPrizeAnnouncementWorkflowDependencies = {
  acknowledge(outboxId: string): Promise<void>;
  deliver(
    input: EventPrizeAnnouncementDeliveryInput,
  ): Promise<EventPrizeAnnouncementDeliveryResult>;
  readOutbox(outboxId: string): Promise<unknown>;
  now?: () => number;
};

export async function runEventPrizeAnnouncementWorkflow(
  event: Readonly<WorkflowEvent<EventProgressWorkflowParams>>,
  step: WorkflowStep,
  dependencies: EventPrizeAnnouncementWorkflowDependencies,
): Promise<EventPrizeAnnouncementDeliveryResult> {
  const params = await parseEventProgressParams(event.payload);
  if (
    !params ||
    params.reason !== EVENT_PRIZE_ANNOUNCEMENT_REASON ||
    params.runAtMs === null ||
    params.sourceKey !==
      `prizes:${params.eventId}:${params.runAtMs + EVENT_PRIZE_ANNOUNCEMENT_LEAD_MS}`
  ) {
    throw new InvalidEventProgressPayloadError(
      "invalid-event-prize-announcement-payload",
    );
  }
  const now = dependencies.now || Date.now;
  const runAtMs = params.runAtMs;
  const deadline = runAtMs + EVENT_PRIZE_ANNOUNCEMENT_GRACE_MS;
  await step.sleepUntil("wait for prize announcement", runAtMs);
  let result: EventPrizeAnnouncementDeliveryResult = {
    status: "skipped",
    reason: "expired",
  };
  for (let attempt = 0; attempt <= 60; attempt += 1) {
    result = await step.do(
      `deliver prize announcement ${attempt}`,
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
          return await dependencies.deliver({
            eventId: params.eventId,
            startAtMs: runAtMs + EVENT_PRIZE_ANNOUNCEMENT_LEAD_MS,
            runAtMs,
            firstQueuedAtMs: plan.outbox.firstQueuedAtMs,
          });
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
    const retryAtMs = Math.max(result.retryAtMs || 0, now() + 1_000);
    if (retryAtMs >= deadline || attempt === 60) {
      result = { status: "skipped", reason: "expired" };
      break;
    }
    await step.sleepUntil(`retry prize announcement ${attempt}`, retryAtMs);
  }
  await step.do(
    "acknowledge prize announcement outbox",
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
