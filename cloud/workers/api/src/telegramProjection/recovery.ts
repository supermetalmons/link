import type {
  GameSessionPort,
  GameSessionRecoveryContext,
} from "../gameSessionContracts.ts";
import { createEventGameplayRepository } from "../eventRepository.ts";
import { createGameplayRepository } from "../gameplayRepository.ts";
import { createRatingRepository } from "../ratingRepository.ts";
import type { RatingProjectionRepository } from "../ratingContracts.ts";
import { isSafeRecordKey } from "../recordKeys.ts";
import type { AutomatchOutboxClaimSnapshot } from "../automatchD1/types.ts";
import type {
  AutomatchTelegramProjectionTask,
  TelegramProjectionTask,
} from "../telegramProjectionTasks.ts";
import { parseAutomatchTelegramProjectionOutbox as parseOutbox } from "../telegramProjectionOutbox.ts";
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
  recoverAndEnqueueProjectionScan,
  sendQueueTasks,
} from "../projectionSweep.ts";
import { PROJECTION_SWEEP_LIMIT } from "./policy.ts";
import { projectionRecoveryPages } from "../projectionRecoveryPages.ts";
import type {
  ProjectionRecoveryDependencies,
  ProjectionLogger,
} from "./types.ts";

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type AutomatchSweepCandidate = {
  task: AutomatchTelegramProjectionTask;
  updatedAtMs: number;
  snapshot?: AutomatchOutboxClaimSnapshot;
};

type AutomatchSweepEntry =
  | { kind: "candidate"; value: AutomatchSweepCandidate }
  | { inviteId: string; kind: "invalid" };

function automatchSweepEntries(
  value: unknown,
  snapshots?: ReadonlyMap<string, AutomatchOutboxClaimSnapshot>,
): AutomatchSweepEntry[] {
  const records = toRecord(value) || {};
  return Object.entries(records).flatMap(([inviteId, raw]) => {
    const outbox = parseOutbox(raw);
    const snapshot = snapshots?.get(inviteId);
    return [
      outbox && isSafeRecordKey(inviteId)
        ? {
            kind: "candidate" as const,
            value: {
              ...(snapshot ? { snapshot } : {}),
              task: {
                kind: "automatch-telegram-projection" as const,
                inviteId,
                requestId: outbox.requestId,
              },
              updatedAtMs: outbox.updatedAtMs,
            },
          }
        : { kind: "invalid" as const, inviteId },
    ];
  });
}

export function automatchSweepCandidates(
  value: unknown,
): AutomatchSweepCandidate[] {
  return automatchSweepEntries(value).flatMap((entry) =>
    entry.kind === "candidate" ? [entry.value] : [],
  );
}

export function automatchSweepTasks(value: unknown): TelegramProjectionTask[] {
  return automatchSweepCandidates(value).map(({ task }) => task);
}

export async function claimAutomatchSweepCandidate(
  state: GameSessionPort,
  candidate: AutomatchSweepCandidate,
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

async function markInvalidAutomatchSweepEntry(
  state: GameSessionRecoveryContext,
  inviteId: string,
  nowMs: number,
): Promise<void> {
  await state.projectionRecovery.transactRawAutomatchTelegramOutbox(
    inviteId,
    (current) => {
      const record = toRecord(current);
      const updatedAtMs = record?.updatedAtMs;
      if (
        !record ||
        (parseOutbox(current) && isSafeRecordKey(inviteId)) ||
        typeof updatedAtMs !== "number" ||
        !Number.isFinite(updatedAtMs) ||
        updatedAtMs > nowMs
      ) {
        return { commit: false, decision: "changed" };
      }
      return {
        value: {
          ...record,
          status: "dead",
          reason: "invalid-record",
          updatedAtMs: null,
          deadAtMs: nowMs,
        },
        decision: "dead",
      };
    },
  );
}

export async function sendTaskBatches(
  queue: Queue<TelegramProjectionTask>,
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
      (page) => automatchSweepEntries(page.entries, page.snapshots),
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
        (inviteId) => markInvalidAutomatchSweepEntry(state, inviteId, nowMs),
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
        queue: env.TELEGRAM_PROJECTION_QUEUE,
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
    let sentCount = 0;
    const failures: unknown[] = [];
    for await (const { entries, itemOffset } of pages) {
      const result = await recoverAndEnqueueProjectionScan({
        entries,
        queue: env.TELEGRAM_PROJECTION_QUEUE,
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
              itemIndex: itemOffset + itemIndex,
              operationId:
                entry.kind === "candidate"
                  ? entry.value.operationId
                  : undefined,
            },
            error,
          ),
      });
      sentCount += result.sentCount;
      failures.push(...result.failures.map(({ error }) => error));
    }
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
      env.TELEGRAM_PROJECTION_QUEUE,
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
