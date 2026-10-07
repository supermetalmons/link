import type { EventGameplayRepository } from "./eventRepository.ts";
import {
  parseEventProgressOutbox,
  type EventProgressPlan,
  type EventProgressWorkflowParams,
} from "./eventProgressCodec.ts";
import type { EventProgressRecoveryStore } from "./eventProgressRecoveryD1.ts";
import { requireActiveDurableMatchState } from "./matchStateAuthority.ts";
import type { EventWriteAdmission } from "./eventD1.ts";
import { withEventWriteAdmission } from "./eventWriteAdmission.ts";
import { logRecoveryEvent } from "./recoveryReporting.ts";

const EVENT_PROGRESS_RECOVERY_INTERVAL_MS = 5 * 60 * 1_000;
const EVENT_PROGRESS_HEALTH_CHECK_INTERVAL_MS = 60 * 60 * 1_000;
const EVENT_PROGRESS_DEADLINE_MARGIN_MS = 10 * 60 * 1_000;

function nextRecoverySweep(nowMs: number): number {
  return Math.min(
    (Math.floor(nowMs / EVENT_PROGRESS_RECOVERY_INTERVAL_MS) + 1) *
      EVENT_PROGRESS_RECOVERY_INTERVAL_MS,
    Number.MAX_SAFE_INTEGER,
  );
}

export async function withEventProgressDispatchAdmission(
  db: D1Database,
  work: (admission: EventWriteAdmission) => Promise<void>,
): Promise<void> {
  return withEventWriteAdmission(db, { kind: "dispatch" }, work);
}

async function ensureEventProgressWorkflowInstance(
  workflow: Workflow<EventProgressWorkflowParams>,
  plan: EventProgressPlan,
): Promise<void> {
  try {
    await workflow.createBatch([
      {
        id: plan.workflowId,
        params: plan.params,
        retention: { successRetention: "1 day", errorRetention: "30 days" },
      },
    ]);
  } catch (error) {
    try {
      await workflow.get(plan.workflowId);
    } catch {
      throw error;
    }
  }
}

export async function ensureEventProgressWorkflow(
  env: Pick<Env, "EVENT_DB" | "EVENT_PROGRESS_WORKFLOW" | "PROFILE_GAMES_DB">,
  plan: EventProgressPlan,
): Promise<void> {
  await requireActiveDurableMatchState(env.PROFILE_GAMES_DB);
  await withEventProgressDispatchAdmission(env.EVENT_DB, () =>
    ensureEventProgressWorkflowInstance(env.EVENT_PROGRESS_WORKFLOW, plan),
  );
}

export async function removeOutbox(
  repository: Pick<EventGameplayRepository, "commitEventPlan">,
  outboxId: string,
): Promise<void> {
  await repository.commitEventPlan([
    { kind: "progress-outbox", outboxId, value: null },
  ]);
}

export async function dispatchOutboxPlan(
  env: Env,
  recovery: EventProgressRecoveryStore,
  outboxId: string,
  now: () => number,
): Promise<void> {
  const current = await recovery.read(outboxId);
  if (!current || current.nextReconcileAtMs > now()) return;
  const plan = await parseEventProgressOutbox(outboxId, current.record);
  if (!plan) return;
  try {
    await ensureEventProgressWorkflowInstance(
      env.EVENT_PROGRESS_WORKFLOW,
      plan,
    );
    const instance = await env.EVENT_PROGRESS_WORKFLOW.get(plan.workflowId);
    const status = await instance.status();
    if (status.status === "errored" || status.status === "terminated") {
      await instance.delete();
      await ensureEventProgressWorkflowInstance(
        env.EVENT_PROGRESS_WORKFLOW,
        plan,
      );
      await recovery.checkpoint(current, nextRecoverySweep(now()));
      return;
    }
    if (status.status === "complete") {
      await recovery.remove(current);
      return;
    }
    const checkedAtMs = now();
    const runAtMs = plan.params.runAtMs;
    const nextReconcileAtMs =
      status.status === "waiting" &&
      runAtMs !== null &&
      runAtMs > checkedAtMs + EVENT_PROGRESS_DEADLINE_MARGIN_MS
        ? Math.min(
            checkedAtMs + EVENT_PROGRESS_HEALTH_CHECK_INTERVAL_MS,
            runAtMs - EVENT_PROGRESS_DEADLINE_MARGIN_MS,
          )
        : nextRecoverySweep(checkedAtMs);
    await recovery.checkpoint(current, nextReconcileAtMs);
  } catch (error) {
    try {
      await recovery.checkpoint(current, nextRecoverySweep(now()));
    } catch {
      logRecoveryEvent(console, "error", {
        event: "event_progress_recovery_checkpoint_failed",
        outboxId,
      });
    }
    throw error;
  }
}
