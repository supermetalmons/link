import { queueFor } from "./queueProducers.ts";
import { telegramRetryScheduleTime } from "../../../runtime/telegram/retryRecords.js";
import {
  createTelegramDeliveryEngine,
  createTelegramLocalRetryBarrier,
  type TelegramEngineResult,
  type TelegramRepository,
  type TelegramRetryScheduler,
} from "../../../runtime/telegram/deliveryEngine.js";
import {
  buildTelegramDeliveryTaskId,
  normalizeTaskPayload,
  parseTelegramTaskPayload,
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
import { ackQueueMessage, retryQueueMessage } from "./queueMessage.ts";
import { infrastructureRetryDelaySeconds } from "./queueRetry.ts";

const MAX_QUEUE_DELAY_SECONDS = 24 * 60 * 60;
const MIN_DISPATCH_INTERVAL_MS = 1_000;
const TELEGRAM_FROZEN_RETRY_SECONDS = 60;

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

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
): TelegramRetryScheduler {
  return async (input) => {
    const scheduleTimeMs = telegramRetryScheduleTime(input);
    const payload = normalizeTaskPayload(input);
    await queueFor(env, "TELEGRAM_DELIVERY_QUEUE").send(payload, {
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
    createEngine?: typeof createTelegramDeliveryEngine;
    logger?: Pick<Console, "error" | "info">;
    now?: () => number;
    readStorageMode?: (db: D1Database) => Promise<TelegramStorageMode>;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<void> {
  let startedAtMs: number | null = null;
  let messageKey = "unknown";
  try {
    let payload: TelegramTaskPayload;
    try {
      const parsed = parseTelegramTaskPayload(message.body);
      if (!parsed) throw new TypeError("invalid-telegram-task");
      payload = parsed;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      ackQueueMessage(message, {
        entry: { event: "telegram_queue_invalid_message" },
        level: "error",
        logger,
      });
      return;
    }
    const storageMode = await (readStorageMode || readTelegramStorageMode)(
      env.TELEGRAM_DB,
    );
    if (storageMode === "frozen") {
      retryQueueMessage(message, TELEGRAM_FROZEN_RETRY_SECONDS, {
        entry: { event: "telegram_queue_frozen" },
        level: "info",
        logger,
      });
      return;
    }
    startedAtMs = now();
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
    const {
      schemaVersion: _schemaVersion,
      dataEpoch: _dataEpoch,
      revision,
      generation,
      ...task
    } = payload;
    const result: TelegramEngineResult = await engine.reconcile({
      ...task,
      requestedRevision: revision,
      requestedGeneration: generation,
    });
    if (result.status === "retryable" && !result.scheduled) {
      throw new Error("telegram-retry-not-scheduled");
    }
    ackQueueMessage(message, {
      entry: {
        event: "telegram_queue_processed",
        messageKey,
        status: result.status,
      },
      level: "info",
      logger,
    });
  } catch (error) {
    retryQueueMessage(
      message,
      infrastructureRetryDelaySeconds(message.attempts),
      {
        entry: {
          event: "telegram_queue_failed",
          messageKey,
          code: error instanceof Error ? error.message : "unknown",
        },
        level: "error",
        logger,
      },
    );
  } finally {
    if (startedAtMs !== null) {
      const remainingMs = MIN_DISPATCH_INTERVAL_MS - (now() - startedAtMs);
      if (remainingMs > 0) {
        await sleep(remainingMs);
      }
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
  infrastructureRetryDelaySeconds,
  logicalDelaySeconds,
  type TelegramTaskPayload,
};
