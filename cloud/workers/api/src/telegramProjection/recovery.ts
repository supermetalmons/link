import type { QueueProducer } from "../queueProducers.ts";
import { queueFor } from "../queueProducers.ts";
import {
  readAutomatchTelegramRecoveryEntries,
  type AutomatchTelegramRecoveryCandidate,
} from "../automatchProjectionRecords.ts";
import type {
  GameSessionPort,
  GameSessionRecoveryContext,
} from "../gameSessionContracts.ts";
import { createEventGameplayRepository } from "../eventRepository.ts";
import { createGameplayRepository } from "../gameplayRepository.ts";
import { createRatingRepository } from "../ratingRepository.ts";
import type { RatingProjectionRepository } from "../ratingContracts.ts";
import type { TelegramProjectionTask } from "../telegramProjectionTasks.ts";
import { readTelegramStorageMode } from "../telegramD1.ts";
import { sweepEventTelegramProjections } from "../eventTelegramProjection.ts";
import { createEventProjectionRecoveryStore } from "../eventProjectionRecoveryD1.ts";
import {
  logRecoveryEvent,
  reportRecoveryFailure,
} from "../recoveryReporting.ts";
import {
  claimAndEnqueueProjectionTasks,
  collectProjectionRepairs,
  recoverAndEnqueueProjectionPages,
  sendQueueTasks,
} from "../projectionSweep.ts";
import { PROJECTION_SWEEP_LIMIT } from "./policy.ts";
import { projectionRecoveryPages } from "../projectionRecoveryPages.ts";
import type {
  ProjectionRecoveryDependencies,
  ProjectionLogger,
} from "./types.ts";

export function automatchSweepCandidates(
  value: unknown,
): AutomatchTelegramRecoveryCandidate[] {
  return readAutomatchTelegramRecoveryEntries(value).flatMap((entry) =>
    entry.kind === "candidate" ? [entry.value] : [],
  );
}

export function automatchSweepTasks(value: unknown): TelegramProjectionTask[] {
  return automatchSweepCandidates(value).map(({ task }) => task);
}

export async function claimAutomatchSweepCandidate(
  state: GameSessionPort,
  candidate: AutomatchTelegramRecoveryCandidate,
  nowMs: number,
): Promise<boolean> {
  return state.claimAutomatchTelegramOutbox(
    candidate.task.inviteId,
    candidate.task.requestId,
    candidate.updatedAtMs,
    nowMs,
    undefined,
    candidate.snapshot,
  );
}

export async function sendTaskBatches(
  queue: Pick<QueueProducer<TelegramProjectionTask>, "sendBatch">,
  tasks: TelegramProjectionTask[],
): Promise<void> {
  return sendQueueTasks(queue, tasks);
}

export async function sweepAutomatchProjections(
  env: Env,
  state: GameSessionPort & GameSessionRecoveryContext,
  logger: ProjectionLogger,
  nowMs: number,
): Promise<number> {
  try {
    const pages = projectionRecoveryPages(
      (excludedIdentities) =>
        state.projectionRecovery.listDueAutomatchTelegramOutboxesPage(
          nowMs,
          PROJECTION_SWEEP_LIMIT,
          excludedIdentities,
        ),
      (page) =>
        readAutomatchTelegramRecoveryEntries(page.entries, page.snapshots),
    );
    let sentCount = 0;
    const claimFailures: Error[] = [];
    const repairFailures: Error[] = [];
    for await (const { entries, itemOffset } of pages) {
      const candidates = entries.flatMap((entry) =>
        entry.kind === "candidate" ? [entry.value] : [],
      );
      const invalidInviteIds = entries.flatMap((entry) =>
        entry.kind === "invalid" ? [entry.inviteId] : [],
      );
      const { failures: pageRepairFailures } = await collectProjectionRepairs(
        invalidInviteIds,
        (inviteId) =>
          state.projectionRecovery.repairInvalidAutomatchTelegramOutbox(
            inviteId,
            nowMs,
          ),
        "projection-invalid-record-failed",
        (inviteId, error, itemIndex) =>
          reportRecoveryFailure(
            logger,
            {
              event: "telegram_projection_recovery_record_failed",
              scope: "telegram",
              source: "automatch",
              phase: "repair",
              itemIndex: itemOffset + itemIndex,
              inviteId,
            },
            error,
          ),
      );
      const result = await claimAndEnqueueProjectionTasks({
        candidates,
        claim: (candidate) =>
          claimAutomatchSweepCandidate(state, candidate, nowMs),
        toTask: ({ task }) => task,
        queue: queueFor(env, "TELEGRAM_PROJECTION_QUEUE"),
        fallbackErrorMessage: "projection-claim-failed",
        onClaimFailure: ({ task }, error, itemIndex) =>
          reportRecoveryFailure(
            logger,
            {
              event: "telegram_projection_recovery_record_failed",
              scope: "telegram",
              source: "automatch",
              phase: "claim",
              itemIndex: itemOffset + itemIndex,
              inviteId: task.inviteId,
            },
            error,
          ),
      });
      sentCount += result.sentCount;
      claimFailures.push(...result.claimFailures);
      repairFailures.push(...pageRepairFailures);
    }
    if (claimFailures.length > 0) {
      throw claimFailures[0];
    }
    if (repairFailures.length > 0) {
      throw repairFailures[0];
    }
    return sentCount;
  } catch (error) {
    reportRecoveryFailure(
      logger,
      {
        event: "telegram_projection_automatch_sweep_failed",
        scope: "telegram",
        source: "automatch",
        phase: "sweep",
      },
      error,
    );
    throw error;
  }
}

export async function sweepRatingProjections(
  env: Env,
  rating: RatingProjectionRepository,
  logger: ProjectionLogger,
  nowMs: number,
): Promise<number> {
  try {
    const pages = projectionRecoveryPages((excludedIdentities) =>
      rating.scanDueRatingTelegramProjectionsPage(
        nowMs,
        PROJECTION_SWEEP_LIMIT,
        excludedIdentities,
      ),
    );
    const { sentCount, failures } = await recoverAndEnqueueProjectionPages({
      pages,
      queue: queueFor(env, "TELEGRAM_PROJECTION_QUEUE"),
      async quarantine(entry) {
        const quarantined = await rating.quarantineRatingRecoveryEntry(
          entry,
          nowMs,
        );
        if (quarantined) {
          logRecoveryEvent(logger, "error", {
            event: "telegram_projection_recovery_record_quarantined",
            scope: "telegram",
            source: "rating",
            ...quarantined,
          });
        }
      },
      async processCandidate(record) {
        if (
          await rating.claimRatingTelegramProjection(
            record.operationId,
            record.revision,
            nowMs,
          )
        ) {
          return {
            kind: "rating-telegram-projection",
            operationId: record.operationId,
          } satisfies TelegramProjectionTask;
        }
      },
      onFailure: (entry, error, itemIndex, phase) =>
        reportRecoveryFailure(
          logger,
          {
            event: "telegram_projection_recovery_record_failed",
            scope: "telegram",
            source: "rating",
            phase,
            itemIndex,
            operationId:
              entry.kind === "candidate" ? entry.value.operationId : undefined,
          },
          error,
        ),
    });
    if (failures.length > 0) {
      const error = failures[0];
      throw error instanceof Error
        ? error
        : new Error("projection-claim-failed");
    }
    return sentCount;
  } catch (error) {
    reportRecoveryFailure(
      logger,
      {
        event: "telegram_projection_rating_sweep_failed",
        scope: "telegram",
        source: "rating",
        phase: "sweep",
      },
      error,
    );
    throw error;
  }
}

export async function sweepTelegramProjections(
  env: Env,
  dependencies: ProjectionRecoveryDependencies = {},
): Promise<{ automatch: number; event: number; rating: number }> {
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const createStateRepository =
    dependencies.createStateRepository ||
    ((workerEnv: Env) => createEventGameplayRepository(workerEnv));
  const nowMs = now();
  const state = createStateRepository(env);
  const createRating =
    dependencies.createRating ||
    ((workerEnv: Env) =>
      createRatingRepository(
        workerEnv.PROFILE_DB,
        createGameplayRepository(workerEnv),
        state,
      ));
  const rating = createRating(env);
  const [automatch, event, ratingCount] = await Promise.allSettled([
    sweepAutomatchProjections(env, state, logger, nowMs),
    sweepEventTelegramProjections(
      queueFor(env, "TELEGRAM_PROJECTION_QUEUE"),
      (
        dependencies.createEventRecovery ||
        ((workerEnv: Env) =>
          createEventProjectionRecoveryStore(workerEnv.EVENT_DB, "telegram"))
      )(env),
      nowMs,
      logger,
    ).catch((error) => {
      reportRecoveryFailure(
        logger,
        {
          event: "telegram_projection_event_sweep_failed",
          scope: "telegram",
          source: "event",
          phase: "sweep",
        },
        error,
      );
      throw error;
    }),
    sweepRatingProjections(env, rating, logger, nowMs),
  ]);
  if (
    automatch.status === "rejected" ||
    event.status === "rejected" ||
    ratingCount.status === "rejected"
  ) {
    throw new AggregateError(
      [automatch, event, ratingCount].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      ),
      "telegram-projection-sweep-failed",
    );
  }
  return {
    automatch: automatch.value,
    event: event.value,
    rating: ratingCount.value,
  };
}

export async function handleTelegramProjectionSweep(
  _controller: ScheduledController,
  env: Env,
): Promise<void> {
  if ((await readTelegramStorageMode(env.TELEGRAM_DB)) === "frozen") {
    logRecoveryEvent(console, "info", {
      event: "telegram_projection_sweep_frozen",
    });
    return;
  }
  const result = await sweepTelegramProjections(env);
  logRecoveryEvent(console, "info", {
    event: "telegram_projection_sweep_completed",
    automatch: result.automatch,
    eventCount: result.event,
    rating: result.rating,
  });
}
