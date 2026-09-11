import {
  createTelegramDeliveryEngine,
  createTelegramLocalRetryBarrier,
  type TelegramEngineResult,
  type TelegramRepository,
} from "../../../runtime/telegram/deliveryEngine.js";
import {
  buildTelegramDeliveryTaskId,
  normalizeOptionalTimestamp,
  normalizeTaskPayload,
  type TelegramTaskPayload,
} from "../../../runtime/telegram/taskIdentity.js";
import {
  deleteTelegramMessage,
  editTelegramMessage,
  sendTelegramMessage,
  type TelegramClient,
} from "../../../runtime/telegram/client.js";
import {
  createD1TelegramRepository,
  readTelegramStorageMode,
  type TelegramStorageMode,
} from "./telegramD1.ts";
import { parseWagerSettlementRetryTask } from "./wagerSettlementQueue.ts";
import {
  infrastructureRetryDelaySeconds,
  MAX_INFRASTRUCTURE_RETRY_DELAY_SECONDS,
} from "./queueRetry.ts";

const MAX_QUEUE_DELAY_SECONDS = 24 * 60 * 60;
const MIN_DISPATCH_INTERVAL_MS = 1_000;
const TELEGRAM_FROZEN_RETRY_SECONDS = 60;

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

function logicalDelaySeconds(scheduleTimeMs: number, nowMs: number): number {
  return Math.min(
    MAX_QUEUE_DELAY_SECONDS,
    Math.max(0, Math.ceil((scheduleTimeMs - nowMs) / 1_000)),
  );
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

export async function handleTelegramQueueMessage(
  message: Message<unknown>,
  env: Env,
  {
    createRepository,
    createEngine = createTelegramDeliveryEngine,
    logger = console,
    now = Date.now,
    readStorageMode,
    sleep = defaultSleep,
  }: {
    createRepository?: (env: Env) => TelegramRepository;
    createEngine?: TelegramEngineFactory;
    logger?: Pick<Console, "error" | "info">;
    now?: () => number;
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
    try {
      await env.WAGER_SETTLEMENT_QUEUE.send(task);
      message.ack();
      logger.info(
        JSON.stringify({
          event: "wager_settlement_queue_forwarded",
          operationId: task.operationId,
        }),
      );
    } catch (error) {
      message.retry({
        delaySeconds: infrastructureRetryDelaySeconds(message.attempts),
      });
      logger.error(
        JSON.stringify({
          event: "wager_settlement_queue_forward_failed",
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
  createRetryScheduler,
  infrastructureRetryDelaySeconds,
  logicalDelaySeconds,
  type TelegramTaskPayload,
};
