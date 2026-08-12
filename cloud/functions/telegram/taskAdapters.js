"use strict";

const admin = require("../firebaseAdmin");
const { defineSecret } = require("firebase-functions/params");
const { onValueWritten } = require("firebase-functions/v2/database");
const { onTaskDispatched } = require("firebase-functions/v2/tasks");
const {
  isTaskAlreadyExistsError,
  normalizeTaskQueueErrorCode: normalizeErrorCode,
} = require("../taskQueueErrors");
const { telegramBotToken } = require("./client");
const { createTelegramDeliveryEngine } = require("./deliveryEngine");
const { validateTelegramMessageKey } = require("./desiredState");
const { createFirebaseTelegramRepository } = require("./rtdbRepository");
const {
  TELEGRAM_DESIRED_TASK_KIND,
  TELEGRAM_MANUAL_RECOVERY_TASK_KIND,
} = require("./taskKinds");
const {
  buildTelegramDeliveryTaskId,
  normalizeOptionalTimestamp,
  normalizeTaskPayload,
} = require("./taskIdentity");

const TELEGRAM_DELIVERY_QUEUE = "telegramDeliveryWorker";
const TELEGRAM_TASK_DEADLINE_SECONDS = 30;
const telegramCommunityChatId = defineSecret("TELEGRAM_EXTRA_CHAT_ID");
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const enqueueTelegramDeliveryTask = async (
  input,
  {
    functions = admin.functions(),
    queueName = TELEGRAM_DELIVERY_QUEUE,
    scheduleTimeMs,
  } = {},
) => {
  const payload = normalizeTaskPayload(input);
  const taskId = buildTelegramDeliveryTaskId(payload);
  const options = {
    id: taskId,
    dispatchDeadlineSeconds: TELEGRAM_TASK_DEADLINE_SECONDS,
  };
  const normalizedScheduleTimeMs = normalizeOptionalTimestamp(
    scheduleTimeMs ?? input?.scheduleTimeMs,
  );
  if (normalizedScheduleTimeMs > Date.now()) {
    options.scheduleTime = new Date(normalizedScheduleTimeMs);
  }
  try {
    await functions.taskQueue(queueName).enqueue(payload, options);
    return { enqueued: true, duplicate: false, taskId };
  } catch (error) {
    if (isTaskAlreadyExistsError(error)) {
      return { enqueued: false, duplicate: true, taskId };
    }
    throw error;
  }
};

const createTelegramDeliveryDispatcher = ({
  enqueueTask = enqueueTelegramDeliveryTask,
} = {}) => {
  return async ({ messageKey, revision, generation }) => {
    const normalizedMessageKey = validateTelegramMessageKey(messageKey);
    const normalizedRevision = normalizeString(revision);
    const normalizedGeneration = normalizeString(generation);
    if (!normalizedRevision || !normalizedGeneration) {
      return { skipped: true, reason: "missing-dispatch-identity" };
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
    if (!normalizedRequestId || !normalizedGeneration) {
      return { skipped: true, reason: "missing-dispatch-identity" };
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

const createTelegramDeliveryWorkerHandler = ({
  engine,
  logger = console,
} = {}) => {
  if (!engine || typeof engine.reconcile !== "function") {
    throw new TypeError("engine.reconcile is required");
  }
  return async (request) => {
    let payload;
    try {
      payload = normalizeTaskPayload(request?.data || {});
    } catch (error) {
      logger.error("telegram:delivery:invalid-task", {
        code: normalizeErrorCode(error) || "invalid-task",
      });
      return { status: "skipped", reason: "invalid-task" };
    }
    let result;
    try {
      result = await engine.reconcile({
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
        ...(payload.proofTaskKind
          ? { proofTaskKind: payload.proofTaskKind }
          : {}),
        ...(payload.barrierProofOwner
          ? { barrierProofOwner: payload.barrierProofOwner }
          : {}),
        ...(payload.barrierRetryNotBeforeMs
          ? {
              barrierRetryNotBeforeMs: payload.barrierRetryNotBeforeMs,
            }
          : {}),
        ...(payload.apiGateReclaimOwner
          ? { apiGateReclaimOwner: payload.apiGateReclaimOwner }
          : {}),
        ...(payload.apiGateSettleOwner
          ? { apiGateSettleOwner: payload.apiGateSettleOwner }
          : {}),
      });
    } catch (error) {
      logger.error("telegram:delivery:worker-error", {
        messageKey: payload.messageKey,
        code: normalizeErrorCode(error) || "delivery-error",
      });
      throw error;
    }
    if (result.status === "retryable" && !result.scheduled) {
      const error = new Error("telegram-retry-not-scheduled");
      error.code = "telegram-retry-not-scheduled";
      throw error;
    }
    return result;
  };
};

const dispatchTelegramDelivery = onValueWritten(
  {
    ref: "/telegramMessages/{messageKey}/desired/revision",
    maxInstances: 10,
    concurrency: 20,
    memory: "256MiB",
    cpu: 1,
    retry: true,
  },
  async (event) => {
    const beforeRevision = event.data.before.exists()
      ? normalizeString(event.data.before.val())
      : "";
    const afterRevision = event.data.after.exists()
      ? normalizeString(event.data.after.val())
      : "";
    if (!afterRevision || beforeRevision === afterRevision) {
      return;
    }
    const generation = normalizeString(event.id);
    if (!generation) {
      const error = new Error("telegram-dispatch-generation-missing");
      error.code = "telegram-dispatch-generation-missing";
      throw error;
    }
    await createTelegramDeliveryDispatcher()({
      messageKey: event.params.messageKey,
      revision: afterRevision,
      generation,
    });
  },
);

const dispatchTelegramManualRecovery = onValueWritten(
  {
    ref: "/telegramMessages/{messageKey}/manualRecovery/requestId",
    maxInstances: 10,
    concurrency: 20,
    memory: "256MiB",
    cpu: 1,
    retry: true,
  },
  async (event) => {
    const beforeRequestId = event.data.before.exists()
      ? normalizeString(event.data.before.val())
      : "";
    const afterRequestId = event.data.after.exists()
      ? normalizeString(event.data.after.val())
      : "";
    if (!afterRequestId || beforeRequestId === afterRequestId) {
      return;
    }
    const generation = normalizeString(event.id);
    if (!generation) {
      const error = new Error("telegram-recovery-generation-missing");
      error.code = "telegram-recovery-generation-missing";
      throw error;
    }
    await createTelegramManualRecoveryDispatcher()({
      messageKey: event.params.messageKey,
      requestId: afterRequestId,
      generation,
    });
  },
);

const telegramDeliveryWorker = onTaskDispatched(
  {
    secrets: [telegramBotToken, telegramCommunityChatId],
    maxInstances: 1,
    concurrency: 1,
    memory: "256MiB",
    cpu: 1,
    timeoutSeconds: TELEGRAM_TASK_DEADLINE_SECONDS,
    retryConfig: {
      maxAttempts: 100,
      minBackoffSeconds: 1,
      maxBackoffSeconds: 960,
      maxDoublings: 10,
      maxRetrySeconds: 86_400,
    },
    rateLimits: {
      maxConcurrentDispatches: 1,
      maxDispatchesPerSecond: 1,
    },
  },
  async (request) => {
    const repository = createFirebaseTelegramRepository();
    const scheduleRetry = (payload) =>
      enqueueTelegramDeliveryTask(payload, {
        scheduleTimeMs: payload.scheduleTimeMs,
      });
    const engine = createTelegramDeliveryEngine({ repository, scheduleRetry });
    return createTelegramDeliveryWorkerHandler({ engine })(request);
  },
);

module.exports = {
  TELEGRAM_DELIVERY_QUEUE,
  TELEGRAM_TASK_DEADLINE_SECONDS,
  buildTelegramDeliveryTaskId,
  createTelegramDeliveryDispatcher,
  createTelegramDeliveryWorkerHandler,
  createTelegramManualRecoveryDispatcher,
  dispatchTelegramDelivery,
  dispatchTelegramManualRecovery,
  enqueueTelegramDeliveryTask,
  telegramDeliveryWorker,
};
