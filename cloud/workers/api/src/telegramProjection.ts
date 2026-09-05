import {
  TELEGRAM_AUTOMATCH_PROJECTION_OUTBOX_ROOT,
  getAutomatchTelegramProjectionOutboxPath,
  getAutomatchTelegramSourcePath,
} from "../../../functions/telegram/automatchSource.js";
import {
  buildTelegramEditDesired,
  buildTelegramSendDesired,
} from "../../../functions/telegram/desiredStateCore.js";
import {
  asObject,
  buildAutomatchProjectionGuard,
  buildAutomatchTelegramProjection,
  evaluateAutomatchProjectionUpdate,
  mergeRatingResultFragment,
  shouldProjectRatingTelegramUpdate,
  type AutomatchTelegramProjection,
} from "../../../functions/telegram/projectionCore.js";
import type { FirebaseRtdbClient } from "./firebaseRtdb.ts";
import { createEventRtdbClient } from "./eventRepository.ts";
import {
  createGameplayRepository,
  createRatingRepository,
  type RatingProjectionRepository,
} from "./gameplayRepository.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
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
import type { TelegramRepository } from "../../../functions/telegram/deliveryEngine.js";
import {
  createD1TelegramRepository,
  readTelegramStorageMode,
  type TelegramStorageMode,
} from "./telegramD1.ts";
import {
  processEventProjectionTask,
  sweepEventTelegramProjections,
} from "./eventTelegramProjection.ts";
import { PROFILE_BACKGROUND_SWEEP_LIMIT } from "./profileBackgroundLimits.ts";

const PROJECTION_SWEEP_LIMIT = PROFILE_BACKGROUND_SWEEP_LIMIT;
const PROJECTION_INPUT_RETRIES = 5;
const MAX_PROJECTION_RETRY_DELAY_SECONDS = 60;

type AutomatchProjectionOutbox = {
  requestId: string;
  schemaVersion: number;
  status: string;
  updatedAtMs: number;
};

type ProjectionLogger = Pick<Console, "error" | "info">;

type ProjectionDependencies = {
  createRating?: (env: Env) => RatingProjectionRepository;
  createRtdb?: (env: Env) => FirebaseRtdbClient;
  createTelegram?: (env: Env) => TelegramRepository;
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
    isSafeFirebaseKey(record.requestId) &&
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
  rtdb: FirebaseRtdbClient,
): Promise<{ inviteData: unknown; source: unknown }> {
  const [source, inviteData] = await Promise.all([
    rtdb.getPath(getAutomatchTelegramSourcePath(inviteId)),
    rtdb.getPath(`invites/${inviteId}`),
  ]);
  return { source, inviteData };
}

async function projectAutomatchSource(
  inviteId: string,
  rtdb: FirebaseRtdbClient,
  telegram: TelegramRepository,
): Promise<AutomatchProjectionResult> {
  let input = await readAutomatchInputs(inviteId, rtdb);
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
    const latest = await readAutomatchInputs(inviteId, rtdb);
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
  rtdb: FirebaseRtdbClient,
  task: AutomatchTelegramProjectionTask,
  state: "clear" | "dead",
  now: () => number,
  reason = "",
): Promise<boolean> {
  const result = await rtdb.transactPath(
    getAutomatchTelegramProjectionOutboxPath(task.inviteId),
    (current) => {
      const record = toRecord(current);
      if (record?.requestId !== task.requestId) {
        return { commit: false, decision: "stale" };
      }
      return state === "clear"
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
  rtdb: FirebaseRtdbClient,
  enqueueDelivery: (input: InitialTelegramDelivery) => Promise<unknown>,
  now: () => number,
  telegram: TelegramRepository,
): Promise<string> {
  const outbox = parseOutbox(
    await rtdb.getPath(getAutomatchTelegramProjectionOutboxPath(task.inviteId)),
  );
  if (!outbox || outbox.requestId !== task.requestId) {
    return "stale";
  }
  const projection = await projectAutomatchSource(
    task.inviteId,
    rtdb,
    telegram,
  );
  if (projection.status === "invalid") {
    await settleAutomatchOutbox(rtdb, task, "dead", now, "invalid-source");
    return "dead";
  }
  if (projection.delivery) {
    await enqueueDelivery({
      ...projection.delivery,
      generation: `automatch:${task.requestId}:${projection.delivery.revision}`,
      producer: "automatch-projection",
    });
  }
  await settleAutomatchOutbox(rtdb, task, "clear", now);
  return projection.status;
}

async function processRatingTask(
  task: RatingTelegramProjectionTask,
  rtdb: FirebaseRtdbClient,
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
  await rtdb.transactPath(
    getAutomatchTelegramSourcePath(update.inviteId),
    (source) => {
      const merged = mergeRatingResultFragment(source, update);
      mergeReason = merged.reason;
      return merged.changed
        ? { value: merged.source, decision: merged.reason }
        : { commit: false, decision: merged.reason };
    },
  );
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
    rtdb,
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

export function projectionRetryDelaySeconds(attempts: number): number {
  const exponent = Math.max(0, Math.min(6, attempts - 1));
  return Math.min(MAX_PROJECTION_RETRY_DELAY_SECONDS, 2 ** exponent);
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
    message.ack();
    logger.error(
      JSON.stringify({ event: "telegram_projection_queue_invalid_message" }),
    );
    return;
  }
  const createRtdb =
    dependencies.createRtdb ||
    ((workerEnv: Env) => createEventRtdbClient(workerEnv));
  const createRating =
    dependencies.createRating ||
    ((workerEnv: Env) =>
      createRatingRepository(workerEnv, createGameplayRepository(workerEnv)));
  const enqueueDelivery =
    dependencies.enqueueDelivery ||
    ((input: InitialTelegramDelivery) =>
      enqueueInitialTelegramDelivery(env, input));
  const storageMode = await (
    dependencies.readStorageMode || readTelegramStorageMode
  )(env.TELEGRAM_DB);
  if (storageMode === "frozen") {
    message.retry({ delaySeconds: 60 });
    logger.info(JSON.stringify({ event: "telegram_projection_queue_frozen" }));
    return;
  }
  try {
    const rtdb = createRtdb(env);
    const telegram = dependencies.createTelegram
      ? dependencies.createTelegram(env)
      : createD1TelegramRepository(env.TELEGRAM_DB, { now });
    let status: string;
    if (task.kind === "automatch-telegram-projection") {
      status = await processAutomatchTask(
        task,
        rtdb,
        enqueueDelivery,
        now,
        telegram,
      );
    } else if (task.kind === "event-telegram-projection") {
      status = await processEventProjectionTask(
        task,
        rtdb,
        createRating(env),
        enqueueDelivery,
        now,
        telegram,
      );
    } else {
      status = await processRatingTask(
        task,
        rtdb,
        createRating(env),
        enqueueDelivery,
        now,
        telegram,
      );
    }
    message.ack();
    logger.info(
      JSON.stringify({
        event: "telegram_projection_queue_processed",
        kind: task.kind,
        status,
      }),
    );
  } catch (error) {
    message.retry({
      delaySeconds: projectionRetryDelaySeconds(message.attempts),
    });
    logger.error(
      JSON.stringify({
        event: "telegram_projection_queue_failed",
        kind: task.kind,
        code: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
}

export async function handleTelegramProjectionQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  const rtdb = createEventRtdbClient(env);
  const rating = createRatingRepository(env, createGameplayRepository(env));
  for (const message of batch.messages) {
    await handleTelegramProjectionMessage(message, env, {
      createRtdb: () => rtdb,
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
      outbox && isSafeFirebaseKey(inviteId)
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
  rtdb: FirebaseRtdbClient,
  candidate: AutomatchSweepCandidate,
  nowMs: number,
): Promise<boolean> {
  const result = await rtdb.transactPath(
    getAutomatchTelegramProjectionOutboxPath(candidate.task.inviteId),
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
  rtdb: FirebaseRtdbClient,
  inviteId: string,
  nowMs: number,
): Promise<void> {
  await rtdb.transactPath(
    getAutomatchTelegramProjectionOutboxPath(inviteId),
    (current) => {
      const record = toRecord(current);
      const updatedAtMs = record?.updatedAtMs;
      if (
        !record ||
        (parseOutbox(current) && isSafeFirebaseKey(inviteId)) ||
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

async function sendTaskBatches(
  queue: Queue<TelegramProjectionTask>,
  tasks: TelegramProjectionTask[],
): Promise<void> {
  for (let index = 0; index < tasks.length; index += 100) {
    await queue.sendBatch(
      tasks.slice(index, index + 100).map((task) => ({ body: task })),
    );
  }
}

async function collectSuccessfulClaims<T>(
  items: readonly T[],
  claim: (item: T) => Promise<boolean>,
): Promise<{ claimed: T[]; failure: Error | null }> {
  const claimed: T[] = [];
  let failure: Error | null = null;
  for (const item of items) {
    try {
      if (await claim(item)) {
        claimed.push(item);
      }
    } catch (error) {
      failure ||=
        error instanceof Error ? error : new Error("projection-claim-failed");
    }
  }
  return { claimed, failure };
}

async function sweepAutomatchProjections(
  env: Env,
  rtdb: FirebaseRtdbClient,
  logger: ProjectionLogger,
  nowMs: number,
): Promise<number> {
  try {
    const value = await rtdb.getPath(
      TELEGRAM_AUTOMATCH_PROJECTION_OUTBOX_ROOT,
      {
        orderBy: "updatedAtMs",
        startAt: 0,
        endAt: nowMs,
        limitToFirst: PROJECTION_SWEEP_LIMIT,
      },
    );
    const entries = automatchSweepEntries(value);
    const candidates = entries.flatMap((entry) =>
      entry.kind === "candidate" ? [entry.value] : [],
    );
    const invalidInviteIds = entries.flatMap((entry) =>
      entry.kind === "invalid" ? [entry.inviteId] : [],
    );
    let invalidFailure: Error | null = null;
    for (const inviteId of invalidInviteIds) {
      try {
        await markInvalidAutomatchSweepEntry(rtdb, inviteId, nowMs);
      } catch (error) {
        invalidFailure ||=
          error instanceof Error
            ? error
            : new Error("projection-invalid-record-failed");
      }
    }
    const claims = await collectSuccessfulClaims(candidates, (candidate) =>
      claimAutomatchSweepCandidate(rtdb, candidate, nowMs),
    );
    const tasks = claims.claimed.map(({ task }) => task);
    await sendTaskBatches(env.TELEGRAM_PROJECTION_QUEUE, tasks);
    if (claims.failure) {
      throw claims.failure;
    }
    if (invalidFailure) {
      throw invalidFailure;
    }
    return tasks.length;
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
    const claims = await collectSuccessfulClaims(records, (record) =>
      rating.claimRatingTelegramProjection(
        record.operationId,
        record.updateTime,
        nowMs,
      ),
    );
    const tasks: TelegramProjectionTask[] = claims.claimed.map((record) => ({
      kind: "rating-telegram-projection",
      operationId: record.operationId,
    }));
    await sendTaskBatches(env.TELEGRAM_PROJECTION_QUEUE, tasks);
    if (claims.failure) {
      throw claims.failure;
    }
    return tasks.length;
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
  const createRtdb =
    dependencies.createRtdb ||
    ((workerEnv: Env) => createEventRtdbClient(workerEnv));
  const createRating =
    dependencies.createRating ||
    ((workerEnv: Env) =>
      createRatingRepository(workerEnv, createGameplayRepository(workerEnv)));
  const nowMs = now();
  const rtdb = createRtdb(env);
  const rating = createRating(env);
  const [automatch, event, ratingCount] = await Promise.allSettled([
    sweepAutomatchProjections(env, rtdb, logger, nowMs),
    sweepEventTelegramProjections(
      env.TELEGRAM_PROJECTION_QUEUE,
      rtdb,
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
  sendTaskBatches,
  sweepAutomatchProjections,
  sweepRatingProjections,
};
