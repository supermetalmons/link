import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { createGameplayRepository } from "./gameplayRepository.ts";
import {
  createWorkflowEventRuntime,
  EVENT_PROGRESS_TIMEOUT_MS,
  EVENT_PROGRESS_WORKER_UID,
  InvalidEventProgressPayloadError,
  removeOutbox,
  runEventProgressWorkflow,
  type EventProgressWorkflowParams,
} from "./eventProgress.ts";

export class EventProgressWorkflow extends WorkflowEntrypoint<
  Env,
  EventProgressWorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<EventProgressWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<{ status: "applied" | "not-found"; didChange?: boolean }> {
    try {
      return await runEventProgressWorkflow(event, step, {
        acknowledge: async (outboxId) => {
          const repository = createGameplayRepository(this.env);
          await removeOutbox(repository, outboxId);
        },
        synchronize: async ({ instanceId, params }) => {
          const signal = AbortSignal.timeout(EVENT_PROGRESS_TIMEOUT_MS);
          const { runtime } = createWorkflowEventRuntime(this.env, signal);
          return runtime.runEventSyncState({
            eventId: params.eventId,
            requesterUid: EVENT_PROGRESS_WORKER_UID,
            auth: null,
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
      });
    } catch (error) {
      if (error instanceof InvalidEventProgressPayloadError) {
        throw new NonRetryableError(error.message);
      }
      throw error;
    }
  }
}
