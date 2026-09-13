import { isSafeRecordKey } from "./recordKeys.ts";
import type {
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepConfig,
} from "cloudflare:workers";
import { readGameplayMatchPair } from "./gameplayMatchReads.ts";
import { requireActiveDurableMatchState } from "./matchStateAuthority.ts";
import {
  createRatingRepository,
  type GameplayRepository,
  type RatingEventProgressRepository,
} from "./gameplayRepository.ts";
import { createD1EventPrizeWithdrawalReader } from "./eventPrizeWithdrawalD1.ts";
import {
  createEventRuntime,
  type EventProgressOutboxRecord,
} from "../../../runtime/events.js";
import { createEventLockManagerCore } from "../../../runtime/events/lockManagerCore.js";
import { PROFILE_BACKGROUND_SWEEP_LIMIT } from "./profileBackgroundLimits.ts";
import { requireProfileOwnershipSnapshot } from "./profileOwnership.ts";
import {
  createEventGameplayRepository,
  type EventGameplayRepository,
} from "./eventRepository.ts";
import { createEventMutationRepository } from "./eventMutationRepository.ts";
import { scheduleEventAnnouncements } from "./eventPrizeAnnouncementSchedule.ts";
import { EVENT_ANNOUNCEMENT_SPECS } from "./eventAnnouncementKinds.ts";
import {
  createEventScheduledRecoveryStore,
  SCHEDULED_EVENT_RECOVERY_MARGIN_MS,
  SCHEDULED_EVENT_RECOVERY_PAGE_SIZE,
  type EventScheduledRecoveryStore,
  type ScheduledEventRecoveryCandidate,
} from "./eventScheduledRecoveryD1.ts";
import {
  acquireEventWriteAdmission,
  EventWritesDisabled,
  releaseEventWriteAdmission,
  type EventWriteAdmission,
} from "./eventD1.ts";

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
  EventGameplayRepository,
  "getStatePath" | "patchStateRoot" | "readEvent"
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
  scheduledRecovery?: EventScheduledRecoveryStore;
};

export class InvalidEventProgressPayloadError extends Error {}

export class EventProgressRetryableError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function createEventStateAdapter(
  repository: Pick<
    EventGameplayRepository,
    | "getStatePath"
    | "patchStateRoot"
    | "transactStatePath"
    | "readEvent"
    | "readEventPrizeSelections"
    | "readEventSnapshot"
  >,
  signal?: AbortSignal,
) {
  const normalizePath = (path: string) => path.replace(/^\/+|\/+$/g, "");
  return {
    readEvent: (eventId: string) => repository.readEvent(eventId, signal),
    readEventPrizeSelections: (eventId: string) =>
      repository.readEventPrizeSelections(eventId, signal),
    readEventSnapshot: (eventId: string) =>
      repository.readEventSnapshot(eventId, signal),
    read: (path: string) =>
      repository.getStatePath(normalizePath(path), undefined, signal),
    set: (path: string, value: unknown) =>
      repository.patchStateRoot({ [normalizePath(path)]: value }, signal),
    remove: (path: string) =>
      repository.patchStateRoot({ [normalizePath(path)]: null }, signal),
    update(path: string, updates: Record<string, unknown>) {
      const normalizedPath = normalizePath(path);
      return repository.patchStateRoot(
        normalizedPath
          ? Object.fromEntries(
              Object.entries(updates).map(([key, value]) => [
                `${normalizedPath}/${key}`,
                value,
              ]),
            )
          : updates,
        signal,
      );
    },
    async transaction(path: string, updater: (current: unknown) => unknown) {
      const result = await repository.transactStatePath(
        normalizePath(path),
        (current) => {
          const value = updater(current);
          return value === undefined ? { commit: false } : { value };
        },
        signal,
      );
      return { committed: result.committed, value: result.value };
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
    !isSafeRecordKey(record.eventId) ||
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

async function withEventProgressDispatchAdmission(
  db: D1Database,
  work: (admission: EventWriteAdmission) => Promise<void>,
): Promise<void> {
  let admission: EventWriteAdmission;
  try {
    admission = await acquireEventWriteAdmission(db);
  } catch (error) {
    if (error instanceof EventWritesDisabled) return;
    throw error;
  }
  try {
    await work(admission);
  } finally {
    let failureKind: string | null = null;
    try {
      if (!(await releaseEventWriteAdmission(db, admission))) {
        failureKind = "unconfirmed";
      }
    } catch (error) {
      failureKind = error instanceof Error ? error.name : typeof error;
    }
    if (failureKind) {
      console.error(
        JSON.stringify({
          event: "event_progress_dispatch_admission_release_failed",
          kind: failureKind,
        }),
      );
    }
  }
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

async function removeOutbox(
  repository: Pick<GameplayRepository, "patchStateRoot">,
  outboxId: string,
): Promise<void> {
  await repository.patchStateRoot({
    [`${EVENT_PROGRESS_OUTBOX_ROOT}/${outboxId}`]: null,
  });
}

async function deadLetterOutbox(
  repository: Pick<GameplayRepository, "patchStateRoot">,
  outboxId: string,
  originalRecord: unknown,
  nowMs: number,
): Promise<void> {
  await repository.patchStateRoot({
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
  await ensureEventProgressWorkflowInstance(env.EVENT_PROGRESS_WORKFLOW, plan);
  const instance = await env.EVENT_PROGRESS_WORKFLOW.get(plan.workflowId);
  const status = await instance.status();
  if (status.status === "errored" || status.status === "terminated") {
    await instance.delete();
    await ensureEventProgressWorkflowInstance(
      env.EVENT_PROGRESS_WORKFLOW,
      plan,
    );
    return;
  }
  if (status.status === "complete") {
    await removeOutbox(repository, plan.outboxId);
    return;
  }
  await repository.patchStateRoot({
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
  const results = await Promise.allSettled(runners);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

async function reconcileScheduledEvents(
  env: Env,
  repository: EventProgressSweepRepository,
  recovery: EventScheduledRecoveryStore,
  now: () => number,
): Promise<void> {
  const discoveredAtMs = now();
  const maxLeadMs = Math.max(
    ...Object.values(EVENT_ANNOUNCEMENT_SPECS).map((spec) => spec.leadMs),
  );
  const visited = new Set<string>();
  const failures: unknown[] = [];
  const recoverCandidate = async ({
    cursor,
    event,
  }: ScheduledEventRecoveryCandidate) => {
    const { eventId, startAtMs } = cursor;
    if (visited.has(eventId)) return;
    visited.add(eventId);
    if (!event) {
      console.error(
        JSON.stringify({
          event: "scheduled_event_recovery_invalid_record",
          eventId,
        }),
      );
      return;
    }
    const results = await Promise.allSettled([
      scheduleEventAnnouncements(
        env,
        repository,
        eventId,
        event,
        discoveredAtMs,
      ),
      (async () => {
        const plan = await buildEventProgressPlan(
          {
            eventId,
            sourceKey: `start:${eventId}:${startAtMs}`,
            reason: "scheduled-start-reconciliation",
            runAtMs: startAtMs,
          },
          discoveredAtMs,
        );
        const existing = await repository.getStatePath(
          `${EVENT_PROGRESS_OUTBOX_ROOT}/${plan.outboxId}`,
        );
        if (existing === null) {
          await repository.patchStateRoot({
            [`${EVENT_PROGRESS_OUTBOX_ROOT}/${plan.outboxId}`]: plan.outbox,
          });
        }
        await dispatchOutboxPlan(env, repository, plan, now);
      })(),
    ]);
    const eventFailures = rejectedReasons(results);
    if (eventFailures.length > 0) {
      failures.push(...eventFailures);
      console.error(
        JSON.stringify({
          event: "scheduled_event_recovery_failed",
          eventId,
        }),
      );
    }
  };
  const [urgent, background] = await Promise.allSettled([
    (async () => {
      const rows = await recovery.listUrgent(
        discoveredAtMs + maxLeadMs + SCHEDULED_EVENT_RECOVERY_MARGIN_MS,
      );
      await forEachConcurrent(
        rows,
        EVENT_PROGRESS_SWEEP_CONCURRENCY,
        recoverCandidate,
      );
    })(),
    (async () => {
      const snapshot = await recovery.readCursor();
      return { snapshot, rows: await recovery.listPage(snapshot.cursor) };
    })(),
  ]);
  if (urgent.status === "rejected") failures.push(urgent.reason);
  if (background.status === "rejected") {
    failures.push(background.reason);
  } else {
    const { snapshot, rows } = background.value;
    const page = rows.slice(0, SCHEDULED_EVENT_RECOVERY_PAGE_SIZE);
    await forEachConcurrent(
      page,
      EVENT_PROGRESS_SWEEP_CONCURRENCY,
      recoverCandidate,
    );
    if (urgent.status === "fulfilled") {
      const nextCursor =
        rows.length > SCHEDULED_EVENT_RECOVERY_PAGE_SIZE
          ? page[page.length - 1].cursor
          : null;
      try {
        await recovery.checkpoint(snapshot.revision, nextCursor, now());
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "scheduled-event-reconciliation-failed");
  }
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
        !isSafeRecordKey(record.eventId) ||
        !isSafeRecordKey(record.inviteId) ||
        !isSafeRecordKey(record.matchId) ||
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
      await repository.patchStateRoot({
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
  await requireActiveDurableMatchState(env.PROFILE_GAMES_DB);
  await withEventProgressDispatchAdmission(env.EVENT_DB, (admission) =>
    sweepAdmittedEventProgress(env, dependencies, admission),
  );
}

async function sweepAdmittedEventProgress(
  env: Env,
  dependencies: EventProgressSweepDependencies,
  admission: EventWriteAdmission,
): Promise<void> {
  const repository =
    dependencies.repository || createEventGameplayRepository(env);
  const now = dependencies.now || Date.now;
  const ratingRepository =
    dependencies.ratingRepository === null
      ? null
      : dependencies.ratingRepository ||
        createRatingRepository(env, createEventGameplayRepository(env));
  const value = toRecord(
    await repository.getStatePath(EVENT_PROGRESS_OUTBOX_ROOT, {
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
    reconcileScheduledEvents(
      env,
      repository,
      dependencies.scheduledRecovery ||
        createEventScheduledRecoveryStore(env.EVENT_DB, admission),
      now,
    ),
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
      repository.transactStatePath(path, updater, signal),
    releaseTransactPath: (path, updater) =>
      repository.transactStatePath(path, updater),
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
      state: createEventStateAdapter(repository, signal),
      readMatchPair: (input) =>
        readGameplayMatchPair(repository, input, signal),
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
