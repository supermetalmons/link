// Generated from src/telegram/retryRecords.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readBarrierProofInput =
  exports.captureCleanupWindowProof =
  exports.captureDesiredWindowProof =
  exports.captureSafeRetryProof =
  exports.buildTelegramRetrySchedule =
    void 0;
exports.telegramRetryScheduleTime = telegramRetryScheduleTime;
exports.retainedRateLimitProof = retainedRateLimitProof;
exports.messageRateLimitProof = messageRateLimitProof;
exports.readRateLimitRetryState = readRateLimitRetryState;
exports.rateLimitProofRetryAt = rateLimitProofRetryAt;
exports.rateLimitProofOwner = rateLimitProofOwner;
exports.lockedDesiredRetryInput = lockedDesiredRetryInput;
exports.deferredDesiredRetryInput = deferredDesiredRetryInput;
exports.resumedRateLimitRetryInput = resumedRateLimitRetryInput;
exports.rateLimitBarrierInput = rateLimitBarrierInput;
exports.desiredSafeProofInput = desiredSafeProofInput;
exports.desiredWindowProofInput = desiredWindowProofInput;
exports.cleanupWindowProofInput = cleanupWindowProofInput;
exports.safeRetryProofIdentity = safeRetryProofIdentity;
exports.desiredWindowProofState = desiredWindowProofState;
exports.cleanupWindowProofState = cleanupWindowProofState;
exports.messageSettlementOwnerInput = messageSettlementOwnerInput;
const deliveryPolicy_js_1 = require("./deliveryPolicy.js");
const taskIdentity_js_1 = require("./taskIdentity.js");
const taskKinds_js_1 = require("./taskKinds.js");
const values_js_1 = require("./values.js");
const records_js_1 = require("./records.js");
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const proofFields = (value) => {
  const retained = value;
  return retained;
};
const applicationFields = (value) => {
  const retained = value;
  return retained;
};
const buildTelegramRetrySchedule = ({
  messageKey,
  revision,
  taskKind,
  retryState,
  safeRejectedAttemptId = "",
  pendingDeleteId = "",
  retryProofLeaseOwner = "",
  sourceGeneration = "",
  proofTaskKind = "",
  barrierProofOwner = "",
  barrierRetryNotBeforeMs = 0,
  scheduleTimeMs = 0,
  apiGateReclaimOwner = "",
  apiGateSettleOwner = "",
}) => {
  const normalizedTaskKind =
    normalizeString(taskKind) || taskKinds_js_1.TELEGRAM_DESIRED_TASK_KIND;
  const retrySequence = (0, deliveryPolicy_js_1.normalizeRetrySequence)(
    retryState.retrySequence,
  );
  const generation = [
    normalizedTaskKind,
    retrySequence,
    (0, deliveryPolicy_js_1.normalizeTimestamp)(retryState.retryAtMs),
    safeRejectedAttemptId || pendingDeleteId || revision,
    normalizeString(retryProofLeaseOwner),
    normalizeString(sourceGeneration),
    normalizeString(proofTaskKind),
    normalizeString(barrierProofOwner),
    (0, deliveryPolicy_js_1.normalizeTimestamp)(barrierRetryNotBeforeMs),
    normalizeString(apiGateReclaimOwner),
    normalizeString(apiGateSettleOwner),
  ].join(":");
  const payload = {
    messageKey,
    revision,
    taskKind: normalizedTaskKind,
    retrySequence,
    generation,
    retryStartedAtMs: (0, deliveryPolicy_js_1.normalizeTimestamp)(
      retryState.retryStartedAtMs,
    ),
    retryDeadlineAtMs: (0, deliveryPolicy_js_1.normalizeTimestamp)(
      retryState.retryDeadlineAtMs,
    ),
    retryAtMs: (0, deliveryPolicy_js_1.normalizeTimestamp)(
      retryState.retryAtMs,
    ),
    scheduleTimeMs:
      (0, deliveryPolicy_js_1.normalizeTimestamp)(scheduleTimeMs) ||
      (0, deliveryPolicy_js_1.normalizeTimestamp)(retryState.retryAtMs),
    ...(safeRejectedAttemptId ? { safeRejectedAttemptId } : {}),
    ...(pendingDeleteId ? { pendingDeleteId } : {}),
    ...(retryProofLeaseOwner ? { retryProofLeaseOwner } : {}),
    ...(proofTaskKind ? { proofTaskKind } : {}),
    ...(barrierProofOwner ? { barrierProofOwner } : {}),
    ...(barrierRetryNotBeforeMs ? { barrierRetryNotBeforeMs } : {}),
    ...(apiGateReclaimOwner ? { apiGateReclaimOwner } : {}),
    ...(apiGateSettleOwner ? { apiGateSettleOwner } : {}),
  };
  return payload;
};
exports.buildTelegramRetrySchedule = buildTelegramRetrySchedule;
function telegramRetryScheduleTime(input) {
  const retained = input;
  const value = retained;
  return (0, taskIdentity_js_1.normalizeOptionalTimestamp)(
    value.scheduleTimeMs,
  );
}
function retainedRateLimitProof(value) {
  return value;
}
function messageRateLimitProof(value, pending = false) {
  const source = pending
    ? (0, values_js_1.readProperty)(value, "pendingDelete")
    : value;
  const proof = (0, values_js_1.readProperty)(source, "apiGateProofRequired");
  return proof && typeof proof === "object" && !Array.isArray(proof)
    ? proof
    : {};
}
function readRateLimitRetryState(value) {
  const proof = proofFields(value);
  return {
    retryStartedAtMs: (0, deliveryPolicy_js_1.normalizeTimestamp)(
      proof.retryStartedAtMs,
    ),
    retryDeadlineAtMs: (0, deliveryPolicy_js_1.normalizeTimestamp)(
      proof.retryDeadlineAtMs,
    ),
    retryAtMs: (0, deliveryPolicy_js_1.normalizeTimestamp)(proof.retryAtMs),
    retrySequence: (0, deliveryPolicy_js_1.normalizeRetrySequence)(
      proof.retrySequence,
    ),
  };
}
function rateLimitProofRetryAt(value) {
  return (0, deliveryPolicy_js_1.normalizeTimestamp)(
    proofFields(value).retryNotBeforeMs,
  );
}
function rateLimitProofOwner(value) {
  return proofFields(value).owner;
}
function lockedDesiredRetryInput(delivery, context) {
  const input = {
    messageKey: context.messageKey,
    revision: context.revision,
    taskKind: taskKinds_js_1.TELEGRAM_DESIRED_TASK_KIND,
    retryState: {
      retryStartedAtMs:
        (0, values_js_1.readProperty)(
          (0, records_js_1.messageDeliveryDocument)(delivery),
          "retryStartedAtMs",
        ) || context.retryStartedAtMs,
      retryDeadlineAtMs:
        (0, values_js_1.readProperty)(
          (0, records_js_1.messageDeliveryDocument)(delivery),
          "retryDeadlineAtMs",
        ) || context.retryDeadlineAtMs,
      retryAtMs: context.retryAtMs,
      retrySequence:
        (0, values_js_1.readProperty)(
          (0, records_js_1.messageDeliveryDocument)(delivery),
          "retrySequence",
        ) ?? context.retrySequence,
    },
    sourceGeneration: context.sourceGeneration,
    apiGateReclaimOwner: context.apiGateReclaimOwner,
  };
  return input;
}
function deferredDesiredRetryInput(delivery, context) {
  const input = {
    messageKey: context.messageKey,
    revision: context.revision,
    taskKind: taskKinds_js_1.TELEGRAM_DESIRED_TASK_KIND,
    retryState: {
      retryStartedAtMs: (0, values_js_1.readProperty)(
        (0, records_js_1.messageDeliveryDocument)(delivery),
        "retryStartedAtMs",
      ),
      retryDeadlineAtMs: (0, values_js_1.readProperty)(
        (0, records_js_1.messageDeliveryDocument)(delivery),
        "retryDeadlineAtMs",
      ),
      retryAtMs: context.retryAtMs,
      retrySequence: (0, values_js_1.readProperty)(
        (0, records_js_1.messageDeliveryDocument)(delivery),
        "retrySequence",
      ),
    },
    sourceGeneration: context.sourceGeneration,
  };
  return input;
}
function resumedRateLimitRetryInput(value, context) {
  const proof = proofFields(value);
  const target = context.target;
  const input = {
    messageKey: context.messageKey,
    revision:
      normalizeString(proof.revision) || context.requestedRevision || "latest",
    taskKind: taskKinds_js_1.TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND,
    retryState: context.retryState,
    ...(target.kind === "desired"
      ? {
          safeRejectedAttemptId: normalizeString(proof.safeRejectedAttemptId),
          proofTaskKind: taskKinds_js_1.TELEGRAM_DESIRED_TASK_KIND,
        }
      : {
          pendingDeleteId:
            normalizeString(proof.pendingDeleteId) ||
            target.requestedPendingDeleteId ||
            "",
          proofTaskKind: taskKinds_js_1.TELEGRAM_PENDING_DELETE_TASK_KIND,
        }),
    retryProofLeaseOwner: normalizeString(proof.retryProofLeaseOwner),
    barrierProofOwner: proof.owner,
    barrierRetryNotBeforeMs: proof.retryNotBeforeMs,
    scheduleTimeMs: context.nowMs,
  };
  return input;
}
function rateLimitBarrierInput(value) {
  const proof = proofFields(value);
  const input = {
    barrierProofOwner: proof.owner,
    barrierRetryNotBeforeMs: proof.retryNotBeforeMs,
  };
  return input;
}
function desiredSafeProofInput(value, state) {
  const proof = proofFields(value);
  const input = {
    requestedRevision: proof.revision,
    safeRejectedAttemptId: proof.safeRejectedAttemptId,
    ...state,
  };
  return input;
}
function desiredWindowProofInput(value, state) {
  const proof = proofFields(value);
  const input = {
    requestedRevision: proof.revision,
    retryProofLeaseOwner: proof.retryProofLeaseOwner,
    ...state,
  };
  return input;
}
function cleanupWindowProofInput(value, state, target) {
  const proof = proofFields(value);
  const input = {
    pendingDeleteId:
      target.requestedPendingDeleteId === undefined
        ? proof.pendingDeleteId
        : normalizeString(proof.pendingDeleteId) ||
          target.requestedPendingDeleteId,
    retryProofLeaseOwner: proof.retryProofLeaseOwner,
    ...state,
  };
  return input;
}
const captureSafeRetryProof = ({
  requestedRevision,
  safeRejectedAttemptId,
  retryStartedAtMs,
  retryDeadlineAtMs,
  retryAtMs,
  retrySequence,
}) => {
  const captured = {
    requestedRevision,
    safeRejectedAttemptId,
    retryStartedAtMs,
    retryDeadlineAtMs,
    retryAtMs,
    retrySequence,
  };
  return captured;
};
exports.captureSafeRetryProof = captureSafeRetryProof;
const captureDesiredWindowProof = ({
  requestedRevision,
  safeRejectedAttemptId,
  retryStartedAtMs,
  retryDeadlineAtMs,
  retryAtMs,
  retrySequence,
  retryProofLeaseOwner,
  apiGateReclaimOwner,
}) => {
  const captured = {
    requestedRevision,
    safeRejectedAttemptId,
    retryStartedAtMs,
    retryDeadlineAtMs,
    retryAtMs,
    retrySequence,
    retryProofLeaseOwner,
    apiGateReclaimOwner,
  };
  return captured;
};
exports.captureDesiredWindowProof = captureDesiredWindowProof;
const captureCleanupWindowProof = ({
  pendingDeleteId,
  retryStartedAtMs,
  retryDeadlineAtMs,
  retryAtMs,
  retrySequence,
  retryProofLeaseOwner,
  apiGateReclaimOwner,
}) => {
  const captured = {
    pendingDeleteId,
    retryStartedAtMs,
    retryDeadlineAtMs,
    retryAtMs,
    retrySequence,
    retryProofLeaseOwner,
    apiGateReclaimOwner,
  };
  return captured;
};
exports.captureCleanupWindowProof = captureCleanupWindowProof;
function safeRetryProofIdentity(value) {
  const proof = applicationFields(value);
  const normalizedAttemptId = normalizeString(proof.safeRejectedAttemptId);
  const normalizedRevision = normalizeString(proof.requestedRevision);
  return { normalizedAttemptId, normalizedRevision };
}
function desiredWindowProofState(value) {
  const proof = applicationFields(value);
  if (normalizeString(proof.safeRejectedAttemptId)) return null;
  const normalizedRevision = normalizeString(proof.requestedRevision);
  const proofRetryState = {
    retryStartedAtMs: (0, deliveryPolicy_js_1.normalizeTimestamp)(
      proof.retryStartedAtMs,
    ),
    retryDeadlineAtMs: (0, deliveryPolicy_js_1.normalizeTimestamp)(
      proof.retryDeadlineAtMs,
    ),
    retryAtMs: (0, deliveryPolicy_js_1.normalizeTimestamp)(proof.retryAtMs),
    retrySequence: (0, deliveryPolicy_js_1.normalizeRetrySequence)(
      proof.retrySequence,
    ),
  };
  if (
    !normalizedRevision ||
    !proofRetryState.retryStartedAtMs ||
    !proofRetryState.retryDeadlineAtMs ||
    !proofRetryState.retryAtMs
  )
    return null;
  return { normalizedRevision, proofRetryState };
}
function cleanupWindowProofState(value) {
  const proof = applicationFields(value);
  const normalizedPendingDeleteId = normalizeString(proof.pendingDeleteId);
  const proofRetryState = {
    retryStartedAtMs: (0, deliveryPolicy_js_1.normalizeTimestamp)(
      proof.retryStartedAtMs,
    ),
    retryDeadlineAtMs: (0, deliveryPolicy_js_1.normalizeTimestamp)(
      proof.retryDeadlineAtMs,
    ),
    retryAtMs: (0, deliveryPolicy_js_1.normalizeTimestamp)(proof.retryAtMs),
    retrySequence: (0, deliveryPolicy_js_1.normalizeRetrySequence)(
      proof.retrySequence,
    ),
  };
  if (
    !normalizedPendingDeleteId ||
    !proofRetryState.retryStartedAtMs ||
    !proofRetryState.retryDeadlineAtMs ||
    !proofRetryState.retryAtMs
  )
    return null;
  return { normalizedPendingDeleteId, proofRetryState };
}
const readBarrierProofInput = ({
  barrierProofOwner,
  barrierRetryNotBeforeMs,
}) => {
  const owner = normalizeString(barrierProofOwner);
  const retryNotBeforeMs = (0, deliveryPolicy_js_1.normalizeTimestamp)(
    barrierRetryNotBeforeMs,
  );
  return { owner, retryNotBeforeMs };
};
exports.readBarrierProofInput = readBarrierProofInput;
function messageSettlementOwnerInput(message, field) {
  return (0, values_js_1.readProperty)(
    (0, values_js_1.readProperty)(message, "delivery"),
    field,
  );
}
