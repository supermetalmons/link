import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import type {
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepConfig,
} from "cloudflare:workers";
import {
  createRatingRepository,
  type GameplayRepository,
  type RatingEventProgressRepository,
} from "./gameplayRepository.ts";
import { createD1EventPrizeWithdrawalReader } from "./eventPrizeWithdrawalD1.ts";
import {
  createEventRuntime,
  type EventProgressOutboxRecord,
} from "../../../functions/events.js";
import { createEventLockManagerCore } from "../../../functions/events/lockManagerCore.js";
import { PROFILE_BACKGROUND_SWEEP_LIMIT } from "./profileBackgroundLimits.ts";
import { requireProfileOwnershipSnapshot } from "./profileOwnership.ts";
import { createEventGameplayRepository } from "./eventRepository.ts";
import { createEventMutationRepository } from "./eventMutationRepository.ts";

const EVENT_PROGRESS_OUTBOX_ROOT = "eventProgressOutbox";
const EVENT_PROGRESS_OUTBOX_DEAD_ROOT = "eventProgressOutboxDead";
const EVENT_PROGRESS_SCHEMA_VERSION = 1;
const EVENT_PROGRESS_WORKER_UID = "event-progress-worker";
const EVENT_PROGRESS_SWEEP_LIMIT = PROFILE_BACKGROUND_SWEEP_LIMIT;
const EVENT_PROGRESS_SWEEP_CONCURRENCY = 10;
const EVENT_PROGRESS_TIMEOUT_MS = 30_000;
const RATING_EVENT_PROGRESS_SCHEMA_VERSION = 1;

export type EventProgressWorkflowParams = {
  schemaVersion: 1;
  eventId: string;
  outboxId: string;
  reason: string;
  runAtMs: number | null;
  sourceKey: string;
};

export type EventProgressPlan = {
  outbox: EventProgressOutboxRecord;
  outboxId: string;
  params: EventProgressWorkflowParams;
  workflowId: string;
};

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

export type EventProgressSweepRepository = Pick<
  GameplayRepository,
  "getRtdbPath" | "patchRtdbRoot"
>;

export type EventProgressRatingRepository = Pick<
  RatingEventProgressRepository,
  | "claimRatingEventProgress"
  | "listDueRatingEventProgress"
  | "markRatingEventProgress"
>;

export type EventProgressSweepDependencies = {
  now?: () => number;
  ratingRepository?: EventProgressRatingRepository | null;
  repository?: EventProgressSweepRepository;
};

export class InvalidEventProgressPayloadError extends Error {}

export class EventProgressRetryableError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

type RtdbSnapshot = {
  exists(): boolean;
  val(): unknown;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function snapshot(value: unknown): RtdbSnapshot {
  return {
    exists: () => value !== null && value !== undefined,
    val: () => value,
  };
}

function prefixUpdates(
  path: string,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  if (!path) {
    return updates;
  }
  return Object.fromEntries(
    Object.entries(updates).map(([key, value]) => [`${path}/${key}`, value]),
  );
}

export function createEventAdminAdapter(
  repository: Pick<
    GameplayRepository,
    "getRtdbPath" | "patchRtdbRoot" | "transactRtdbPath"
  >,
  signal?: AbortSignal,
) {
  return {
    database() {
      return {
        ref(path = "") {
          const normalizedPath = path.replace(/^\/+|\/+$/g, "");
          return {
            async once(event: "value") {
              if (event !== "value") {
                throw new TypeError("Only value snapshots are supported");
              }
              return snapshot(
                await repository.getRtdbPath(normalizedPath, undefined, signal),
              );
            },
            async remove() {
              await repository.patchRtdbRoot(
                { [normalizedPath]: null },
                signal,
              );
            },
            async set(value: unknown) {
              await repository.patchRtdbRoot(
                { [normalizedPath]: value },
                signal,
              );
            },
            async transaction(
              updater: (current: unknown) => unknown,
              _onComplete?: unknown,
              _applyLocally?: boolean,
            ) {
              const result = await repository.transactRtdbPath(
                normalizedPath,
                (current) => {
                  const next = updater(current);
                  return next === undefined
                    ? { commit: false }
                    : { value: next };
                },
                signal,
              );
              return {
                committed: result.committed,
                snapshot: snapshot(result.value),
              };
            },
            async update(updates: Record<string, unknown>) {
              await repository.patchRtdbRoot(
                prefixUpdates(normalizedPath, updates),
                signal,
              );
            },
          };
        },
      };
    },
  };
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function digestIdentity(eventId: string, sourceKey: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${eventId}\n${sourceKey}`),
  );
  return bytesToHex(digest);
}

export async function buildEventProgressPlan(
  input: {
    eventId: string;
    sourceKey: string;
    reason: string;
    runAtMs?: number | null;
  },
  nowMs = Date.now(),
): Promise<EventProgressPlan> {
  const digest = await digestIdentity(input.eventId, input.sourceKey);
  const outboxId = `ep_${digest}`;
  const workflowId = `event-progress-${digest}`;
  const runAtMs = input.runAtMs ?? null;
  const outbox = {
    schemaVersion: EVENT_PROGRESS_SCHEMA_VERSION,
    eventId: input.eventId,
    sourceKey: input.sourceKey,
    reason: input.reason,
    runAtMs,
    firstQueuedAtMs: nowMs,
    lastQueuedAtMs: nowMs,
  } satisfies EventProgressOutboxRecord;
  return {
    outbox,
    outboxId,
    workflowId,
    params: {
      schemaVersion: EVENT_PROGRESS_SCHEMA_VERSION,
      eventId: input.eventId,
      outboxId,
      reason: input.reason,
      runAtMs,
      sourceKey: input.sourceKey,
    },
  };
}

export async function parseEventProgressOutbox(
  outboxId: string,
  value: unknown,
): Promise<EventProgressPlan | null> {
  const record = toRecord(value);
  const runAtMs = record?.runAtMs;
  const firstQueuedAtMs = record?.firstQueuedAtMs;
  const lastQueuedAtMs = record?.lastQueuedAtMs;
  if (
    !record ||
    record.schemaVersion !== EVENT_PROGRESS_SCHEMA_VERSION ||
    !isSafeFirebaseKey(record.eventId) ||
    typeof record.sourceKey !== "string" ||
    !record.sourceKey.trim() ||
    typeof record.reason !== "string" ||
    !record.reason.trim() ||
    (runAtMs !== null &&
      (typeof runAtMs !== "number" ||
        !Number.isSafeInteger(runAtMs) ||
        runAtMs < 0)) ||
    typeof firstQueuedAtMs !== "number" ||
    !Number.isSafeInteger(firstQueuedAtMs) ||
    typeof lastQueuedAtMs !== "number" ||
    !Number.isSafeInteger(lastQueuedAtMs)
  ) {
    return null;
  }
  const digest = outboxId.startsWith("ep_") ? outboxId.slice(3) : "";
  if (
    !/^[0-9a-f]{64}$/.test(digest) ||
    digest !== (await digestIdentity(record.eventId, record.sourceKey))
  ) {
    return null;
  }
  const outbox = {
    schemaVersion: EVENT_PROGRESS_SCHEMA_VERSION,
    eventId: record.eventId,
    sourceKey: record.sourceKey,
    reason: record.reason,
    runAtMs,
    firstQueuedAtMs,
    lastQueuedAtMs,
  } satisfies EventProgressOutboxRecord;
  return {
    outbox,
    outboxId,
    workflowId: `event-progress-${digest}`,
    params: {
      schemaVersion: EVENT_PROGRESS_SCHEMA_VERSION,
      eventId: outbox.eventId,
      outboxId,
      reason: outbox.reason,
      runAtMs: outbox.runAtMs,
      sourceKey: outbox.sourceKey,
    },
  };
}

export async function parseEventProgressParams(
  value: unknown,
): Promise<EventProgressWorkflowParams | null> {
  const record = toRecord(value);
  if (
    !record ||
    Object.keys(record).length !== 6 ||
    typeof record.outboxId !== "string"
  ) {
    return null;
  }
  const plan = await parseEventProgressOutbox(record.outboxId, {
    schemaVersion: record.schemaVersion,
    eventId: record.eventId,
    sourceKey: record.sourceKey,
    reason: record.reason,
    runAtMs: record.runAtMs,
    firstQueuedAtMs: 0,
    lastQueuedAtMs: 0,
  });
  return plan?.params || null;
}

export async function ensureEventProgressWorkflow(
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

async function removeOutbox(
  repository: Pick<GameplayRepository, "patchRtdbRoot">,
  outboxId: string,
): Promise<void> {
  await repository.patchRtdbRoot({
    [`${EVENT_PROGRESS_OUTBOX_ROOT}/${outboxId}`]: null,
  });
}

async function deadLetterOutbox(
  repository: Pick<GameplayRepository, "patchRtdbRoot">,
  outboxId: string,
  originalRecord: unknown,
  nowMs: number,
): Promise<void> {
  await repository.patchRtdbRoot({
    [`${EVENT_PROGRESS_OUTBOX_DEAD_ROOT}/${outboxId}`]: {
      deadAtMs: nowMs,
      originalRecord: originalRecord === undefined ? null : originalRecord,
      reason: "invalid-event-progress-outbox",
    },
    [`${EVENT_PROGRESS_OUTBOX_ROOT}/${outboxId}`]: null,
  });
}

async function dispatchOutboxPlan(
  env: Env,
  repository: EventProgressSweepRepository,
  plan: EventProgressPlan,
  now: () => number,
): Promise<void> {
  await ensureEventProgressWorkflow(env.EVENT_PROGRESS_WORKFLOW, plan);
  const instance = await env.EVENT_PROGRESS_WORKFLOW.get(plan.workflowId);
  const status = await instance.status();
  if (status.status === "errored" || status.status === "terminated") {
    await instance.delete();
    await ensureEventProgressWorkflow(env.EVENT_PROGRESS_WORKFLOW, plan);
    return;
  }
  if (status.status === "complete") {
    await removeOutbox(repository, plan.outboxId);
    return;
  }
  await repository.patchRtdbRoot({
    [`${EVENT_PROGRESS_OUTBOX_ROOT}/${plan.outboxId}/lastQueuedAtMs`]: now(),
  });
}

async function forEachConcurrent<T>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const runners = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (index < values.length) {
        const value = values[index];
        index += 1;
        await operation(value);
      }
    },
  );
  await Promise.all(runners);
}

async function reconcileScheduledEvents(
  env: Env,
  repository: EventProgressSweepRepository,
  now: () => number,
): Promise<void> {
  const value = toRecord(
    await repository.getRtdbPath("events", {
      orderBy: "status",
      equalTo: "scheduled",
    }),
  );
  if (!value) {
    return;
  }
  await forEachConcurrent(
    Object.entries(value),
    EVENT_PROGRESS_SWEEP_CONCURRENCY,
    async ([eventId, eventValue]) => {
      const event = toRecord(eventValue);
      const startAtMs = event?.startAtMs;
      if (
        !isSafeFirebaseKey(eventId) ||
        typeof startAtMs !== "number" ||
        !Number.isSafeInteger(startAtMs) ||
        startAtMs < 0
      ) {
        return;
      }
      const plan = await buildEventProgressPlan(
        {
          eventId,
          sourceKey: `start:${eventId}:${startAtMs}`,
          reason: "scheduled-start-reconciliation",
          runAtMs: startAtMs,
        },
        now(),
      );
      const existing = await repository.getRtdbPath(
        `${EVENT_PROGRESS_OUTBOX_ROOT}/${plan.outboxId}`,
      );
      if (existing === null) {
        await repository.patchRtdbRoot({
          [`${EVENT_PROGRESS_OUTBOX_ROOT}/${plan.outboxId}`]: plan.outbox,
        });
      }
      await dispatchOutboxPlan(env, repository, plan, now);
    },
  );
}

async function recoverRatingEventProgress(
  env: Env,
  repository: EventProgressSweepRepository,
  ratingRepository: EventProgressRatingRepository,
  now: () => number,
): Promise<void> {
  const nowMs = now();
  const records = await ratingRepository.listDueRatingEventProgress(
    nowMs,
    EVENT_PROGRESS_SWEEP_LIMIT,
  );
  await forEachConcurrent(
    records,
    EVENT_PROGRESS_SWEEP_CONCURRENCY,
    async (record) => {
      const claimed = await ratingRepository.claimRatingEventProgress(
        record.operationId,
        record.updateTime,
        nowMs,
      );
      if (!claimed) {
        return;
      }
      if (
        record.version !== RATING_EVENT_PROGRESS_SCHEMA_VERSION ||
        !isSafeFirebaseKey(record.eventId) ||
        !isSafeFirebaseKey(record.inviteId) ||
        !isSafeFirebaseKey(record.matchId) ||
        record.operationId !== `${record.inviteId}__${record.matchId}`
      ) {
        await ratingRepository.markRatingEventProgress(
          record.operationId,
          "dead",
          now(),
          "invalid-event-progress-marker",
        );
        return;
      }
      const plan = await buildEventProgressPlan(
        {
          eventId: record.eventId,
          sourceKey: `rating:${record.inviteId}:${record.matchId}`,
          reason: "match-rating-updated",
        },
        nowMs,
      );
      await repository.patchRtdbRoot({
        [`${EVENT_PROGRESS_OUTBOX_ROOT}/${plan.outboxId}`]: plan.outbox,
      });
      await dispatchOutboxPlan(env, repository, plan, now);
      await ratingRepository.markRatingEventProgress(
        record.operationId,
        "done",
        now(),
      );
    },
  );
}

function rejectedReasons(results: PromiseSettledResult<void>[]): unknown[] {
  return results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
}

export async function sweepEventProgress(
  env: Env,
  dependencies: EventProgressSweepDependencies = {},
): Promise<void> {
  const repository =
    dependencies.repository || createEventGameplayRepository(env);
  const now = dependencies.now || Date.now;
  const ratingRepository =
    dependencies.ratingRepository === null
      ? null
      : dependencies.ratingRepository ||
        createRatingRepository(env, repository as GameplayRepository);
  const value = toRecord(
    await repository.getRtdbPath(EVENT_PROGRESS_OUTBOX_ROOT, {
      orderBy: "lastQueuedAtMs",
      limitToFirst: EVENT_PROGRESS_SWEEP_LIMIT,
    }),
  );
  const plans: EventProgressPlan[] = [];
  const invalidRecords: Array<{ outboxId: string; record: unknown }> = [];
  for (const [outboxId, record] of Object.entries(value || {})) {
    const plan = await parseEventProgressOutbox(outboxId, record);
    if (plan) {
      plans.push(plan);
    } else {
      invalidRecords.push({ outboxId, record });
    }
  }
  const sweepResults = await Promise.allSettled([
    forEachConcurrent(
      invalidRecords,
      EVENT_PROGRESS_SWEEP_CONCURRENCY,
      async ({ outboxId, record }) =>
        deadLetterOutbox(repository, outboxId, record, now()),
    ),
    forEachConcurrent(plans, EVENT_PROGRESS_SWEEP_CONCURRENCY, async (plan) =>
      dispatchOutboxPlan(env, repository, plan, now),
    ),
  ]);
  const reconciliationResults = await Promise.allSettled([
    reconcileScheduledEvents(env, repository, now),
    ...(ratingRepository
      ? [recoverRatingEventProgress(env, repository, ratingRepository, now)]
      : []),
  ]);
  const failures = rejectedReasons([...sweepResults, ...reconciliationResults]);
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "event-progress-sweep-failed");
  }
}

export async function runEventProgressWorkflow(
  event: Readonly<WorkflowEvent<EventProgressWorkflowParams>>,
  step: WorkflowStep,
  dependencies: EventProgressWorkflowDependencies,
): Promise<EventProgressWorkflowResult> {
  const params = await parseEventProgressParams(event.payload);
  if (!params) {
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
  const lockManager = createEventLockManagerCore({
    createLockId: () => crypto.randomUUID(),
    transactPath: (path, updater) =>
      repository.transactRtdbPath(path, updater, signal),
    releaseTransactPath: (path, updater) =>
      repository.transactRtdbPath(path, updater),
    sleep: (milliseconds) => scheduler.wait(milliseconds, { signal }),
    logger: {
      error: (_message, error) => {
        console.error(
          JSON.stringify({
            event: "event_progress_lock_failure",
            kind: error instanceof Error ? error.name : typeof error,
          }),
        );
      },
    },
  });
  const readEventPrizeWithdrawals = createD1EventPrizeWithdrawalReader(
    env.EVENT_PRIZE_WITHDRAWALS_DB,
  );
  return {
    repository,
    runtime: createEventRuntime({
      admin: createEventAdminAdapter(repository, signal),
      enqueueEventProgressTask: async () => {
        throw new Error("workflow-cannot-schedule-event-progress");
      },
      eventLockManager: lockManager,
      readProfileOwnershipSnapshot: (query) =>
        requireProfileOwnershipSnapshot(repository, query),
      readEventPrizeWithdrawals,
      random: secureRandom,
      sleep: (milliseconds) => scheduler.wait(milliseconds, { signal }),
    }),
  };
}

function secureRandom(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] / 0x1_0000_0000;
}

export {
  EVENT_PROGRESS_OUTBOX_DEAD_ROOT,
  EVENT_PROGRESS_OUTBOX_ROOT,
  EVENT_PROGRESS_TIMEOUT_MS,
  EVENT_PROGRESS_WORKER_UID,
  removeOutbox,
};
