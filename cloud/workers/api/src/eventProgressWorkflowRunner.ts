import type {
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepConfig,
} from "cloudflare:workers";
import {
  parseEventProgressParams,
  workflowIdFromOutboxId,
  type EventProgressWorkflowParams,
} from "./eventProgressCodec.ts";
import { createEventGameplayRepository } from "./eventRepository.ts";
import { createEventMutationRepository } from "./eventMutationRepository.ts";
import { createWorkerEventRuntime } from "./workerEventRuntime.ts";

export const EVENT_PROGRESS_WORKER_UID = "event-progress-worker";
export const EVENT_PROGRESS_TIMEOUT_MS = 30_000;

export type EventProgressWorkflowResult = {
  status: "applied" | "not-found";
  didChange?: boolean;
};

export type EventProgressWorkflowDependencies = {
  acknowledge(outboxId: string): Promise<void>;
  synchronize(input: {
    instanceId: string;
    params: EventProgressWorkflowParams;
  }): Promise<{ didChange?: boolean; reason?: string; skipped?: boolean }>;
};

export class InvalidEventProgressPayloadError extends Error {}

export class EventProgressRetryableError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export async function runEventProgressWorkflow(
  event: Readonly<WorkflowEvent<EventProgressWorkflowParams>>,
  step: WorkflowStep,
  dependencies: EventProgressWorkflowDependencies,
): Promise<EventProgressWorkflowResult> {
  const params = await parseEventProgressParams(event.payload);
  if (!params || workflowIdFromOutboxId(params.outboxId) !== event.instanceId) {
    throw new InvalidEventProgressPayloadError(
      "invalid-event-progress-payload",
    );
  }
  if (params.runAtMs !== null) {
    await step.sleepUntil("wait for scheduled event", params.runAtMs);
  }
  const synchronizationConfig = {
    retries: {
      limit: 13,
      delay: ({ ctx }) =>
        Math.min(30_000, 1_000 * 2 ** Math.max(0, ctx.attempt - 1)),
      backoff: "constant",
    },
    timeout: EVENT_PROGRESS_TIMEOUT_MS,
  } satisfies WorkflowStepConfig;
  const result = await step.do(
    "synchronize event",
    synchronizationConfig,
    async () => {
      try {
        const response = await dependencies.synchronize({
          instanceId: event.instanceId,
          params,
        });
        if (response.skipped === true && response.reason === "locked") {
          throw new EventProgressRetryableError("locked");
        }
        return {
          status: "applied" as const,
          didChange: response.didChange === true,
        };
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "not-found"
        ) {
          return { status: "not-found" as const };
        }
        throw error;
      }
    },
  );
  await step.do(
    "acknowledge outbox",
    {
      retries: { limit: 12, delay: "1 second", backoff: "exponential" },
      timeout: EVENT_PROGRESS_TIMEOUT_MS,
    },
    async () => {
      await dependencies.acknowledge(params.outboxId);
      return { acknowledged: true };
    },
  );
  return result;
}

export function createWorkflowEventRuntime(
  env: Env,
  signal: AbortSignal,
  eventRepository = createEventGameplayRepository(env),
) {
  const repository = createEventMutationRepository(env, { eventRepository });
  return {
    repository,
    runtime: createWorkerEventRuntime({
      repository,
      signal,
      withdrawalDb: env.EVENT_PRIZE_WITHDRAWALS_DB,
      lockFailureEvent: "event_progress_lock_failure",
      enqueueEventProgressTask: async () => {
        throw new Error("workflow-cannot-schedule-event-progress");
      },
    }),
  };
}
