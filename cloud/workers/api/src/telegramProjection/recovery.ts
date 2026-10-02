import type { GameSessionPort } from "../gameSessionContracts.ts";
import { createEventGameplayRepository } from "../eventRepository.ts";
import { createGameplayRepository } from "../gameplayRepository.ts";
import { createRatingRepository } from "../ratingRepository.ts";
import type { RatingProjectionRepository } from "../ratingContracts.ts";
import { isSafeRecordKey } from "../recordKeys.ts";
import type {
  AutomatchTelegramProjectionTask,
  TelegramProjectionTask,
} from "../telegramProjectionTasks.ts";
import { parseAutomatchTelegramProjectionOutbox as parseOutbox } from "../telegramProjectionOutbox.ts";
import { readTelegramStorageMode } from "../telegramD1.ts";
import { sweepEventTelegramProjections } from "../eventTelegramProjection.ts";
import {
  logRecoveryEvent,
  reportRecoveryFailure,
} from "../recoveryReporting.ts";
import {
  claimAndEnqueueProjectionTasks,
  collectProjectionRepairs,
  sendQueueTasks,
} from "../projectionSweep.ts";
import { PROJECTION_SWEEP_LIMIT } from "./policy.ts";
import type { ProjectionDependencies, ProjectionLogger } from "./types.ts";

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type AutomatchSweepCandidate = {
  task: AutomatchTelegramProjectionTask;
  updatedAtMs: number;
};

type AutomatchSweepEntry =
  | { kind: "candidate"; value: AutomatchSweepCandidate }
  | { inviteId: string; kind: "invalid" };

function automatchSweepEntries(value: unknown): AutomatchSweepEntry[] {
  const records = toRecord(value) || {};
  return Object.entries(records).flatMap(([inviteId, raw]) => {
    const outbox = parseOutbox(raw);
    return [
      outbox && isSafeRecordKey(inviteId)
        ? {
            kind: "candidate" as const,
            value: {
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
  );
}

async function markInvalidAutomatchSweepEntry(
  state: GameSessionPort,
  inviteId: string,
  nowMs: number,
): Promise<void> {
  await state.transactAutomatchTelegramOutbox(inviteId, (current) => {
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
  });
}

export async function sendTaskBatches(
  queue: Queue<TelegramProjectionTask>,
  tasks: TelegramProjectionTask[],
): Promise<void> {
  return sendQueueTasks(queue, tasks);
}

export async function sweepAutomatchProjections(
  env: Env,
  state: GameSessionPort,
  logger: ProjectionLogger,
  nowMs: number,
): Promise<number> {
  try {
    const value = await state.listDueAutomatchTelegramOutboxes(
      nowMs,
      PROJECTION_SWEEP_LIMIT,
    );
    const entries = automatchSweepEntries(value);
    const candidates = entries.flatMap((entry) =>
      entry.kind === "candidate" ? [entry.value] : [],
    );
    const invalidInviteIds = entries.flatMap((entry) =>
      entry.kind === "invalid" ? [entry.inviteId] : [],
    );
    const { failures: repairFailures } = await collectProjectionRepairs(
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
            itemIndex,
            inviteId,
          },
          error,
        ),
    );
    const { sentCount, claimFailure } = await claimAndEnqueueProjectionTasks({
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
            itemIndex,
            inviteId: task.inviteId,
          },
          error,
        ),
    });
    if (claimFailure) {
      throw claimFailure;
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
    const records = await rating.listDueRatingTelegramProjections(
      nowMs,
      PROJECTION_SWEEP_LIMIT,
    );
    const { sentCount, claimFailure } = await claimAndEnqueueProjectionTasks({
      candidates: records,
      claim: (record) =>
        rating.claimRatingTelegramProjection(
          record.operationId,
          record.revision,
          nowMs,
        ),
      toTask: (record): TelegramProjectionTask => ({
        kind: "rating-telegram-projection",
        operationId: record.operationId,
      }),
      queue: env.TELEGRAM_PROJECTION_QUEUE,
      fallbackErrorMessage: "projection-claim-failed",
      onClaimFailure: (record, error, itemIndex) =>
        reportRecoveryFailure(
          logger,
          {
            event: "telegram_projection_recovery_record_failed",
            scope: "telegram",
            source: "rating",
            phase: "claim",
            itemIndex,
            operationId: record.operationId,
          },
          error,
        ),
    });
    if (claimFailure) {
      throw claimFailure;
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
  dependencies: ProjectionDependencies = {},
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
      state,
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
