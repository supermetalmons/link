import {
  buildEventProgressPlan,
  parseEventProgressOutbox,
  workflowIdFromOutboxId,
} from "./eventProgressCodec.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import { requireActiveDurableMatchState } from "./matchStateAuthority.ts";
import { createRatingRepository } from "./ratingRepository.ts";
import type { RatingEventProgressRepository } from "./ratingContracts.ts";
import { PROFILE_BACKGROUND_SWEEP_LIMIT } from "./profileBackgroundLimits.ts";
import { runRecoveryItems } from "./recoveryRunner.ts";
import {
  logRecoveryEvent,
  reportRecoveryFailure,
  type RecoveryFailureContext,
} from "./recoveryReporting.ts";
import { summarizeError } from "./errorSummary.ts";
import { createScheduledRecoveryBudget } from "./scheduledRecoveryBudget.ts";
import {
  createEventGameplayRepository,
  type EventGameplayRepository,
} from "./eventRepository.ts";
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
  dispatchOutboxSnapshot,
  withEventProgressDispatchAdmission,
} from "./eventProgressDispatch.ts";
import {
  createEventProgressRecoveryStore,
  type EventProgressRecoveryStore,
} from "./eventProgressRecoveryD1.ts";

const EVENT_PROGRESS_SWEEP_LIMIT = PROFILE_BACKGROUND_SWEEP_LIMIT;
const EVENT_PROGRESS_SWEEP_CONCURRENCY = 10;
const EVENT_PROGRESS_OUTBOX_CONCURRENCY = 5;
const EVENT_PROGRESS_RATING_CONCURRENCY = 5;
const RATING_EVENT_PROGRESS_SCHEMA_VERSION = 1;

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
  | "scanDueRatingEventProgress"
  | "quarantineRatingRecoveryEntry"
  | "markRatingEventProgress"
>;

export type EventProgressSweepDependencies = {
  now?: () => number;
  logger?: Pick<Console, "error">;
  ratingRepository?: EventProgressRatingRepository | null;
  repository?: EventProgressSweepRepository;
  scheduledRecovery?: EventScheduledRecoveryStore;
  outboxRecovery?: EventProgressRecoveryStore;
};

async function reconcileScheduledEvents(
  env: Env,
  repository: EventProgressSweepRepository,
  recovery: EventScheduledRecoveryStore,
  outboxRecovery: EventProgressRecoveryStore,
  now: () => number,
  execute: EventProgressWorkExecutor,
): Promise<void> {
  const discoveredAtMs = now();
  const maxLeadMs = Math.max(
    ...Object.values(EVENT_ANNOUNCEMENT_SPECS).map((spec) => spec.leadMs),
  );
  const budget = createScheduledRecoveryBudget(discoveredAtMs);
  const failures: unknown[] = [];
  const recoverCandidate = async ({
    cursor,
    event,
  }: ScheduledEventRecoveryCandidate) => {
    const { eventId, startAtMs } = cursor;
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
        (plan) => dispatchOutboxPlan(env, outboxRecovery, plan.outboxId, now),
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
          const current = await outboxRecovery.ensureScheduledStart(plan);
          await dispatchOutboxSnapshot(env, outboxRecovery, current, now);
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
          error: summarizeError(
            eventFailures.length === 1
              ? eventFailures[0]
              : new AggregateError(
                  eventFailures,
                  "scheduled-event-recovery-failed",
                ),
          ),
        }),
      );
    }
  };
  const [urgent, background] = await Promise.allSettled([
    (async () => {
      const rows = await recovery.listUrgent(
        discoveredAtMs + maxLeadMs + SCHEDULED_EVENT_RECOVERY_MARGIN_MS,
        discoveredAtMs,
      );
      const { selected } = budget.select(rows, "urgent");
      await runRecoveryItems(selected, recoverCandidate, {
        concurrency: EVENT_PROGRESS_SWEEP_CONCURRENCY,
        aggregateErrorMessage: "event-progress-records-failed",
      });
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
    const { selected, traversedCount } = budget.select(page, "background");
    await runRecoveryItems(selected, recoverCandidate, {
      concurrency: EVENT_PROGRESS_SWEEP_CONCURRENCY,
      aggregateErrorMessage: "event-progress-records-failed",
    });
    if (
      urgent.status === "fulfilled" &&
      (traversedCount > 0 || rows.length === 0)
    ) {
      const traversed = page[traversedCount - 1];
      if (traversedCount > 0 && !traversed)
        throw new Error("invalid-event-recovery-traversal");
      const nextCursor =
        traversedCount < rows.length ? (traversed?.cursor ?? null) : null;
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
  outboxRecovery: EventProgressRecoveryStore,
  now: () => number,
  execute: EventProgressWorkExecutor,
  logger: Pick<Console, "error">,
): Promise<void> {
  const nowMs = now();
  const entries = await ratingRepository.scanDueRatingEventProgress(
    nowMs,
    EVENT_PROGRESS_SWEEP_LIMIT,
  );
  let index = 0;
  await runRecoveryItems(
    entries,
    async (entry) => {
      const itemIndex = index++;
      let phase: RecoveryFailureContext["phase"] = "inspect";
      try {
        if (entry.kind === "failure") throw entry.error;
        if (entry.kind === "invalid") {
          phase = "quarantine";
          const quarantined =
            await ratingRepository.quarantineRatingRecoveryEntry(entry, nowMs);
          if (quarantined) {
            logRecoveryEvent(logger, "error", {
              event: "event_progress_recovery_record_quarantined",
              scope: "event-progress",
              source: "rating",
              ...quarantined,
            });
          }
          return;
        }
        const record = entry.value;
        phase = "claim";
        const claimed = await ratingRepository.claimRatingEventProgress(
          record.operationId,
          record.revision,
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
          phase = "quarantine";
          await ratingRepository.markRatingEventProgress(
            record.operationId,
            "dead",
            now(),
            "invalid-event-progress-marker",
          );
          return;
        }
        phase = "enqueue";
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
          await dispatchOutboxPlan(env, outboxRecovery, plan.outboxId, now);
          phase = "cleanup";
          await ratingRepository.markRatingEventProgress(
            record.operationId,
            "done",
            now(),
          );
        });
      } catch (error) {
        reportRecoveryFailure(
          logger,
          {
            event: "event_progress_recovery_record_failed",
            scope: "event-progress",
            source: "rating",
            phase,
            itemIndex,
            ...(entry.kind === "candidate"
              ? {
                  eventId: entry.value.eventId,
                  operationId: entry.value.operationId,
                }
              : {}),
          },
          error,
        );
        throw error;
      }
    },
    {
      concurrency: EVENT_PROGRESS_RATING_CONCURRENCY,
      aggregateErrorMessage: "event-progress-records-failed",
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
  recovery: EventProgressRecoveryStore,
  now: () => number,
  execute: EventProgressWorkExecutor,
  logger: Pick<Console, "error">,
): Promise<void> {
  const records = await recovery.listDue(now(), EVENT_PROGRESS_SWEEP_LIMIT);
  let index = 0;
  await runRecoveryItems(
    records,
    async (snapshot) => {
      const itemIndex = index++;
      const { outboxId, record } = snapshot;
      if (typeof outboxId !== "string") return;
      let phase: RecoveryFailureContext["phase"] = "inspect";
      try {
        const plan = await parseEventProgressOutbox(outboxId, record);
        if (plan) {
          phase = "enqueue";
          await execute(plan.workflowId, () =>
            dispatchOutboxPlan(env, recovery, plan.outboxId, now),
          );
        } else {
          const workflowId = workflowIdFromOutboxId(outboxId);
          if (workflowId) {
            await execute(workflowId, async () => {
              const current = await recovery.read(outboxId);
              if (
                current === null ||
                (await parseEventProgressOutbox(outboxId, current.record))
              )
                return;
              phase = "quarantine";
              await recovery.deadLetter(current, now());
            });
          } else {
            phase = "quarantine";
            await recovery.deadLetter(snapshot, now());
          }
        }
      } catch (error) {
        reportRecoveryFailure(
          logger,
          {
            event: "event_progress_recovery_record_failed",
            scope: "event-progress",
            source: "outbox",
            phase,
            itemIndex,
            outboxId,
          },
          error,
        );
        throw error;
      }
    },
    {
      concurrency: EVENT_PROGRESS_OUTBOX_CONCURRENCY,
      aggregateErrorMessage: "event-progress-records-failed",
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
  const logger = dependencies.logger || console;
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
  const outboxRecovery =
    dependencies.outboxRecovery ||
    createEventProgressRecoveryStore(env.EVENT_DB, admission);
  const results = await Promise.allSettled([
    sweepPersistedEventProgressOutboxes(
      env,
      outboxRecovery,
      now,
      execute,
      logger,
    ),
    reconcileScheduledEvents(
      env,
      repository,
      dependencies.scheduledRecovery ||
        createEventScheduledRecoveryStore(env.EVENT_DB, admission),
      outboxRecovery,
      now,
      execute,
    ),
    ...(ratingRepository
      ? [
          recoverRatingEventProgress(
            env,
            repository,
            ratingRepository,
            outboxRecovery,
            now,
            execute,
            logger,
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
