import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { createEventGameplayRepository } from "./eventRepository.ts";
import {
  createWorkflowEventRuntime,
  EVENT_PROGRESS_TIMEOUT_MS,
  EVENT_PROGRESS_WORKER_UID,
  InvalidEventProgressPayloadError,
  removeOutbox,
  runEventProgressWorkflow,
  type EventProgressWorkflowDependencies,
  type EventProgressWorkflowParams,
} from "./eventProgress.ts";
import { assertProfileBackgroundMutationsEnabled } from "./profileCanonicalActivation.ts";

export function createEventProgressWorkflowDependencies(
  env: Env,
): EventProgressWorkflowDependencies {
  let eventRepository:
    ReturnType<typeof createEventGameplayRepository> | undefined;
  const getEventRepository = () =>
    (eventRepository ||= createEventGameplayRepository(env));
  return {
    acknowledge: async (outboxId) => {
      await assertProfileBackgroundMutationsEnabled(env);
      await removeOutbox(getEventRepository(), outboxId);
    },
    synchronize: async ({ instanceId, params }) => {
      await assertProfileBackgroundMutationsEnabled(env);
      const signal = AbortSignal.timeout(EVENT_PROGRESS_TIMEOUT_MS);
      const { runtime } = createWorkflowEventRuntime(
        env,
        signal,
        getEventRepository(),
      );
      return runtime.runEventSyncState({
        eventId: params.eventId,
        requesterUid: EVENT_PROGRESS_WORKER_UID,
        enforceParticipantGate: false,
        enforceThrottle: false,
        syncLog: {
          mode: "workflow",
          eventId: params.eventId,
          requesterUid: EVENT_PROGRESS_WORKER_UID,
          sourceKey: params.sourceKey,
          triggerReason: params.reason,
          workflowInstanceId: instanceId,
        },
      });
    },
  };
}

export class EventProgressWorkflow extends WorkflowEntrypoint<
  Env,
  EventProgressWorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<EventProgressWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ status: "applied" | "not-found"; didChange?: boolean }> {
    try {
      return await runEventProgressWorkflow(
        event,
        step,
        createEventProgressWorkflowDependencies(this.env),
      );
    } catch (error) {
      if (error instanceof InvalidEventProgressPayloadError) {
        throw new NonRetryableError(error.message);
      }
      throw error;
    }
  }
}
