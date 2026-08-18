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
import { createFirebaseRtdbRepository } from "./firebaseRtdb.ts";

const MAX_QUEUE_DELAY_SECONDS = 24 * 60 * 60;
const MIN_DISPATCH_INTERVAL_MS = 1_000;
const MAX_INFRASTRUCTURE_RETRY_DELAY_SECONDS = 60;

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

export async function handleTelegramQueueMessage(
  message: Message<unknown>,
  env: Env,
  {
    createRepository = createFirebaseRtdbRepository,
    createEngine = createTelegramDeliveryEngine,
    logger = console,
    now = Date.now,
    sleep = defaultSleep,
  }: {
    createRepository?: (env: Env) => TelegramRepository;
    createEngine?: TelegramEngineFactory;
    logger?: Pick<Console, "error" | "info">;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<void> {
  const startedAtMs = now();
  let payloadValidated = false;
  let messageKey = "unknown";
  try {
    const payload = normalizeTaskPayload(message.body);
    payloadValidated = true;
    messageKey = payload.messageKey;
    const engine = createEngine({
      repository: createRepository(env),
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
  createRetryScheduler,
  infrastructureRetryDelaySeconds,
  logicalDelaySeconds,
  type TelegramTaskPayload,
};
