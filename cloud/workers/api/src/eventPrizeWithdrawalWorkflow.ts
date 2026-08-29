import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  createEventPrizeRuntimeDependencies,
  executeEventPrizeWithdrawal,
  parseEventPrizeWithdrawalWorkflowParams,
  type EventPrizeWithdrawalWorkflowFailure,
  type EventPrizeWithdrawalWorkflowInput,
  type EventPrizeWithdrawalWorkflowOutput,
} from "./eventPrizeWithdrawal.ts";
import { assertProfileBackgroundMutationsEnabled } from "./profileCanonicalActivation.ts";

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function workflowFailure(
  error: unknown,
): EventPrizeWithdrawalWorkflowFailure | null {
  const record = toRecord(error);
  const code = typeof record?.code === "string" ? record.code : "";
  const message =
    typeof record?.message === "string" && record.message.trim()
      ? record.message.trim()
      : "Prize withdrawal is unavailable.";
  if (
    code === "invalid-argument" ||
    code === "not-found" ||
    code === "permission-denied"
  ) {
    return { ok: false, status: "failed", error: code, message };
  }
  return null;
}

function isPreflightParams(
  value: unknown,
): value is { schemaVersion: 1; kind: "preflight" } {
  const record = toRecord(value);
  return (
    !!record &&
    Object.keys(record).length === 2 &&
    record.schemaVersion === 1 &&
    record.kind === "preflight"
  );
}

type WorkflowDependencies = {
  execute: typeof executeEventPrizeWithdrawal;
  preflight(env: Env): Promise<void>;
};

async function preflightEventPrizeWithdrawal(env: Env): Promise<void> {
  const runtime = await createEventPrizeRuntimeDependencies(env, {
    allowFrozen: true,
  });
  const core = toRecord(runtime.createEventPrizeUmi("core"));
  const compressed = toRecord(runtime.createEventPrizeUmi("compressed"));
  const coreRpc = toRecord(core?.rpc);
  if (
    !core ||
    !compressed ||
    typeof coreRpc?.getLatestBlockhash !== "function"
  ) {
    throw new Error("event-prize-runtime-unavailable");
  }
  await coreRpc.getLatestBlockhash({ commitment: "confirmed" });
}

export async function runEventPrizeWithdrawalWorkflow(
  env: Env,
  event: Readonly<WorkflowEvent<EventPrizeWithdrawalWorkflowInput>>,
  step: WorkflowStep,
  dependencies: WorkflowDependencies = {
    execute: executeEventPrizeWithdrawal,
    preflight: preflightEventPrizeWithdrawal,
  },
): Promise<EventPrizeWithdrawalWorkflowOutput> {
  if (isPreflightParams(event.payload)) {
    return step.do(
      "validate event prize runtime",
      { timeout: "30 seconds" },
      async () => {
        await dependencies.preflight(env);
        return { ok: true as const, status: "ready" as const };
      },
    );
  }

  const params = await parseEventPrizeWithdrawalWorkflowParams(
    event.payload,
    event.instanceId,
  );
  if (!params) {
    throw new NonRetryableError("invalid-event-prize-withdrawal-payload");
  }
  await step.do(
    "wait for profile writes",
    {
      retries: {
        limit: 10_000,
        delay: "1 minute",
        backoff: "constant",
      },
      timeout: "30 seconds",
    } satisfies WorkflowStepConfig,
    async () => {
      await assertProfileBackgroundMutationsEnabled(env);
      return { ready: true as const };
    },
  );
  const config = {
    retries: {
      limit: 3,
      delay: "5 seconds",
      backoff: "exponential",
    },
    timeout: "2 minutes",
  } satisfies WorkflowStepConfig;
  return step.do("execute event prize withdrawal", config, async () => {
    await assertProfileBackgroundMutationsEnabled(env);
    try {
      return await dependencies.execute(env, params);
    } catch (error) {
      const failure = workflowFailure(error);
      if (failure) return failure;
      throw error;
    }
  });
}

export class EventPrizeWithdrawalWorkflow extends WorkflowEntrypoint<
  Env,
  EventPrizeWithdrawalWorkflowInput
> {
  async run(
    event: Readonly<WorkflowEvent<EventPrizeWithdrawalWorkflowInput>>,
    step: WorkflowStep,
  ): Promise<EventPrizeWithdrawalWorkflowOutput> {
    return runEventPrizeWithdrawalWorkflow(this.env, event, step);
  }
}
