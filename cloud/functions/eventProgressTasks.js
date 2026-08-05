const crypto = require("crypto");
const admin = require("./firebaseAdmin");

const EVENT_PROGRESS_TASK_QUEUE = "processEventProgress";
const EVENT_PROGRESS_FALLBACK_ROOT = "eventProgressFallback";
const ENQUEUE_RETRY_DELAYS_MS = [120, 360, 900];

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const buildEventProgressTaskId = (eventId, sourceKey) => {
  const normalizedEventId = normalizeString(eventId);
  const normalizedSourceKey = normalizeString(sourceKey);
  const digest = crypto
    .createHash("sha1")
    .update(`${normalizedEventId}:${normalizedSourceKey}`)
    .digest("hex")
    .slice(0, 24);
  return `evp_${normalizedEventId}_${digest}`;
};

const buildEventProgressFallbackSignalId = (eventId) => {
  const normalizedEventId = normalizeString(eventId);
  const digest = crypto
    .createHash("sha1")
    .update(`fallback:${normalizedEventId}`)
    .digest("hex")
    .slice(0, 24);
  return `sig_${digest}`;
};

const normalizeErrorCode = (error) => {
  if (!error || typeof error !== "object") {
    return "";
  }
  const rawCode =
    typeof error.code === "string" || typeof error.code === "number"
      ? error.code
      : typeof error.status === "string" || typeof error.status === "number"
        ? error.status
        : "";
  if (typeof rawCode === "number") {
    return String(rawCode);
  }
  if (typeof rawCode === "string") {
    return rawCode.trim().toLowerCase();
  }
  return "";
};

const stripFunctionsErrorCodePrefix = (code) =>
  code.startsWith("functions/") ? code.slice("functions/".length) : code;

const isTaskAlreadyExistsError = (error) => {
  const normalizedCode = stripFunctionsErrorCodePrefix(
    normalizeErrorCode(error),
  );
  if (
    normalizedCode === "task-already-exists" ||
    normalizedCode === "already_exists" ||
    normalizedCode === "already-exists" ||
    normalizedCode === "6"
  ) {
    return true;
  }
  const message =
    typeof error.message === "string" ? error.message.toLowerCase() : "";
  return message.includes("task") && message.includes("already exists");
};

const isTransientEnqueueError = (error) => {
  const normalizedCode = stripFunctionsErrorCodePrefix(
    normalizeErrorCode(error),
  );
  if (
    normalizedCode === "unavailable" ||
    normalizedCode === "deadline-exceeded" ||
    normalizedCode === "deadline_exceeded" ||
    normalizedCode === "resource-exhausted" ||
    normalizedCode === "resource_exhausted" ||
    normalizedCode === "internal" ||
    normalizedCode === "internal-error" ||
    normalizedCode === "aborted" ||
    normalizedCode === "unknown" ||
    normalizedCode === "unknown-error" ||
    normalizedCode === "14" ||
    normalizedCode === "13" ||
    normalizedCode === "10" ||
    normalizedCode === "8" ||
    normalizedCode === "4"
  ) {
    return true;
  }
  const message =
    typeof error?.message === "string" ? error.message.toLowerCase() : "";
  return (
    message.includes("deadline exceeded") ||
    message.includes("temporarily unavailable") ||
    message.includes("connection reset") ||
    message.includes("econnreset")
  );
};

const enqueueWithRetry = async (payload, options) => {
  const queue = admin.functions().taskQueue(EVENT_PROGRESS_TASK_QUEUE);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await queue.enqueue(payload, options);
      return { ok: true, enqueued: true, duplicate: false, taskId: options.id };
    } catch (error) {
      if (isTaskAlreadyExistsError(error)) {
        return {
          ok: true,
          enqueued: false,
          duplicate: true,
          taskId: options.id,
        };
      }
      const shouldRetry =
        isTransientEnqueueError(error) &&
        attempt < ENQUEUE_RETRY_DELAYS_MS.length;
      if (!shouldRetry) {
        throw error;
      }
      await sleep(ENQUEUE_RETRY_DELAYS_MS[attempt]);
    }
  }
};

const persistEventProgressFallbackSignal = async ({
  eventId,
  sourceKey,
  reason,
  enqueueErrorCode,
}) => {
  const normalizedEventId = normalizeString(eventId);
  const normalizedSourceKey = normalizeString(sourceKey);
  if (!normalizedEventId || !normalizedSourceKey) {
    throw new Error("eventId and sourceKey are required");
  }

  const signalId = buildEventProgressFallbackSignalId(normalizedEventId);
  const nowMs = Date.now();
  const signalRef = admin
    .database()
    .ref(`${EVENT_PROGRESS_FALLBACK_ROOT}/${normalizedEventId}/${signalId}`);

  const result = await signalRef.transaction((current) => {
    const existing = current && typeof current === "object" ? current : null;
    if (existing) {
      return {
        ...existing,
        sourceKey: normalizedSourceKey,
        reason:
          normalizeString(reason) ||
          normalizeString(existing.reason) ||
          "progress",
        lastQueuedAtMs: nowMs,
        enqueueFailedAtMs: nowMs,
        enqueueErrorCode: normalizeString(enqueueErrorCode) || null,
      };
    }
    return {
      eventId: normalizedEventId,
      sourceKey: normalizedSourceKey,
      reason: normalizeString(reason) || "progress",
      firstQueuedAtMs: nowMs,
      lastQueuedAtMs: nowMs,
      enqueueFailedAtMs: nowMs,
      enqueueErrorCode: normalizeString(enqueueErrorCode) || null,
    };
  });

  return {
    ok: true,
    persisted: !!result.committed,
    signalId,
  };
};

const enqueueEventProgressTask = async ({
  eventId,
  sourceKey,
  reason,
  scheduleTimeMs,
}) => {
  const normalizedEventId = normalizeString(eventId);
  const normalizedSourceKey = normalizeString(sourceKey);
  if (!normalizedEventId || !normalizedSourceKey) {
    throw new Error("eventId and sourceKey are required");
  }

  const payload = {
    eventId: normalizedEventId,
    sourceKey: normalizedSourceKey,
    reason: normalizeString(reason) || "progress",
  };
  const options = {
    id: buildEventProgressTaskId(normalizedEventId, normalizedSourceKey),
    dispatchDeadlineSeconds: 30,
  };
  if (typeof scheduleTimeMs === "number" && Number.isFinite(scheduleTimeMs)) {
    options.scheduleTime = new Date(Math.floor(scheduleTimeMs));
  }

  return enqueueWithRetry(payload, options);
};

const requestEventProgress = async ({
  eventId,
  sourceKey,
  reason,
  scheduleTimeMs,
  allowFallback = true,
}) => {
  try {
    const enqueued = await enqueueEventProgressTask({
      eventId,
      sourceKey,
      reason,
      scheduleTimeMs,
    });
    return {
      ...enqueued,
      fallbackPersisted: false,
      fallbackSignalId: null,
    };
  } catch (enqueueError) {
    if (!allowFallback || typeof scheduleTimeMs === "number") {
      throw enqueueError;
    }
    try {
      const fallbackResult = await persistEventProgressFallbackSignal({
        eventId,
        sourceKey,
        reason,
        enqueueErrorCode: normalizeErrorCode(enqueueError),
      });
      return {
        ok: true,
        enqueued: false,
        duplicate: false,
        taskId: null,
        fallbackPersisted: true,
        fallbackSignalId: fallbackResult.signalId,
      };
    } catch (fallbackError) {
      const combinedError = new Error(
        "event progress enqueue and fallback persistence both failed",
      );
      combinedError.code = "event-progress-unavailable";
      combinedError.enqueueError = enqueueError;
      combinedError.fallbackError = fallbackError;
      throw combinedError;
    }
  }
};

module.exports = {
  enqueueEventProgressTask,
  requestEventProgress,
};
