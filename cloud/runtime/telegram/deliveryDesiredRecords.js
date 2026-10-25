// Generated from src/telegram/deliveryDesiredRecords.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.acquireDesiredRecord = acquireDesiredRecord;
exports.finishDesiredRecord = finishDesiredRecord;
exports.recordDesiredRetryProof = recordDesiredRetryProof;
exports.recordDesiredRetryState = recordDesiredRetryState;
exports.markAppliedStateUnknownRecord = markAppliedStateUnknownRecord;
exports.clearMissingAppliedRecord = clearMissingAppliedRecord;
const deliveryState_js_1 = require("./deliveryState.js");
const deliveryPolicy_js_1 = require("./deliveryPolicy.js");
const values_js_1 = require("./values.js");
function acquireDesiredRecord(current, input) {
  const { leaseTtlMs, nowMs, ownerToken, observeDecision } = input;
  const apply = (record) => {
    let acquireDecision = "missing";
    const desired = asObject(record.desired);
    const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
    const desiredRevision = (0, deliveryState_js_1.normalizeString)(
      desired.revision,
    );
    const leaseExpiresAtMs = Number(delivery.leaseExpiresAtMs) || 0;
    if ((0, deliveryState_js_1.normalizeString)(delivery.apiGateSettleOwner)) {
      acquireDecision = "desired-api-gate-settle-pending";
      observeDecision(acquireDecision);
      return { commit: false, decision: acquireDecision };
    }
    if (
      (0, deliveryState_js_1.normalizeString)(
        delivery.pendingDeleteApiGateSettleOwner,
      )
    ) {
      acquireDecision = "pending-api-gate-settle-pending";
      observeDecision(acquireDecision);
      return { commit: false, decision: acquireDecision };
    }
    if (
      delivery.status === "processing" &&
      (0, deliveryState_js_1.normalizeString)(delivery.leaseOwner) !==
        ownerToken &&
      leaseExpiresAtMs > nowMs
    ) {
      acquireDecision = "locked";
      observeDecision(acquireDecision);
      return { commit: false, decision: acquireDecision };
    }
    const currentApiGateOwner =
      (0, deliveryState_js_1.normalizeString)(delivery.apiGateOwner) ||
      (0, deliveryState_js_1.normalizeString)(
        (0, values_js_1.readProperty)(delivery.sendInFlight, "apiGateOwner"),
      );
    const currentProofGateOwner = (0, deliveryState_js_1.normalizeString)(
      (0, values_js_1.readProperty)(delivery.apiGateProofRequired, "owner"),
    );
    if (currentApiGateOwner && currentApiGateOwner === currentProofGateOwner) {
      acquireDecision = "rate-limit-proof-pending";
      observeDecision(acquireDecision);
      return { commit: false, decision: acquireDecision };
    }
    const pendingDelete = (0, deliveryState_js_1.readPendingDelete)(
      delivery.pendingDelete,
    );
    const pendingApiGateOwner = (0, deliveryState_js_1.normalizeString)(
      pendingDelete.apiGateOwner,
    );
    const pendingProofGateOwner = (0, deliveryState_js_1.normalizeString)(
      (0, values_js_1.readProperty)(
        pendingDelete.apiGateProofRequired,
        "owner",
      ),
    );
    if (pendingApiGateOwner && pendingApiGateOwner === pendingProofGateOwner) {
      acquireDecision = "pending-rate-limit-proof-pending";
      observeDecision(acquireDecision);
      return { commit: false, decision: acquireDecision };
    }
    if (
      pendingApiGateOwner &&
      pendingDelete.status === "processing" &&
      (0, deliveryPolicy_js_1.normalizeTimestamp)(
        pendingDelete.leaseExpiresAtMs,
      ) <= nowMs
    ) {
      acquireDecision = "pending-api-gate-settle-pending";
      observeDecision(acquireDecision);
      return {
        value: {
          ...record,
          delivery: {
            ...(0, deliveryState_js_1.deliveryDocument)(delivery),
            pendingDelete: (0, deliveryState_js_1.omitKeys)(pendingDelete, [
              "apiGateOwner",
              "apiGateGeneration",
            ]),
            pendingDeleteApiGateSettleOwner: pendingApiGateOwner,
          },
        },
        decision: acquireDecision,
      };
    }
    if (delivery.hasSendInFlight) {
      const sendInFlight = asObject(delivery.sendInFlight);
      const sendApiGateOwner = (0, deliveryState_js_1.normalizeString)(
        sendInFlight.apiGateOwner,
      );
      const revision =
        desiredRevision ||
        (0, deliveryState_js_1.normalizeString)(delivery.revision) ||
        "invalid";
      acquireDecision = "in-flight-uncertain";
      observeDecision(acquireDecision);
      if (delivery.status === "uncertain") {
        if (
          (0, deliveryState_js_1.normalizeString)(delivery.revision) ===
          revision
        ) {
          return { commit: false, decision: acquireDecision };
        }
        return {
          value: {
            ...record,
            delivery: (0, deliveryState_js_1.writeDelivery)({
              ...(0, deliveryState_js_1.deliveryDocument)(delivery),
              status: "uncertain",
              revision,
              attempts: 0,
              sendInFlight: (0, deliveryState_js_1.preserveSendEvidence)(
                sendInFlight,
              ),
            }),
          },
          decision: acquireDecision,
        };
      }
      return {
        value: {
          ...record,
          delivery: (0, deliveryState_js_1.writeDelivery)({
            ...(0, deliveryState_js_1.omitKeys)(delivery, [
              "leaseOwner",
              "leaseExpiresAtMs",
              "retryAtMs",
            ]),
            status: "uncertain",
            revision,
            uncertainAtMs: nowMs,
            uncertainReason: "abandoned-send-in-flight",
            sendInFlight: (0, deliveryState_js_1.preserveSendEvidence)(
              sendInFlight,
            ),
            ...(sendApiGateOwner
              ? { apiGateSettleOwner: sendApiGateOwner }
              : {}),
            lastError: {
              code: "abandoned-send-in-flight",
              atMs: nowMs,
            },
          }),
        },
        decision: acquireDecision,
      };
    }
    if (!(0, deliveryState_js_1.validateDesiredForDelivery)(desired)) {
      acquireDecision = "invalid";
      observeDecision(acquireDecision);
      const apiGateOwner = (0, deliveryState_js_1.normalizeString)(
        delivery.apiGateOwner,
      );
      const proofGateOwner = (0, deliveryState_js_1.normalizeString)(
        (0, values_js_1.readProperty)(delivery.apiGateProofRequired, "owner"),
      );
      const shouldSettleApiGate =
        apiGateOwner && apiGateOwner !== proofGateOwner;
      return {
        value: {
          ...record,
          delivery: (0, deliveryState_js_1.writeDelivery)({
            ...(0, deliveryPolicy_js_1.omitRetryState)(
              (0, deliveryState_js_1.omitKeys)(delivery, [
                "leaseOwner",
                "leaseExpiresAtMs",
                "lastError",
                ...(shouldSettleApiGate
                  ? ["apiGateOwner", "apiGateGeneration", "apiGateStartedAtMs"]
                  : []),
              ]),
            ),
            ...(shouldSettleApiGate
              ? { apiGateSettleOwner: apiGateOwner }
              : {}),
            status: "terminal",
            revision: desiredRevision || "invalid",
            attempts: (0, deliveryPolicy_js_1.normalizeAttempts)(
              delivery.attempts,
            ),
            lastError: {
              code: "invalid-desired-state",
              atMs: nowMs,
            },
          }),
        },
        decision: acquireDecision,
      };
    }
    const revision = desired.revision;
    if (
      delivery.revision === revision &&
      ["pending", "processing", "retryable"].includes(delivery.status) &&
      (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(delivery) > 0 &&
      (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(delivery) <= nowMs
    ) {
      acquireDecision = "retry-exhausted";
      observeDecision(acquireDecision);
      const apiGateOwner = (0, deliveryState_js_1.normalizeString)(
        delivery.apiGateOwner,
      );
      const proofGateOwner = (0, deliveryState_js_1.normalizeString)(
        (0, values_js_1.readProperty)(delivery.apiGateProofRequired, "owner"),
      );
      const shouldSettleApiGate =
        apiGateOwner && apiGateOwner !== proofGateOwner;
      return {
        value: {
          ...record,
          delivery: (0, deliveryState_js_1.writeDelivery)({
            ...(0, deliveryPolicy_js_1.omitRetryState)(
              (0, deliveryState_js_1.omitKeys)(delivery, [
                "leaseOwner",
                "leaseExpiresAtMs",
                "sendInFlight",
                ...(shouldSettleApiGate
                  ? ["apiGateOwner", "apiGateGeneration", "apiGateStartedAtMs"]
                  : []),
              ]),
            ),
            ...(shouldSettleApiGate
              ? { apiGateSettleOwner: apiGateOwner }
              : {}),
            status: "terminal",
            revision,
            deadLetterAtMs: nowMs,
            lastError: {
              code: "safe-retry-window-exhausted",
              atMs: nowMs,
            },
          }),
        },
        decision: acquireDecision,
      };
    }
    if (
      delivery.revision === revision &&
      delivery.status === "retryable" &&
      Number(delivery.retryAtMs) > nowMs
    ) {
      acquireDecision = "deferred";
      observeDecision(acquireDecision);
      return { commit: false, decision: acquireDecision };
    }
    if (
      delivery.revision === revision &&
      (delivery.status === "terminal" ||
        delivery.status === "uncertain" ||
        delivery.status === "delivered")
    ) {
      acquireDecision = "settled";
      observeDecision(acquireDecision);
      return { commit: false, decision: acquireDecision };
    }
    const deliveryForAcquire = delivery;
    acquireDecision = "acquired";
    observeDecision(acquireDecision);
    const sameRevision = deliveryForAcquire.revision === revision;
    const proofRequiredOwner = (0, deliveryState_js_1.normalizeString)(
      (0, values_js_1.readProperty)(
        deliveryForAcquire.apiGateProofRequired,
        "owner",
      ),
    );
    const previousApiGateOwner = (0, deliveryState_js_1.normalizeString)(
      deliveryForAcquire.apiGateOwner,
    );
    const supersededApiGateOwner =
      (0, deliveryState_js_1.normalizeString)(
        deliveryForAcquire.apiGateSettleOwner,
      ) ||
      (sameRevision || previousApiGateOwner === proofRequiredOwner
        ? ""
        : previousApiGateOwner);
    const deliveryForRevision = sameRevision
      ? deliveryForAcquire
      : (0, deliveryPolicy_js_1.omitRetryState)(
          (0, deliveryState_js_1.omitKeys)(deliveryForAcquire, [
            "safeRejectionAtMs",
            "safeRejectionRecoveredAtMs",
            "apiGateOwner",
            "apiGateGeneration",
            "apiGateStartedAtMs",
            "apiGateSettleOwner",
          ]),
        );
    return {
      value: {
        ...record,
        delivery: (0, deliveryState_js_1.writeDelivery)({
          ...(0, deliveryState_js_1.omitKeys)(deliveryForRevision, [
            "retryAtMs",
            "lastError",
            "deadLetterAtMs",
          ]),
          ...(supersededApiGateOwner
            ? { apiGateSettleOwner: supersededApiGateOwner }
            : {}),
          status: "processing",
          revision,
          attempts: sameRevision
            ? (0, deliveryPolicy_js_1.normalizeAttempts)(
                deliveryForRevision.attempts,
              ) + 1
            : 1,
          leaseOwner: ownerToken,
          leaseExpiresAtMs: nowMs + leaseTtlMs,
          startedAtMs: nowMs,
        }),
      },
      decision: acquireDecision,
    };
  };
  const output = apply(asObject(current));
  return output;
}
function finishDesiredRecord(current, delivery, input) {
  const {
    apiGateSettleOwner,
    clearAppliedStateUnknown,
    desired,
    nowMs,
    receipt,
    result,
    status,
  } = input;
  const apply = (record) => {
    const latestRevision = (0, deliveryState_js_1.normalizeString)(
      (0, values_js_1.readProperty)(record.desired, "revision"),
    );
    const desiredStillLatest = latestRevision === desired.revision;
    const revision = desiredStillLatest ? desired.revision : latestRevision;
    const transition =
      status === "uncertain"
        ? {
            status,
            revision,
            sendInFlight: delivery.preservedSendInFlight(),
          }
        : !desiredStillLatest
          ? { status: "pending", revision }
          : status === "delivered"
            ? { status, revision, deliveredAtMs: nowMs }
            : { status, revision };
    const nextDelivery = asObject(
      (0, deliveryState_js_1.writeDelivery)({
        ...(0, deliveryPolicy_js_1.omitRetryState)(
          (0, deliveryState_js_1.omitKeys)(delivery, [
            "leaseOwner",
            "leaseExpiresAtMs",
            "lastError",
            "uncertainAtMs",
            "uncertainReason",
            "deadLetterAtMs",
            "apiGateOwner",
            "apiGateGeneration",
            "apiGateStartedAtMs",
            ...(clearAppliedStateUnknown ? ["appliedStateUnknown"] : []),
            ...(status === "uncertain" ? [] : ["sendInFlight"]),
          ]),
        ),
        ...transition,
        ...((0, deliveryState_js_1.normalizeString)(apiGateSettleOwner)
          ? { apiGateSettleOwner: apiGateSettleOwner }
          : {}),
      }),
    );
    if (!desiredStillLatest) {
      nextDelivery.attempts = 0;
      delete nextDelivery.deliveredAtMs;
    }
    if (status === "delivered" && desiredStillLatest) {
      nextDelivery.deliveredAtMs = nowMs;
    }
    if (
      ((desiredStillLatest && status === "terminal") ||
        status === "uncertain") &&
      result
    ) {
      nextDelivery.lastError = (0, deliveryPolicy_js_1.buildErrorState)(
        result,
        nowMs,
      );
    }
    if (status === "uncertain") {
      nextDelivery.uncertainAtMs = nowMs;
      nextDelivery.uncertainReason =
        (0, deliveryState_js_1.normalizeString)(result?.code) ||
        "ambiguous-send";
    }
    if (
      desiredStillLatest &&
      status === "terminal" &&
      result?.code === "safe-retry-window-exhausted"
    ) {
      nextDelivery.deadLetterAtMs = nowMs;
    }
    const nextRecord = {
      ...record,
      delivery: nextDelivery,
    };
    if (receipt?.kind === "clear") {
      delete nextRecord.applied;
    } else if (receipt?.kind === "set") {
      nextRecord.applied = receipt.value;
    }
    return nextRecord;
  };
  const output = apply(asObject(current));
  return output;
}
function recordDesiredRetryProof(current, delivery, input) {
  const {
    apiGateOwner,
    barrierRetryNotBeforeMs,
    desired,
    ownerToken,
    pendingDeleteId,
    proofTaskKind,
    retryState,
    safeRejectedAttemptId,
  } = input;
  const apply = (record) => ({
    ...record,
    delivery: {
      ...(0, deliveryState_js_1.deliveryDocument)(delivery),
      apiGateProofRequired: {
        owner: apiGateOwner,
        retryNotBeforeMs: barrierRetryNotBeforeMs,
        revision: desired.revision,
        proofTaskKind,
        ...retryState,
        ...(safeRejectedAttemptId ? { safeRejectedAttemptId } : {}),
        ...(pendingDeleteId ? { pendingDeleteId } : {}),
        ...(!safeRejectedAttemptId ? { retryProofLeaseOwner: ownerToken } : {}),
      },
    },
  });
  const output = apply(asObject(current));
  return output;
}
function recordDesiredRetryState(current, delivery, input) {
  const {
    desired,
    finalizedAtMs,
    preserveApiGateIdentity,
    result,
    retryState,
  } = input;
  const apply = (record) => {
    const latestRevision = (0, deliveryState_js_1.normalizeString)(
      (0, values_js_1.readProperty)(record.desired, "revision"),
    );
    const desiredStillLatest = latestRevision === desired.revision;
    return {
      ...record,
      delivery: (0, deliveryState_js_1.writeDelivery)({
        ...(0, deliveryPolicy_js_1.omitRetryState)(
          (0, deliveryState_js_1.omitKeys)(delivery, [
            "leaseOwner",
            "leaseExpiresAtMs",
            "lastError",
            "sendInFlight",
            ...(preserveApiGateIdentity
              ? []
              : [
                  "apiGateOwner",
                  "apiGateGeneration",
                  "apiGateStartedAtMs",
                  "apiGateProofRequired",
                  "apiGateSettleOwner",
                ]),
          ]),
        ),
        ...(desiredStillLatest
          ? {
              status: "retryable",
              revision: desired.revision,
              attempts: (0, deliveryPolicy_js_1.normalizeAttempts)(
                delivery.attempts,
              ),
              ...retryState,
            }
          : {
              status: "pending",
              revision: latestRevision,
              attempts: 0,
            }),
        ...(desiredStillLatest
          ? {
              lastError: (0, deliveryPolicy_js_1.buildErrorState)(
                result,
                finalizedAtMs,
              ),
              ...(result?.code === "rate-limited"
                ? { safeRejectionAtMs: finalizedAtMs }
                : {}),
            }
          : {}),
      }),
    };
  };
  const output = apply(asObject(current));
  return output;
}
function markAppliedStateUnknownRecord(current, delivery, input) {
  const { apiGateOwner, desired, markedAtMs, operation } = input;
  const apply = (record) => ({
    ...record,
    delivery: {
      ...(0, deliveryState_js_1.deliveryDocument)(delivery),
      appliedStateUnknown: {
        revision: desired.revision,
        operation,
        apiGateOwner,
        markedAtMs,
      },
    },
  });
  const output = apply(asObject(current));
  return output;
}
function clearMissingAppliedRecord(current, delivery, input) {
  const { apiGateOwner } = input;
  const apply = (record) => {
    const nextRecord = {
      ...record,
      delivery: {
        ...(0, deliveryState_js_1.omitKeys)(delivery, [
          "apiGateOwner",
          "apiGateGeneration",
          "apiGateStartedAtMs",
          "appliedStateUnknown",
        ]),
        apiGateSettleOwner: apiGateOwner,
      },
    };
    delete nextRecord.applied;
    return nextRecord;
  };
  const output = apply(asObject(current));
  return output;
}
const asObject = (value) => {
  const retained =
    value instanceof deliveryState_js_1.DeliverySnapshot
      ? (0, deliveryState_js_1.deliveryDocument)(value)
      : value instanceof deliveryState_js_1.PendingDeleteSnapshot
        ? (0, deliveryState_js_1.pendingDeleteDocument)(value)
        : value;
  return retained && typeof retained === "object" && !Array.isArray(retained)
    ? retained
    : {};
};
