// Generated from src/telegram/deliveryCleanupRecords.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.orphanPendingDeleteRecord = orphanPendingDeleteRecord;
exports.recordCleanupRetryProof = recordCleanupRetryProof;
exports.recordCleanupRetryState = recordCleanupRetryState;
exports.acquirePendingDeleteRecord = acquirePendingDeleteRecord;
exports.clearPendingDeleteRecord = clearPendingDeleteRecord;
const deliveryState_js_1 = require("./deliveryState.js");
const deliveryPolicy_js_1 = require("./deliveryPolicy.js");
const taskKinds_js_1 = require("./taskKinds.js");
const values_js_1 = require("./values.js");
function orphanPendingDeleteRecord(current, input) {
  const { apiGateSettleOwner, nowMs, ownerToken, pendingDeleteId, result } =
    input;
  const apply = (record) => {
    const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
    const pendingDelete = (0, deliveryState_js_1.readPendingDelete)(
      delivery.pendingDelete,
    );
    if (
      (0, deliveryState_js_1.normalizeString)(pendingDelete.pendingDeleteId) !==
        pendingDeleteId ||
      (ownerToken &&
        (0, deliveryState_js_1.normalizeString)(pendingDelete.leaseOwner) !==
          ownerToken)
    ) {
      return { commit: false, decision: "pending-delete-lost" };
    }
    const orphanedDeletes = asObject(delivery.orphanedDeletes);
    const nextDelivery = (0, deliveryState_js_1.promotePendingDeleteQueue)({
      ...(0, deliveryState_js_1.omitKeys)(delivery, ["pendingDelete"]),
      orphanedDeletes: {
        ...orphanedDeletes,
        [pendingDeleteId]: {
          ...(0, deliveryPolicy_js_1.omitRetryState)(
            (0, deliveryState_js_1.omitKeys)(pendingDelete, [
              "leaseOwner",
              "leaseExpiresAtMs",
              "status",
            ]),
          ),
          terminalAtMs: nowMs,
          lastError: (0, deliveryPolicy_js_1.buildErrorState)(result, nowMs),
        },
      },
    });
    return {
      value: {
        ...record,
        delivery: {
          ...nextDelivery,
          ...((0, deliveryState_js_1.normalizeString)(apiGateSettleOwner)
            ? { pendingDeleteApiGateSettleOwner: apiGateSettleOwner }
            : {}),
        },
      },
      decision: "pending-delete-orphaned",
    };
  };
  const output = apply(asObject(current));
  return output;
}
function recordCleanupRetryProof(current, input) {
  const {
    apiGateOwner,
    barrierRetryNotBeforeMs,
    ownerToken,
    pendingDeleteId,
    retryState,
    revision,
  } = input;
  const apply = (record) => {
    const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
    const latestPendingDelete = (0, deliveryState_js_1.readPendingDelete)(
      delivery.pendingDelete,
    );
    if (
      (0, deliveryState_js_1.normalizeString)(
        latestPendingDelete.pendingDeleteId,
      ) !== pendingDeleteId ||
      (0, deliveryState_js_1.normalizeString)(
        latestPendingDelete.leaseOwner,
      ) !== ownerToken
    ) {
      return { commit: false, decision: "pending-delete-lost" };
    }
    return {
      value: {
        ...record,
        delivery: {
          ...(0, deliveryState_js_1.deliveryDocument)(delivery),
          pendingDelete: {
            ...(0, deliveryState_js_1.pendingDeleteDocument)(
              latestPendingDelete,
            ),
            apiGateProofRequired: {
              owner: apiGateOwner,
              retryNotBeforeMs: barrierRetryNotBeforeMs,
              revision,
              proofTaskKind: taskKinds_js_1.TELEGRAM_PENDING_DELETE_TASK_KIND,
              pendingDeleteId,
              retryProofLeaseOwner: ownerToken,
              ...retryState,
            },
          },
        },
      },
      decision: "pending-rate-limit-proof-required",
    };
  };
  const output = apply(asObject(current));
  return output;
}
function recordCleanupRetryState(current, input) {
  const {
    finalizedAtMs,
    ownerToken,
    pendingDeleteId,
    preserveApiGateIdentity,
    result,
    retryState,
  } = input;
  const apply = (record) => {
    const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
    const latestPendingDelete = (0, deliveryState_js_1.readPendingDelete)(
      delivery.pendingDelete,
    );
    if (
      (0, deliveryState_js_1.normalizeString)(
        latestPendingDelete.pendingDeleteId,
      ) !== pendingDeleteId ||
      (0, deliveryState_js_1.normalizeString)(
        latestPendingDelete.leaseOwner,
      ) !== ownerToken
    ) {
      return { commit: false, decision: "pending-delete-lost" };
    }
    return {
      value: {
        ...record,
        delivery: {
          ...(0, deliveryState_js_1.deliveryDocument)(delivery),
          pendingDelete: (0, deliveryState_js_1.writeCleanup)({
            ...(0, deliveryPolicy_js_1.omitRetryState)(
              (0, deliveryState_js_1.omitKeys)(latestPendingDelete, [
                "leaseOwner",
                "leaseExpiresAtMs",
                "lastError",
                ...(preserveApiGateIdentity
                  ? []
                  : [
                      "apiGateOwner",
                      "apiGateGeneration",
                      "apiGateStartedAtMs",
                      "apiGateProofRequired",
                    ]),
              ]),
            ),
            status: "retryable",
            ...retryState,
            lastError: (0, deliveryPolicy_js_1.buildErrorState)(
              result,
              finalizedAtMs,
            ),
          }),
        },
      },
      decision: "pending-delete-retryable",
    };
  };
  const output = apply(asObject(current));
  return output;
}
function acquirePendingDeleteRecord(current, input) {
  const {
    leaseTtlMs,
    normalizedMessageKey,
    nowMs,
    ownerToken,
    requestedGeneration,
    requestedPendingDeleteId,
    observeDecision,
  } = input;
  const apply = (record) => {
    let decision = "missing";
    const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
    const pendingDelete = (0, deliveryState_js_1.readPendingDelete)(
      delivery.pendingDelete,
    );
    if (delivery.status === "uncertain" || delivery.hasSendInFlight) {
      decision = "blocked-uncertain";
      observeDecision(decision);
      return { commit: false, decision };
    }
    const chatId = pendingDelete.chatIdText;
    const messageId = pendingDelete.numericMessageId;
    if (!pendingDelete.present) {
      decision = "missing";
      observeDecision(decision);
      return { commit: false, decision };
    }
    const pendingDeleteId = (0, deliveryState_js_1.resolvePendingDeleteId)(
      pendingDelete,
    );
    if (
      requestedPendingDeleteId &&
      requestedPendingDeleteId !== pendingDeleteId
    ) {
      decision = "stale";
      observeDecision(decision);
      return { commit: false, decision };
    }
    const currentApiGateOwner = (0, deliveryState_js_1.normalizeString)(
      pendingDelete.apiGateOwner,
    );
    const currentProofGateOwner = (0, deliveryState_js_1.normalizeString)(
      (0, values_js_1.readProperty)(
        pendingDelete.apiGateProofRequired,
        "owner",
      ),
    );
    if (currentApiGateOwner && currentApiGateOwner === currentProofGateOwner) {
      decision = "rate-limit-proof-pending";
      observeDecision(decision);
      return { commit: false, decision };
    }
    if (!chatId || !Number.isInteger(messageId) || messageId <= 0) {
      decision = "invalid";
      observeDecision(decision);
      const apiGateOwner = (0, deliveryState_js_1.normalizeString)(
        pendingDelete.apiGateOwner,
      );
      const proofGateOwner = (0, deliveryState_js_1.normalizeString)(
        (0, values_js_1.readProperty)(
          pendingDelete.apiGateProofRequired,
          "owner",
        ),
      );
      const shouldSettleApiGate =
        apiGateOwner && apiGateOwner !== proofGateOwner;
      const nextDelivery = (0, deliveryState_js_1.promotePendingDeleteQueue)({
        ...(0, deliveryState_js_1.omitKeys)(delivery, ["pendingDelete"]),
        orphanedDeletes: {
          ...asObject(delivery.orphanedDeletes),
          [pendingDeleteId]: {
            ...(0, deliveryState_js_1.pendingDeleteDocument)(pendingDelete),
            pendingDeleteId,
            terminalAtMs: nowMs,
            lastError: {
              code: "invalid-pending-delete",
              atMs: nowMs,
            },
          },
        },
      });
      return {
        value: {
          ...record,
          delivery: {
            ...nextDelivery,
            ...(shouldSettleApiGate
              ? { pendingDeleteApiGateSettleOwner: apiGateOwner }
              : {}),
          },
        },
        decision,
      };
    }
    const retryDeadlineAtMs = (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(
      pendingDelete,
    );
    const leaseExpiresAtMs = (0, deliveryPolicy_js_1.normalizeTimestamp)(
      pendingDelete.leaseExpiresAtMs,
    );
    if (
      pendingDelete.status === "processing" &&
      (0, deliveryState_js_1.normalizeString)(pendingDelete.leaseOwner) !==
        ownerToken &&
      leaseExpiresAtMs > nowMs
    ) {
      decision = "locked";
      observeDecision(decision);
      return { commit: false, decision };
    }
    if (
      ["pending", "processing", "retryable"].includes(pendingDelete.status) &&
      retryDeadlineAtMs > 0 &&
      retryDeadlineAtMs <= nowMs
    ) {
      decision = "exhausted";
      observeDecision(decision);
      const apiGateOwner = (0, deliveryState_js_1.normalizeString)(
        pendingDelete.apiGateOwner,
      );
      const proofGateOwner = (0, deliveryState_js_1.normalizeString)(
        (0, values_js_1.readProperty)(
          pendingDelete.apiGateProofRequired,
          "owner",
        ),
      );
      const shouldSettleApiGate =
        apiGateOwner && apiGateOwner !== proofGateOwner;
      const nextDelivery = (0, deliveryState_js_1.promotePendingDeleteQueue)({
        ...(0, deliveryState_js_1.omitKeys)(delivery, ["pendingDelete"]),
        orphanedDeletes: {
          ...asObject(delivery.orphanedDeletes),
          [pendingDeleteId]: {
            ...(0, deliveryPolicy_js_1.omitRetryState)(
              (0, deliveryState_js_1.pendingDeleteDocument)(pendingDelete),
            ),
            pendingDeleteId,
            terminalAtMs: nowMs,
            lastError: {
              code: "safe-retry-window-exhausted",
              atMs: nowMs,
            },
          },
        },
      });
      return {
        value: {
          ...record,
          delivery: {
            ...nextDelivery,
            ...(shouldSettleApiGate
              ? { pendingDeleteApiGateSettleOwner: apiGateOwner }
              : {}),
          },
        },
        decision,
      };
    }
    if (
      pendingDelete.status === "retryable" &&
      (0, deliveryPolicy_js_1.normalizeTimestamp)(pendingDelete.retryAtMs) >
        nowMs
    ) {
      decision = "deferred";
      observeDecision(decision);
      return { commit: false, decision };
    }
    decision = "acquired";
    observeDecision(decision);
    const apiGateGeneration =
      (0, deliveryState_js_1.normalizeString)(
        pendingDelete.apiGateGeneration,
      ) ||
      (0, deliveryState_js_1.normalizeString)(requestedGeneration) ||
      `direct:${pendingDeleteId}`;
    return {
      value: {
        ...record,
        delivery: {
          ...(0, deliveryState_js_1.deliveryDocument)(delivery),
          pendingDelete: (0, deliveryState_js_1.writeCleanup)({
            ...(0, deliveryState_js_1.pendingDeleteDocument)(pendingDelete),
            pendingDeleteId,
            status: "processing",
            attempts:
              (0, deliveryPolicy_js_1.normalizeAttempts)(
                pendingDelete.attempts,
              ) + 1,
            leaseOwner: ownerToken,
            leaseExpiresAtMs: nowMs + leaseTtlMs,
            startedAtMs: nowMs,
            apiGateOwner:
              (0, deliveryState_js_1.normalizeString)(
                pendingDelete.apiGateOwner,
              ) ||
              (0, deliveryState_js_1.buildApiGateOwner)(
                normalizedMessageKey,
                "pending-delete",
                pendingDeleteId,
                apiGateGeneration,
              ),
            apiGateGeneration,
            apiGateStartedAtMs:
              (0, deliveryPolicy_js_1.normalizeTimestamp)(
                pendingDelete.apiGateStartedAtMs,
              ) || nowMs,
          }),
        },
      },
      decision,
    };
  };
  const output = apply(asObject(current));
  return output;
}
function clearPendingDeleteRecord(current, input) {
  const { apiGateOwner, ownerToken, pendingDeleteId } = input;
  const apply = (record) => {
    const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
    const latestPendingDelete = (0, deliveryState_js_1.readPendingDelete)(
      delivery.pendingDelete,
    );
    if (
      (0, deliveryState_js_1.normalizeString)(
        latestPendingDelete.pendingDeleteId,
      ) !== pendingDeleteId ||
      (0, deliveryState_js_1.normalizeString)(
        latestPendingDelete.leaseOwner,
      ) !== ownerToken
    ) {
      return { commit: false, decision: "pending-delete-lost" };
    }
    return {
      value: {
        ...record,
        delivery: {
          ...(0, deliveryState_js_1.promotePendingDeleteQueue)(delivery),
          pendingDeleteApiGateSettleOwner: apiGateOwner,
        },
      },
      decision: "pending-delete-cleared",
    };
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
