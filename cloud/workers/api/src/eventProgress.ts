import {
  buildEventProgressPlan,
  parseEventProgressOutbox,
  parseEventProgressParams,
  workflowIdFromOutboxId,
  type EventProgressWorkflowParams,
} from "./eventProgressCodec.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import type {
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepConfig,
} from "cloudflare:workers";
import { requireActiveDurableMatchState } from "./matchStateAuthority.ts";
import { createRatingRepository } from "./ratingRepository.ts";
import type { RatingEventProgressRepository } from "./ratingContracts.ts";
import { PROFILE_BACKGROUND_SWEEP_LIMIT } from "./profileBackgroundLimits.ts";
import { createWorkerEventRuntime } from "./workerEventRuntime.ts";
import {
  createEventGameplayRepository,
  type EventGameplayRepository,
} from "./eventRepository.ts";
import { createEventMutationRepository } from "./eventMutationRepository.ts";
import { scheduleEventAnnouncements } from "./eventPrizeAnnouncementSchedule.ts";
import { EVENT_ANNOUNCEMENT_SPECS } from "./eventAnnouncementKinds.ts";
import {
  createEventProgressWorkExecutor,
  type EventProgressWorkExecutor,
} from "./eventProgressExecution.ts";
import {
  createEventScheduledRecoveryStore,
  SCHEDULED_EVENT_RECOVERY_MARGIN_MS,
  SCHEDULED_EVENT_RECOVERY_PAGE_SIZE,
  type EventScheduledRecoveryStore,
  type ScheduledEventRecoveryCandidate,
} from "./eventScheduledRecoveryD1.ts";
import type { EventWriteAdmission } from "./eventD1.ts";
import {
  dispatchOutboxPlan,
  withEventProgressDispatchAdmission,
} from "./eventProgressDispatch.ts";

export {
  ensureEventProgressWorkflow,
  removeOutbox,
} from "./eventProgressDispatch.ts";

export { createEventRuntimeStore } from "./workerEventRuntime.ts";

export {
  buildEventProgressPlan,
  parseEventProgressOutbox,
  parseEventProgressParams,
  type EventProgressPlan,
  type EventProgressWorkflowParams,
} from "./eventProgressCodec.ts";

const EVENT_PROGRESS_OUTBOX_ROOT = "eventProgressOutbox";
const EVENT_PROGRESS_OUTBOX_DEAD_ROOT = "eventProgressOutboxDead";
const EVENT_PROGRESS_WORKER_UID = "event-progress-worker";
const EVENT_PROGRESS_SWEEP_LIMIT = PROFILE_BACKGROUND_SWEEP_LIMIT;
const EVENT_PROGRESS_SWEEP_CONCURRENCY = 10;
const EVENT_PROGRESS_OUTBOX_CONCURRENCY = 5;
const EVENT_PROGRESS_RATING_CONCURRENCY = 5;
const EVENT_PROGRESS_TIMEOUT_MS = 30_000;
const RATING_EVENT_PROGRESS_SCHEMA_VERSION = 1;

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
  | "readEventProgressOutbox"
  | "commitEventPlan"
  | "readEvent"
  | "listDueEventProgressOutboxes"
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

async function deadLetterOutbox(
  repository: Pick<EventGameplayRepository, "commitEventPlan">,
  outboxId: string,
  originalRecord: unknown,
  nowMs: number,
): Promise<void> {
  await repository.commitEventPlan([
    {
      kind: "progress-dead",
      outboxId,
      value: {
        deadAtMs: nowMs,
        originalRecord: originalRecord === undefined ? null : originalRecord,
        reason: "invalid-event-progress-outbox",
      },
    },
    { kind: "progress-outbox", outboxId, value: null },
  ]);
}

async function forEachConcurrent<T>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const failures: unknown[] = [];
  const runners = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (index < values.length) {
        const value = values[index];
        index += 1;
        try {
          await operation(value);
        } catch (error) {
          failures.push(error);
        }
      }
    },
  );
  const results = await Promise.allSettled(runners);
  failures.push(...rejectedReasons(results));
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "event-progress-records-failed");
  }
}

async function reconcileScheduledEvents(
  env: Env,
  repository: EventProgressSweepRepository,
  recovery: EventScheduledRecoveryStore,
  now: () => number,
  execute: EventProgressWorkExecutor,
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
        execute,
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
        await execute(plan.workflowId, async () => {
          const existing = await repository.readEventProgressOutbox(
            plan.outboxId,
          );
          if (existing === null) {
            await repository.commitEventPlan([
              {
                kind: "progress-outbox",
                outboxId: plan.outboxId,
                value: plan.outbox,
              },
            ]);
          }
          await dispatchOutboxPlan(env, repository, plan, now);
        });
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
  execute: EventProgressWorkExecutor,
): Promise<void> {
  const nowMs = now();
  const records = await ratingRepository.listDueRatingEventProgress(
    nowMs,
    EVENT_PROGRESS_SWEEP_LIMIT,
  );
  await forEachConcurrent(
    records,
    EVENT_PROGRESS_RATING_CONCURRENCY,
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
      await execute(plan.workflowId, async () => {
        await repository.commitEventPlan([
          {
            kind: "progress-outbox",
            outboxId: plan.outboxId,
            value: plan.outbox,
          },
        ]);
        await dispatchOutboxPlan(env, repository, plan, now);
        await ratingRepository.markRatingEventProgress(
          record.operationId,
          "done",
          now(),
        );
      });
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

async function sweepPersistedEventProgressOutboxes(
  env: Env,
  repository: EventProgressSweepRepository,
  now: () => number,
  execute: EventProgressWorkExecutor,
): Promise<void> {
  const records = await repository.listDueEventProgressOutboxes(
    Number.MAX_SAFE_INTEGER,
    EVENT_PROGRESS_SWEEP_LIMIT,
  );
  await forEachConcurrent(
    records,
    EVENT_PROGRESS_OUTBOX_CONCURRENCY,
    async ({ outboxId: rawOutboxId, record }) => {
      const outboxId = String(rawOutboxId);
      const plan = await parseEventProgressOutbox(outboxId, record);
      if (plan) {
        await execute(plan.workflowId, () =>
          dispatchOutboxPlan(env, repository, plan, now),
        );
      } else {
        const workflowId = workflowIdFromOutboxId(outboxId);
        if (workflowId) {
          await execute(workflowId, async () => {
            const current = await repository.readEventProgressOutbox(outboxId);
            if (
              current === null ||
              (await parseEventProgressOutbox(outboxId, current))
            )
              return;
            await deadLetterOutbox(repository, outboxId, current, now());
          });
        } else {
          await deadLetterOutbox(repository, outboxId, record, now());
        }
      }
    },
  );
}

async function sweepAdmittedEventProgress(
  env: Env,
  dependencies: EventProgressSweepDependencies,
  admission: EventWriteAdmission,
): Promise<void> {
  let defaultRepository: EventGameplayRepository | undefined;
  const getDefaultRepository = () =>
    (defaultRepository ||= createEventGameplayRepository(env));
  const repository = dependencies.repository || getDefaultRepository();
  const now = dependencies.now || Date.now;
  const ratingRepository =
    dependencies.ratingRepository === null
      ? null
      : dependencies.ratingRepository ||
        createRatingRepository(
          env.PROFILE_DB,
          getDefaultRepository(),
          getDefaultRepository(),
        );
  const execute = createEventProgressWorkExecutor();
  const results = await Promise.allSettled([
    sweepPersistedEventProgressOutboxes(env, repository, now, execute),
    reconcileScheduledEvents(
      env,
      repository,
      dependencies.scheduledRecovery ||
        createEventScheduledRecoveryStore(env.EVENT_DB, admission),
      now,
      execute,
    ),
    ...(ratingRepository
      ? [
          recoverRatingEventProgress(
            env,
            repository,
            ratingRepository,
            now,
            execute,
          ),
        ]
      : []),
  ]);
  const failures = rejectedReasons(results);
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

export {
  EVENT_PROGRESS_OUTBOX_DEAD_ROOT,
  EVENT_PROGRESS_OUTBOX_ROOT,
  EVENT_PROGRESS_TIMEOUT_MS,
  EVENT_PROGRESS_WORKER_UID,
};
