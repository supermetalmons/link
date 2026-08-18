"use strict";

const crypto = require("crypto");
const { validateTelegramMessageKey } = require("./desiredStateCore");
const {
  TELEGRAM_DESIRED_TASK_KIND,
  TELEGRAM_PENDING_DELETE_TASK_KIND,
  TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND,
  TELEGRAM_TASK_KINDS,
} = require("./taskKinds");

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const normalizeTaskKind = (value) => {
  const taskKind = normalizeString(value) || TELEGRAM_DESIRED_TASK_KIND;
  if (!TELEGRAM_TASK_KINDS.has(taskKind)) {
    throw new TypeError("invalid Telegram task kind");
  }
  return taskKind;
};

const normalizeRetrySequence = (value) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new TypeError("retrySequence must be a non-negative integer");
  }
  return number;
};

const normalizeOptionalTimestamp = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
};

const normalizeTaskPayload = (input) => {
  const messageKey = validateTelegramMessageKey(input?.messageKey);
  const revision = normalizeString(input?.revision);
  const generation = normalizeString(input?.generation);
  if (!revision || !generation) {
    throw new TypeError("revision and generation are required");
  }
  const taskKind = normalizeTaskKind(input?.taskKind);
  const retrySequence = normalizeRetrySequence(input?.retrySequence ?? 0);
  const payload = {
    messageKey,
    revision,
    taskKind,
    retrySequence,
    generation,
  };
  for (const field of [
    "retryStartedAtMs",
    "retryDeadlineAtMs",
    "retryAtMs",
    "barrierRetryNotBeforeMs",
  ]) {
    const value = normalizeOptionalTimestamp(input?.[field]);
    if (value > 0) {
      payload[field] = value;
    }
  }
  for (const field of [
    "safeRejectedAttemptId",
    "pendingDeleteId",
    "retryProofLeaseOwner",
    "barrierProofOwner",
    "apiGateReclaimOwner",
    "apiGateSettleOwner",
  ]) {
    const value = normalizeString(input?.[field]);
    if (value) {
      payload[field] = value;
    }
  }
  const proofTaskKind = normalizeString(input?.proofTaskKind);
  if (proofTaskKind) {
    if (
      proofTaskKind !== TELEGRAM_DESIRED_TASK_KIND &&
      proofTaskKind !== TELEGRAM_PENDING_DELETE_TASK_KIND
    ) {
      throw new TypeError("invalid Telegram proof task kind");
    }
    payload.proofTaskKind = proofTaskKind;
  }
  if (
    taskKind === TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND &&
    (!payload.proofTaskKind ||
      !payload.barrierProofOwner ||
      !payload.barrierRetryNotBeforeMs)
  ) {
    throw new TypeError("complete rate-limit proof is required");
  }
  return payload;
};

const buildTelegramDeliveryTaskId = (
  inputOrMessageKey,
  revision,
  generation,
) => {
  const payload = normalizeTaskPayload(
    typeof inputOrMessageKey === "object" && inputOrMessageKey !== null
      ? inputOrMessageKey
      : {
          messageKey: inputOrMessageKey,
          revision,
          taskKind: TELEGRAM_DESIRED_TASK_KIND,
          retrySequence: 0,
          generation,
        },
  );
  const cleanupIdentity =
    payload.safeRejectedAttemptId || payload.pendingDeleteId || "none";
  return `tg_${crypto
    .createHash("sha256")
    .update(
      [
        payload.messageKey,
        payload.revision,
        payload.taskKind,
        payload.retrySequence,
        payload.generation,
        cleanupIdentity,
        payload.retryProofLeaseOwner || "none",
        payload.proofTaskKind || "none",
        payload.barrierProofOwner || "none",
        payload.barrierRetryNotBeforeMs || 0,
        payload.apiGateReclaimOwner || "none",
        payload.apiGateSettleOwner || "none",
      ].join(":"),
    )
    .digest("hex")
    .slice(0, 40)}`;
};

module.exports = {
  buildTelegramDeliveryTaskId,
  normalizeOptionalTimestamp,
  normalizeTaskPayload,
};
