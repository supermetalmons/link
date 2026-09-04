import {
  createTelegramDeliveryEngine,
  createTelegramLocalRetryBarrier,
  type TelegramEngineResult,
  type TelegramRepository,
} from "../../../functions/telegram/deliveryEngine.js";
import {
  buildTelegramDeliveryTaskId,
  normalizeOptionalTimestamp,
  normalizeTaskPayload,
  type TelegramTaskPayload,
} from "../../../functions/telegram/taskIdentity.js";
import {
  deleteTelegramMessage,
  editTelegramMessage,
  sendTelegramMessage,
  type TelegramClient,
} from "../../../functions/telegram/client.js";
import {
  createD1TelegramRepository,
  readTelegramStorageMode,
  type TelegramStorageMode,
} from "./telegramD1.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import {
  classifyWagerSettlementRetry,
  resumeWagerSettlement,
  type WagerSettlementResolution,
  type WagerSettlementRetryTask,
} from "./wagerOutcome.ts";
import { profileBackgroundMutationsEnabled } from "./profileCanonicalActivation.ts";

const MAX_QUEUE_DELAY_SECONDS = 24 * 60 * 60;
const MIN_DISPATCH_INTERVAL_MS = 1_000;
const MAX_INFRASTRUCTURE_RETRY_DELAY_SECONDS = 60;
const TELEGRAM_FROZEN_RETRY_SECONDS = 60;
const WAGER_SETTLEMENT_RETRY_DELAY_SECONDS = 5 * 60;

class WagerSettlementWritesDisabled extends Error {}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

type TelegramEngine = {
  reconcile(input: Record<string, unknown>): Promise<TelegramEngineResult>;
};

type TelegramEngineFactory = (input: {
  repository: TelegramRepository;
  client: TelegramClient;
  resolveDestination: (destination: string) => string;
  now: () => number;
  scheduleRetry: ReturnType<typeof createRetryScheduler>;
  logger: Pick<Console, "error" | "info">;
  localRetryBarrier: ReturnType<typeof createTelegramLocalRetryBarrier>;
}) => TelegramEngine;

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isExactNonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() === value && value.length > 0
  );
}

function parseWagerSettlementRetryTask(
  value: unknown,
): WagerSettlementRetryTask | null {
  const task = toRecord(value);
  if (
    task?.kind !== "wager-settlement" ||
    !isSafeFirebaseKey(task.inviteId) ||
    !isSafeFirebaseKey(task.matchId) ||
    typeof task.operationId !== "string"
  ) {
    return null;
  }
  if (Object.keys(task).length === 4) {
    return {
      kind: "wager-settlement",
      inviteId: task.inviteId,
      matchId: task.matchId,
      operationId: task.operationId,
    };
  }
  const resolution = toRecord(task.resolution);
  if (
    Object.keys(task).length !== 5 ||
    !resolution ||
    Object.keys(resolution).length !== 4 ||
    !isExactNonEmptyString(resolution.winnerUid) ||
    !isSafeFirebaseKey(resolution.winnerUid) ||
    !isExactNonEmptyString(resolution.winnerProfileId) ||
    !isExactNonEmptyString(resolution.loserUid) ||
    !isSafeFirebaseKey(resolution.loserUid) ||
    !isExactNonEmptyString(resolution.loserProfileId)
  ) {
    return null;
  }
  const parsedResolution: WagerSettlementResolution = {
    winnerUid: resolution.winnerUid,
    winnerProfileId: resolution.winnerProfileId,
    loserUid: resolution.loserUid,
    loserProfileId: resolution.loserProfileId,
  };
  return {
    kind: "wager-settlement",
    inviteId: task.inviteId,
    matchId: task.matchId,
    operationId: task.operationId,
    resolution: parsedResolution,
  };
}

function logicalDelaySeconds(scheduleTimeMs: number, nowMs: number): number {
  return Math.min(
    MAX_QUEUE_DELAY_SECONDS,
    Math.max(0, Math.ceil((scheduleTimeMs - nowMs) / 1_000)),
  );
}

function infrastructureRetryDelaySeconds(attempts: number): number {
  const exponent = Math.max(0, Math.min(6, attempts - 1));
  return Math.min(MAX_INFRASTRUCTURE_RETRY_DELAY_SECONDS, 2 ** exponent);
}

function createTelegramClient(env: Env): TelegramClient {
  const token = env.TELEGRAM_BOT_TOKEN;
  return {
    sendTelegramMessage: (input) => sendTelegramMessage({ ...input, token }),
    editTelegramMessage: (input) => editTelegramMessage({ ...input, token }),
    deleteTelegramMessage: (input) =>
      deleteTelegramMessage({ ...input, token }),
  };
}

function createRetryScheduler(
  env: Env,
  now: () => number,
): (input: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async (input) => {
    const scheduleTimeMs = normalizeOptionalTimestamp(input.scheduleTimeMs);
    const payload = normalizeTaskPayload(input);
    await env.TELEGRAM_DELIVERY_QUEUE.send(payload, {
      delaySeconds: logicalDelaySeconds(scheduleTimeMs, now()),
    });
    return {
      scheduled: true,
      taskId: buildTelegramDeliveryTaskId(payload),
    };
  };
}

async function deferWagerSettlement(
  message: Message<unknown>,
  task: WagerSettlementRetryTask,
  env: Env,
  logger: Pick<Console, "error" | "info">,
  reason: string,
  code?: string,
): Promise<void> {
  try {
    await env.TELEGRAM_DELIVERY_QUEUE.send(task, {
      delaySeconds: WAGER_SETTLEMENT_RETRY_DELAY_SECONDS,
    });
    message.ack();
    const entry = JSON.stringify({
      event: "wager_settlement_queue_deferred",
      operationId: task.operationId,
      reason,
      ...(code ? { code } : {}),
    });
    if (code) {
      logger.error(entry);
    } else {
      logger.info(entry);
    }
  } catch (error) {
    message.retry({ delaySeconds: WAGER_SETTLEMENT_RETRY_DELAY_SECONDS });
    logger.error(
      JSON.stringify({
        event: "wager_settlement_queue_defer_failed",
        operationId: task.operationId,
        reason,
        code: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
}

export async function handleTelegramQueueMessage(
  message: Message<unknown>,
  env: Env,
  {
    createRepository,
    createEngine = createTelegramDeliveryEngine,
    createGameplay = (workerEnv) => createGameplayRepository(workerEnv),
    classifySettlement = classifyWagerSettlementRetry,
    logger = console,
    now = Date.now,
    profileMutationsEnabled = profileBackgroundMutationsEnabled,
    readStorageMode,
    resumeSettlement = resumeWagerSettlement,
    sleep = defaultSleep,
  }: {
    createRepository?: (env: Env) => TelegramRepository;
    createEngine?: TelegramEngineFactory;
    createGameplay?: (env: Env) => GameplayRepository;
    classifySettlement?: typeof classifyWagerSettlementRetry;
    logger?: Pick<Console, "error" | "info">;
    now?: () => number;
    profileMutationsEnabled?: typeof profileBackgroundMutationsEnabled;
    resumeSettlement?: typeof resumeWagerSettlement;
    readStorageMode?: (db: D1Database) => Promise<TelegramStorageMode>;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<void> {
  const raw = toRecord(message.body);
  if (raw?.kind === "wager-settlement") {
    const task = parseWagerSettlementRetryTask(raw);
    if (!task) {
      message.ack();
      logger.error(
        JSON.stringify({ event: "wager_settlement_queue_invalid_message" }),
      );
      return;
    }
    let mutationsEnabled = false;
    try {
      mutationsEnabled = await profileMutationsEnabled(env);
    } catch {
      mutationsEnabled = false;
    }
    if (!mutationsEnabled) {
      try {
        const status = await classifySettlement(task, createGameplay(env));
        if (status === "completed" || status === "stale") {
          message.ack();
          logger.info(
            JSON.stringify({
              event: "wager_settlement_queue_processed",
              operationId: task.operationId,
              status,
            }),
          );
          return;
        }
      } catch (error) {
        await deferWagerSettlement(
          message,
          task,
          env,
          logger,
          "classification-unavailable",
          error instanceof Error ? error.message : "unknown",
        );
        return;
      }
      await deferWagerSettlement(
        message,
        task,
        env,
        logger,
        "profile-writes-disabled",
      );
      return;
    }
    const assertMutationAllowed = async () => {
      let enabled = false;
      try {
        enabled = await profileMutationsEnabled(env);
      } catch {}
      if (!enabled) throw new WagerSettlementWritesDisabled();
    };
    try {
      const status = await resumeSettlement(
        task,
        createGameplay(env),
        now,
        assertMutationAllowed,
      );
      message.ack();
      logger.info(
        JSON.stringify({
          event: "wager_settlement_queue_processed",
          operationId: task.operationId,
          status,
        }),
      );
    } catch (error) {
      if (error instanceof WagerSettlementWritesDisabled) {
        await deferWagerSettlement(
          message,
          task,
          env,
          logger,
          "profile-writes-disabled",
        );
        return;
      }
      message.retry({
        delaySeconds: infrastructureRetryDelaySeconds(message.attempts),
      });
      logger.error(
        JSON.stringify({
          event: "wager_settlement_queue_failed",
          operationId: task.operationId,
          code: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
    return;
  }
  const storageMode = await (readStorageMode || readTelegramStorageMode)(
    env.TELEGRAM_DB,
  );
  if (storageMode === "frozen") {
    message.retry({ delaySeconds: TELEGRAM_FROZEN_RETRY_SECONDS });
    logger.info(JSON.stringify({ event: "telegram_queue_frozen" }));
    return;
  }
  const startedAtMs = now();
  let payloadValidated = false;
  let messageKey = "unknown";
  try {
    const payload = normalizeTaskPayload(message.body);
    payloadValidated = true;
    messageKey = payload.messageKey;
    const engine = createEngine({
      repository: createRepository
        ? createRepository(env)
        : createD1TelegramRepository(env.TELEGRAM_DB, { now }),
      client: createTelegramClient(env),
      resolveDestination: () => env.TELEGRAM_EXTRA_CHAT_ID.trim(),
      now,
      scheduleRetry: createRetryScheduler(env, now),
      logger,
      localRetryBarrier: createTelegramLocalRetryBarrier(),
    });
    const result: TelegramEngineResult = await engine.reconcile({
      messageKey: payload.messageKey,
      requestedRevision: payload.revision,
      requestedGeneration: payload.generation,
      taskKind: payload.taskKind,
      retrySequence: payload.retrySequence,
      retryStartedAtMs: payload.retryStartedAtMs,
      retryDeadlineAtMs: payload.retryDeadlineAtMs,
      retryAtMs: payload.retryAtMs,
      safeRejectedAttemptId: payload.safeRejectedAttemptId,
      pendingDeleteId: payload.pendingDeleteId,
      retryProofLeaseOwner: payload.retryProofLeaseOwner,
      proofTaskKind: payload.proofTaskKind,
      barrierProofOwner: payload.barrierProofOwner,
      barrierRetryNotBeforeMs: payload.barrierRetryNotBeforeMs,
      apiGateReclaimOwner: payload.apiGateReclaimOwner,
      apiGateSettleOwner: payload.apiGateSettleOwner,
    });
    if (result.status === "retryable" && !result.scheduled) {
      throw new Error("telegram-retry-not-scheduled");
    }
    message.ack();
    logger.info(
      JSON.stringify({
        event: "telegram_queue_processed",
        messageKey,
        status: result.status,
      }),
    );
  } catch (error) {
    if (!payloadValidated && error instanceof TypeError) {
      message.ack();
      logger.error(JSON.stringify({ event: "telegram_queue_invalid_message" }));
    } else {
      message.retry({
        delaySeconds: infrastructureRetryDelaySeconds(message.attempts),
      });
      logger.error(
        JSON.stringify({
          event: "telegram_queue_failed",
          messageKey,
          code: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  } finally {
    const remainingMs = MIN_DISPATCH_INTERVAL_MS - (now() - startedAtMs);
    if (remainingMs > 0) {
      await sleep(remainingMs);
    }
  }
}

export async function handleTelegramQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    await handleTelegramQueueMessage(message, env);
  }
}

export {
  MAX_INFRASTRUCTURE_RETRY_DELAY_SECONDS,
  MAX_QUEUE_DELAY_SECONDS,
  MIN_DISPATCH_INTERVAL_MS,
  TELEGRAM_FROZEN_RETRY_SECONDS,
  WAGER_SETTLEMENT_RETRY_DELAY_SECONDS,
  createRetryScheduler,
  infrastructureRetryDelaySeconds,
  logicalDelaySeconds,
  parseWagerSettlementRetryTask,
  type TelegramTaskPayload,
  type WagerSettlementRetryTask,
};
