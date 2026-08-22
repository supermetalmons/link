"use strict";

const { createHmac } = require("node:crypto");
const { defineSecret } = require("firebase-functions/params");
const {
  TELEGRAM_DESIRED_TASK_KIND,
  TELEGRAM_MANUAL_RECOVERY_TASK_KIND,
} = require("./taskKinds");
const {
  buildTelegramDeliveryTaskId,
  normalizeTaskPayload,
} = require("./taskIdentity");
const { validateTelegramMessageKey } = require("./desiredStateCore");

const TELEGRAM_DELIVERY_BRIDGE_URL =
  "https://api.mons.link/internal/telegram/delivery";
const TELEGRAM_BRIDGE_TIMEOUT_MS = 5_000;
const telegramQueueBridgeSecret = defineSecret("TELEGRAM_QUEUE_BRIDGE_SECRET");

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const signTelegramBridgeRequest = ({ body, secret, timestamp }) =>
  createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("base64url");

const enqueueTelegramDeliveryTask = async (
  input,
  {
    bridgeUrl = TELEGRAM_DELIVERY_BRIDGE_URL,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    secret = telegramQueueBridgeSecret.value(),
    timeoutMs = TELEGRAM_BRIDGE_TIMEOUT_MS,
  } = {},
) => {
  const payload = normalizeTaskPayload(input);
  const normalizedSecret = normalizeString(secret);
  if (!normalizedSecret) {
    throw new Error("telegram-queue-bridge-secret-missing");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("telegram-queue-bridge-fetch-missing");
  }
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(now() / 1_000));
  const signature = signTelegramBridgeRequest({
    body,
    secret: normalizedSecret,
    timestamp,
  });
  let response;
  try {
    response = await fetchImpl(bridgeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mons-Telegram-Signature": signature,
        "X-Mons-Telegram-Timestamp": timestamp,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const failure = new Error("telegram-queue-bridge-unavailable");
    failure.code = "telegram-queue-bridge-unavailable";
    failure.cause = error;
    throw failure;
  }
  if (response.body) {
    await response.body.cancel().catch(() => undefined);
  }
  if (response.status !== 202) {
    const failure = new Error("telegram-queue-bridge-rejected");
    failure.code = "telegram-queue-bridge-rejected";
    failure.status = response.status;
    throw failure;
  }
  return {
    enqueued: true,
    duplicate: false,
    taskId: buildTelegramDeliveryTaskId(payload),
  };
};

const createTelegramDeliveryDispatcher = ({
  enqueueTask = enqueueTelegramDeliveryTask,
} = {}) => {
  return async ({ messageKey, revision, generation }) => {
    const normalizedMessageKey = validateTelegramMessageKey(messageKey);
    const normalizedRevision = normalizeString(revision);
    const normalizedGeneration = normalizeString(generation);
    if (!normalizedMessageKey || !normalizedRevision || !normalizedGeneration) {
      throw new TypeError("complete Telegram dispatch identity is required");
    }
    return enqueueTask({
      messageKey: normalizedMessageKey,
      revision: normalizedRevision,
      taskKind: TELEGRAM_DESIRED_TASK_KIND,
      retrySequence: 0,
      generation: normalizedGeneration,
    });
  };
};

const createTelegramManualRecoveryDispatcher = ({
  enqueueTask = enqueueTelegramDeliveryTask,
} = {}) => {
  return async ({ messageKey, requestId, generation }) => {
    const normalizedMessageKey = validateTelegramMessageKey(messageKey);
    const normalizedRequestId = normalizeString(requestId);
    const normalizedGeneration = normalizeString(generation);
    if (
      !normalizedMessageKey ||
      !normalizedRequestId ||
      !normalizedGeneration
    ) {
      throw new TypeError("complete Telegram recovery identity is required");
    }
    return enqueueTask({
      messageKey: normalizedMessageKey,
      revision: "manual-recovery",
      taskKind: TELEGRAM_MANUAL_RECOVERY_TASK_KIND,
      retrySequence: 0,
      generation: `${normalizedRequestId}:${normalizedGeneration}`,
    });
  };
};

module.exports = {
  TELEGRAM_BRIDGE_TIMEOUT_MS,
  TELEGRAM_DELIVERY_BRIDGE_URL,
  buildTelegramDeliveryTaskId,
  createTelegramDeliveryDispatcher,
  createTelegramManualRecoveryDispatcher,
  enqueueTelegramDeliveryTask,
  signTelegramBridgeRequest,
  telegramQueueBridgeSecret,
};
