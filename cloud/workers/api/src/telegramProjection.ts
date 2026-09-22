import type { EventReads } from "../../../runtime/eventReads.js";
import { ackQueueMessage, retryQueueMessage } from "./queueMessage.ts";
import {} from "../../../runtime/telegram/automatchSource.js";
import {
  buildTelegramEditDesired,
  buildTelegramSendDesired,
} from "../../../runtime/telegram/desiredStateCore.js";
import {
  asObject,
  buildAutomatchProjectionGuard,
  buildAutomatchTelegramProjection,
  evaluateAutomatchProjectionUpdate,
  mergeRatingResultFragment,
  shouldProjectRatingTelegramUpdate,
  type AutomatchTelegramProjection,
} from "../../../runtime/telegram/projectionCore.js";
import type { EventStore } from "./eventStoreContracts.ts";
import type { GameSessionPort } from "./gameSessionContracts.ts";
import { createEventGameplayRepository } from "./eventRepository.ts";
import type { EventOutboxReads } from "./eventOutboxReadRepository.ts";
import { createGameplayRepository } from "./gameplayRepository.ts";
import { createRatingRepository } from "./ratingRepository.ts";
import type { RatingProjectionRepository } from "./ratingContracts.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import {
  parseTelegramProjectionTask,
  TELEGRAM_PROJECTION_SCHEMA_VERSION,
  type AutomatchTelegramProjectionTask,
  type RatingTelegramProjectionTask,
  type TelegramProjectionTask,
} from "./telegramProjectionTasks.ts";
import {
  enqueueInitialTelegramDelivery,
  type InitialTelegramDelivery,
} from "./telegramDeliveryTasks.ts";
import type { TelegramRepository } from "../../../runtime/telegram/deliveryEngine.js";
import {
  createD1TelegramAnnouncementRepository,
  createD1TelegramRepository,
  readTelegramStorageMode,
  type TelegramAnnouncementRepository,
  type TelegramStorageMode,
} from "./telegramD1.ts";
import {
  processEventProjectionTask,
  sweepEventTelegramProjections,
} from "./eventTelegramProjection.ts";
import { PROFILE_BACKGROUND_SWEEP_LIMIT } from "./profileBackgroundLimits.ts";
import {
  claimAndEnqueueProjectionTasks,
  collectProjectionRepairs,
  sendQueueTasks,
} from "./projectionSweep.ts";
import {
  infrastructureRetryDelaySeconds as projectionRetryDelaySeconds,
  MAX_INFRASTRUCTURE_RETRY_DELAY_SECONDS as MAX_PROJECTION_RETRY_DELAY_SECONDS,
} from "./queueRetry.ts";

const PROJECTION_SWEEP_LIMIT = PROFILE_BACKGROUND_SWEEP_LIMIT;
const PROJECTION_INPUT_RETRIES = 5;

type AutomatchProjectionOutbox = {
  requestId: string;
  schemaVersion: number;
  status: string;
  updatedAtMs: number;
};

type ProjectionLogger = Pick<Console, "error" | "info">;

type ProjectionDependencies = {
  createRating?: (env: Env) => RatingProjectionRepository;
  createStateRepository?: (
    env: Env,
  ) => GameSessionPort &
    EventStore &
    Pick<EventReads, "readEvent"> &
    Pick<EventOutboxReads, "listDueEventTelegramProjectionOutboxes">;
  createTelegram?: (env: Env) => TelegramRepository;
  createAnnouncements?: (
    env: Env,
  ) => Pick<TelegramAnnouncementRepository, "get">;
  enqueueDelivery?: (input: InitialTelegramDelivery) => Promise<unknown>;
  logger?: ProjectionLogger;
  now?: () => number;
  readStorageMode?: (db: D1Database) => Promise<TelegramStorageMode>;
};

type AutomatchProjectionResult = {
  delivery?: { messageKey: string; revision: string };
  status: "projected" | "stale" | "invalid";
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseOutbox(value: unknown): AutomatchProjectionOutbox | null {
  const record = toRecord(value);
  const updatedAtMs = record?.updatedAtMs;
  return record?.schemaVersion === TELEGRAM_PROJECTION_SCHEMA_VERSION &&
    record.status === "pending" &&
    typeof record.requestId === "string" &&
    isSafeRecordKey(record.requestId) &&
    typeof updatedAtMs === "number" &&
    Number.isFinite(updatedAtMs) &&
    updatedAtMs >= 0
    ? {
        schemaVersion: record.schemaVersion,
        status: record.status,
        requestId: record.requestId,
        updatedAtMs: Math.floor(updatedAtMs),
      }
    : null;
}

function inputFingerprint(input: {
  inviteData: unknown;
  source: unknown;
}): string {
  return JSON.stringify({
    source: input.source,
    guestId: toRecord(input.inviteData)?.guestId || null,
  });
}

function projectionDesired(projection: AutomatchTelegramProjection) {
  return projection.operation === "send"
    ? buildTelegramSendDesired(projection)
    : buildTelegramEditDesired(projection);
}

async function readAutomatchInputs(
  inviteId: string,
  state: GameSessionPort,
): Promise<{ inviteData: unknown; source: unknown }> {
  const [source, inviteData] = await Promise.all([
    state.readAutomatchTelegramSource(inviteId),
    state.readInviteMetadata(inviteId),
  ]);
  return { source, inviteData };
}

async function projectAutomatchSource(
  inviteId: string,
  state: GameSessionPort,
  telegram: TelegramRepository,
): Promise<AutomatchProjectionResult> {
  let input = await readAutomatchInputs(inviteId, state);
  for (let attempt = 0; attempt < PROJECTION_INPUT_RETRIES; attempt += 1) {
    const projection = buildAutomatchTelegramProjection({
      inviteId,
      source: toRecord(input.source),
      inviteData: toRecord(input.inviteData),
    });
    if (!projection) {
      return { status: "invalid" };
    }
    const desired = projectionDesired(projection);
    const transaction = await telegram.transactMessage(
      projection.messageKey,
      (current) => {
        const decision = evaluateAutomatchProjectionUpdate(current, projection);
        if (!decision.allowed) {
          return { commit: false, decision: decision.reason };
        }
        return {
          value: {
            ...asObject(current),
            desired,
            automatchProjection: buildAutomatchProjectionGuard(projection),
          },
          decision: decision.reason,
        };
      },
    );
    const latest = await readAutomatchInputs(inviteId, state);
    if (inputFingerprint(input) === inputFingerprint(latest)) {
      return transaction.committed
        ? {
            status: "projected",
            delivery: {
              messageKey: projection.messageKey,
              revision: desired.revision,
            },
          }
        : { status: "stale" };
    }
    input = latest;
  }
  throw new Error("telegram-projection-source-kept-changing");
}

async function settleAutomatchOutbox(
  state: GameSessionPort,
  task: AutomatchTelegramProjectionTask,
  disposition: "clear" | "dead",
  now: () => number,
  reason = "",
): Promise<boolean> {
  const result = await state.transactAutomatchTelegramOutbox(
    task.inviteId,
    (current) => {
      const record = toRecord(current);
      if (record?.requestId !== task.requestId) {
        return { commit: false, decision: "stale" };
      }
      return disposition === "clear"
        ? { value: null, decision: "cleared" }
        : {
            value: {
              ...record,
              status: "dead",
              reason,
              updatedAtMs: null,
              deadAtMs: now(),
            },
            decision: "dead",
          };
    },
  );
  return result.committed;
}

async function processAutomatchTask(
  task: AutomatchTelegramProjectionTask,
  state: GameSessionPort,
  enqueueDelivery: (input: InitialTelegramDelivery) => Promise<unknown>,
  now: () => number,
  telegram: TelegramRepository,
): Promise<string> {
  const outbox = parseOutbox(
    await state.readAutomatchTelegramOutbox(task.inviteId),
  );
  if (!outbox || outbox.requestId !== task.requestId) {
    return "stale";
  }
  const projection = await projectAutomatchSource(
    task.inviteId,
    state,
    telegram,
  );
  if (projection.status === "invalid") {
    await settleAutomatchOutbox(state, task, "dead", now, "invalid-source");
    return "dead";
  }
  if (projection.delivery) {
    await enqueueDelivery({
      ...projection.delivery,
      generation: `automatch:${task.requestId}:${projection.delivery.revision}`,
      producer: "automatch-projection",
    });
  }
  await settleAutomatchOutbox(state, task, "clear", now);
  return projection.status;
}

async function processRatingTask(
  task: RatingTelegramProjectionTask,
  state: GameSessionPort,
  rating: RatingProjectionRepository,
  enqueueDelivery: (input: InitialTelegramDelivery) => Promise<unknown>,
  now: () => number,
  telegram: TelegramRepository,
): Promise<string> {
  const update = await rating.readRatingUpdate(task.operationId);
  if (!update || update.telegramProjectionState !== "pending") {
    return "stale";
  }
  if (
    update.telegramProjectionVersion !== TELEGRAM_PROJECTION_SCHEMA_VERSION ||
    !shouldProjectRatingTelegramUpdate(update)
  ) {
    await rating.markRatingTelegramProjection(
      task.operationId,
      "dead",
      now(),
      "invalid-record",
    );
    return "dead";
  }
  let mergeReason = "skipped";
  await state.transactAutomatchTelegramSource(update.inviteId, (source) => {
    const merged = mergeRatingResultFragment(source, update);
    mergeReason = merged.reason;
    return merged.changed
      ? { value: merged.source, decision: merged.reason }
      : { commit: false, decision: merged.reason };
  });
  if (mergeReason === "skipped") {
    await rating.markRatingTelegramProjection(
      task.operationId,
      "dead",
      now(),
      "invalid-source",
    );
    return "dead";
  }
  const projection = await projectAutomatchSource(
    update.inviteId,
    state,
    telegram,
  );
  if (projection.status === "invalid") {
    await rating.markRatingTelegramProjection(
      task.operationId,
      "dead",
      now(),
      "invalid-projection",
    );
    return "dead";
  }
  if (projection.delivery) {
    await enqueueDelivery({
      ...projection.delivery,
      generation: `rating:${task.operationId}:${projection.delivery.revision}`,
      producer: "rating-projection",
    });
  }
  await rating.markRatingTelegramProjection(task.operationId, "done", now());
  return mergeReason === "duplicate" ? "duplicate" : projection.status;
}

export async function handleTelegramProjectionMessage(
  message: Message<unknown>,
  env: Env,
  dependencies: ProjectionDependencies = {},
): Promise<void> {
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const task = parseTelegramProjectionTask(message.body);
  if (!task) {
    ackQueueMessage(message, {
      entry: { event: "telegram_projection_queue_invalid_message" },
      level: "error",
      logger,
    });
    return;
  }
  const createStateRepository =
    dependencies.createStateRepository ||
    ((workerEnv: Env) => createEventGameplayRepository(workerEnv));
  const enqueueDelivery =
    dependencies.enqueueDelivery ||
    ((input: InitialTelegramDelivery) =>
      enqueueInitialTelegramDelivery(env, input));
  const storageMode = await (
    dependencies.readStorageMode || readTelegramStorageMode
  )(env.TELEGRAM_DB);
  if (storageMode === "frozen") {
    retryQueueMessage(message, 60, {
      entry: { event: "telegram_projection_queue_frozen" },
      level: "info",
      logger,
    });
    return;
  }
  try {
    const state = createStateRepository(env);
    const createRating =
      dependencies.createRating ||
      ((workerEnv: Env) =>
        createRatingRepository(
          workerEnv.PROFILE_DB,
          createGameplayRepository(workerEnv),
          state,
        ));
    const telegram = dependencies.createTelegram
      ? dependencies.createTelegram(env)
      : createD1TelegramRepository(env.TELEGRAM_DB, { now });
    let status: string;
    if (task.kind === "automatch-telegram-projection") {
      status = await processAutomatchTask(
        task,
        state,
        enqueueDelivery,
        now,
        telegram,
      );
    } else if (task.kind === "event-telegram-projection") {
      status = await processEventProjectionTask(
        task,
        state,
        createRating(env),
        enqueueDelivery,
        now,
        telegram,
        {
          repository: dependencies.createAnnouncements
            ? dependencies.createAnnouncements(env)
            : createD1TelegramAnnouncementRepository(env.TELEGRAM_DB),
          chatId: env.TELEGRAM_EXTRA_CHAT_ID.trim(),
        },
      );
    } else {
      status = await processRatingTask(
        task,
        state,
        createRating(env),
        enqueueDelivery,
        now,
        telegram,
      );
    }
    ackQueueMessage(message, {
      entry: {
        event: "telegram_projection_queue_processed",
        kind: task.kind,
        status,
      },
      level: "info",
      logger,
    });
  } catch (error) {
    retryQueueMessage(message, projectionRetryDelaySeconds(message.attempts), {
      entry: {
        event: "telegram_projection_queue_failed",
        kind: task.kind,
        code: error instanceof Error ? error.message : "unknown",
      },
      level: "error",
      logger,
    });
  }
}

export async function handleTelegramProjectionQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  const state = createEventGameplayRepository(env);
  const rating = createRatingRepository(env.PROFILE_DB, state, state);
  for (const message of batch.messages) {
    await handleTelegramProjectionMessage(message, env, {
      createStateRepository: () => state,
      createRating: () => rating,
    });
  }
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

function automatchSweepCandidates(value: unknown): AutomatchSweepCandidate[] {
  return automatchSweepEntries(value).flatMap((entry) =>
    entry.kind === "candidate" ? [entry.value] : [],
  );
}

function automatchSweepTasks(value: unknown): TelegramProjectionTask[] {
  return automatchSweepCandidates(value).map(({ task }) => task);
}

async function claimAutomatchSweepCandidate(
  state: GameSessionPort,
  candidate: AutomatchSweepCandidate,
  nowMs: number,
): Promise<boolean> {
  const result = await state.transactAutomatchTelegramOutbox(
    candidate.task.inviteId,
    (current) => {
      const outbox = parseOutbox(current);
      if (
        !outbox ||
        outbox.requestId !== candidate.task.requestId ||
        outbox.updatedAtMs !== candidate.updatedAtMs ||
        outbox.updatedAtMs > nowMs
      ) {
        return { commit: false, decision: "not-due" };
      }
      return {
        value: { ...asObject(current), updatedAtMs: nowMs },
        decision: "claimed",
      };
    },
  );
  return result.committed;
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

async function sendTaskBatches(
  queue: Queue<TelegramProjectionTask>,
  tasks: TelegramProjectionTask[],
): Promise<void> {
  return sendQueueTasks(queue, tasks);
}

async function sweepAutomatchProjections(
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
    );
    const { sentCount, claimFailure } = await claimAndEnqueueProjectionTasks({
      candidates,
      claim: (candidate) =>
        claimAutomatchSweepCandidate(state, candidate, nowMs),
      toTask: ({ task }) => task,
      queue: env.TELEGRAM_PROJECTION_QUEUE,
      fallbackErrorMessage: "projection-claim-failed",
    });
    if (claimFailure) {
      throw claimFailure;
    }
    if (repairFailures.length > 0) {
      throw repairFailures[0];
    }
    return sentCount;
  } catch (error) {
    logger.error(
      JSON.stringify({
        event: "telegram_projection_automatch_sweep_failed",
        code: error instanceof Error ? error.message : "unknown",
      }),
    );
    throw error;
  }
}

async function sweepRatingProjections(
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
          record.updateTime,
          nowMs,
        ),
      toTask: (record): TelegramProjectionTask => ({
        kind: "rating-telegram-projection",
        operationId: record.operationId,
      }),
      queue: env.TELEGRAM_PROJECTION_QUEUE,
      fallbackErrorMessage: "projection-claim-failed",
    });
    if (claimFailure) {
      throw claimFailure;
    }
    return sentCount;
  } catch (error) {
    logger.error(
      JSON.stringify({
        event: "telegram_projection_rating_sweep_failed",
        code: error instanceof Error ? error.message : "unknown",
      }),
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
    ).catch((error) => {
      logger.error(
        JSON.stringify({
          event: "telegram_projection_event_sweep_failed",
          code: error instanceof Error ? error.message : "unknown",
        }),
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
    throw new Error("telegram-projection-sweep-failed");
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
    console.info(JSON.stringify({ event: "telegram_projection_sweep_frozen" }));
    return;
  }
  const result = await sweepTelegramProjections(env);
  console.info(
    JSON.stringify({
      event: "telegram_projection_sweep_completed",
      automatch: result.automatch,
      eventCount: result.event,
      rating: result.rating,
    }),
  );
}

export {
  MAX_PROJECTION_RETRY_DELAY_SECONDS,
  PROJECTION_INPUT_RETRIES,
  PROJECTION_SWEEP_LIMIT,
  automatchSweepCandidates,
  automatchSweepTasks,
  claimAutomatchSweepCandidate,
  parseOutbox,
  processAutomatchTask,
  processRatingTask,
  projectAutomatchSource,
  projectionRetryDelaySeconds,
  sendTaskBatches,
  sweepAutomatchProjections,
  sweepRatingProjections,
};
