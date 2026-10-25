// Generated from src/telegram/deliveryRecoveryRecords.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applySafeRetryProofRecord = applySafeRetryProofRecord;
exports.applyDesiredRetryProofRecord = applyDesiredRetryProofRecord;
exports.applyManualRecoveryRecord = applyManualRecoveryRecord;
exports.settleManualGateReleaseRecord = settleManualGateReleaseRecord;
exports.applyCleanupRetryProofRecord = applyCleanupRetryProofRecord;
exports.observeManualRecoveryResult = observeManualRecoveryResult;
const records_js_1 = require("./records.js");
const records_js_2 = require("./records.js");
const deliveryState_js_1 = require("./deliveryState.js");
const deliveryPolicy_js_1 = require("./deliveryPolicy.js");
const values_js_1 = require("./values.js");
function applySafeRetryProofRecord(current, input) {
  const {
    normalizedAttemptId,
    normalizedRevision,
    now,
    application,
    markApplied,
  } = input;
  const { retryAtMs, retryDeadlineAtMs, retrySequence, retryStartedAtMs } =
    asObject(application);
  const apply = (record) => {
    const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
    const marker = asObject(delivery.sendInFlight);
    if (
      (0, deliveryState_js_1.normalizeString)(marker.attemptId) !==
        normalizedAttemptId ||
      (0, deliveryState_js_1.normalizeString)(marker.revision) !==
        normalizedRevision
    ) {
      return { commit: false, decision: "stale-safe-retry-proof" };
    }
    const latestRevision = (0, deliveryState_js_1.normalizeString)(
      (0, values_js_1.readProperty)(record.desired, "revision"),
    );
    const proofRetryState = {
      retryStartedAtMs: (0, deliveryPolicy_js_1.normalizeTimestamp)(
        retryStartedAtMs,
      ),
      retryDeadlineAtMs: (0, deliveryPolicy_js_1.normalizeTimestamp)(
        retryDeadlineAtMs,
      ),
      retryAtMs: (0, deliveryPolicy_js_1.normalizeTimestamp)(retryAtMs),
      retrySequence: (0, deliveryPolicy_js_1.normalizeRetrySequence)(
        retrySequence,
      ),
    };
    const proofIsComplete =
      proofRetryState.retryStartedAtMs > 0 &&
      proofRetryState.retryDeadlineAtMs > 0 &&
      proofRetryState.retryAtMs > 0;
    markApplied();
    return {
      value: {
        ...record,
        delivery: (0, deliveryState_js_1.writeDelivery)({
          ...(0, deliveryState_js_1.omitKeys)(delivery, [
            "leaseOwner",
            "leaseExpiresAtMs",
            "sendInFlight",
            "lastError",
            "apiGateProofRequired",
          ]),
          ...(latestRevision === normalizedRevision && proofIsComplete
            ? {
                status: "retryable",
                revision: latestRevision || normalizedRevision,
                attempts: (0, deliveryPolicy_js_1.normalizeAttempts)(
                  delivery.attempts,
                ),
                ...proofRetryState,
              }
            : {
                status: "pending",
                revision: latestRevision || normalizedRevision,
                attempts:
                  latestRevision === normalizedRevision
                    ? (0, deliveryPolicy_js_1.normalizeAttempts)(
                        delivery.attempts,
                      )
                    : 0,
              }),
          safeRejectionRecoveredAtMs: now(),
        }),
      },
      decision: "safe-retry-proof-applied",
    };
  };
  const output = apply(asObject(current));
  return output;
}
function applyDesiredRetryProofRecord(current, input) {
  const { normalizedRevision, now, proofRetryState, application, markApplied } =
    input;
  const { apiGateReclaimOwner, retryProofLeaseOwner } = asObject(application);
  const apply = (record) => {
    const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
    if (
      (0, deliveryState_js_1.normalizeString)(
        (0, values_js_1.readProperty)(record.desired, "revision"),
      ) !== normalizedRevision ||
      !delivery.matchesRevision(normalizedRevision) ||
      delivery.status !== "processing" ||
      delivery.hasSendInFlight ||
      !(0, deliveryState_js_1.normalizeString)(retryProofLeaseOwner) ||
      (0, deliveryState_js_1.normalizeString)(delivery.leaseOwner) !==
        (0, deliveryState_js_1.normalizeString)(retryProofLeaseOwner) ||
      proofRetryState.retrySequence <=
        (0, deliveryPolicy_js_1.normalizeRetrySequence)(delivery.retrySequence)
    ) {
      return { commit: false, decision: "stale-retry-window-proof" };
    }
    markApplied();
    const preservesApiGate =
      (0, deliveryState_js_1.normalizeString)(apiGateReclaimOwner) !== "" &&
      (0, deliveryState_js_1.normalizeString)(delivery.apiGateOwner) ===
        (0, deliveryState_js_1.normalizeString)(apiGateReclaimOwner);
    return {
      value: {
        ...record,
        delivery: (0, deliveryState_js_1.writeDelivery)({
          ...(0, deliveryState_js_1.omitKeys)(delivery, [
            "leaseOwner",
            "leaseExpiresAtMs",
            "lastError",
            ...(preservesApiGate
              ? []
              : [
                  "apiGateOwner",
                  "apiGateGeneration",
                  "apiGateStartedAtMs",
                  "apiGateProofRequired",
                ]),
          ]),
          status: "retryable",
          revision: delivery.revision,
          ...proofRetryState,
          retryWindowRecoveredAtMs: now(),
        }),
      },
      decision: "retry-window-proof-applied",
    };
  };
  const output = apply(asObject(current));
  return output;
}
function applyManualRecoveryRecord(current, input) {
  const { processedAtMs } = input;
  const apply = (record) => {
    const request = asObject(record.manualRecovery);
    const requestId = (0, deliveryState_js_1.normalizeString)(
      request.requestId,
    );
    const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
    if (
      !requestId ||
      (0, deliveryState_js_1.normalizeString)(
        delivery.lastRecoveryRequestId,
      ) === requestId
    ) {
      return { commit: false, decision: "no-manual-recovery" };
    }
    const action = (0, deliveryState_js_1.normalizeString)(request.action);
    const marker = asObject(delivery.sendInFlight);
    const markerAttemptId = (0, deliveryState_js_1.normalizeString)(
      marker.attemptId,
    );
    const markerApiGateOwner = (0, deliveryState_js_1.normalizeString)(
      marker.apiGateOwner,
    );
    const recoverable =
      delivery.status === "uncertain" && markerAttemptId !== "";
    const latestRevision = (0, deliveryState_js_1.normalizeString)(
      (0, values_js_1.readProperty)(record.desired, "revision"),
    );
    const recoveryResult = {
      requestId,
      action,
      processedAtMs,
    };
    const baseDelivery = {
      ...(0, deliveryState_js_1.deliveryDocument)(delivery),
      lastRecoveryRequestId: requestId,
    };
    let nextRecord = record;
    if (action === "confirm-send-absent" && recoverable) {
      nextRecord = {
        ...record,
        delivery: (0, deliveryState_js_1.writeDelivery)({
          ...(0, deliveryPolicy_js_1.omitRetryState)(
            (0, deliveryState_js_1.omitKeys)(baseDelivery, [
              "leaseOwner",
              "leaseExpiresAtMs",
              "sendInFlight",
              "lastError",
              "uncertainAtMs",
              "uncertainReason",
              "deadLetterAtMs",
            ]),
          ),
          status: "pending",
          revision: latestRevision,
          attempts: 0,
          ...(markerApiGateOwner
            ? { apiGateReleaseOwner: markerApiGateOwner }
            : {}),
        }),
        manualRecoveryResult: {
          ...recoveryResult,
          status: "accepted",
        },
      };
    } else if (
      action === "confirm-send-applied" &&
      recoverable &&
      Number.isInteger(Number(request.messageId)) &&
      Number(request.messageId) > 0
    ) {
      const recoveredApplied = {
        destination: (0, deliveryState_js_1.normalizeString)(
          marker.destination,
        ),
        chatId: (0, deliveryState_js_1.normalizeString)(marker.chatId),
        messageId: Number(request.messageId),
        instanceKey: (0, deliveryState_js_1.normalizeString)(
          marker.instanceKey,
        ),
        revision: (0, deliveryState_js_1.normalizeString)(marker.revision),
        contentHash: (0, deliveryState_js_1.normalizeString)(
          marker.contentHash,
        ),
        appliedAtMs: processedAtMs,
        recoveredAtMs: processedAtMs,
      };
      let recoveredDelivery = (0, deliveryState_js_1.writeDelivery)({
        ...(0, deliveryPolicy_js_1.omitRetryState)(
          (0, deliveryState_js_1.omitKeys)(baseDelivery, [
            "leaseOwner",
            "leaseExpiresAtMs",
            "sendInFlight",
            "lastError",
            "uncertainAtMs",
            "uncertainReason",
            "deadLetterAtMs",
            "apiGateOwner",
            "apiGateGeneration",
            "apiGateStartedAtMs",
            "appliedStateUnknown",
          ]),
        ),
        status: "pending",
        revision: latestRevision,
        attempts: 0,
        ...(markerApiGateOwner
          ? { apiGateReleaseOwner: markerApiGateOwner }
          : {}),
      });
      const previousApplied = asObject(record.applied);
      const previousChatId =
        (0, deliveryState_js_1.normalizeString)(previousApplied.chatId) ||
        recoveredApplied.chatId;
      if (
        typeof previousApplied.messageId === "number" &&
        Number.isInteger(previousApplied.messageId) &&
        previousApplied.messageId > 0 &&
        (previousApplied.messageId !== recoveredApplied.messageId ||
          previousChatId !== recoveredApplied.chatId)
      ) {
        const pendingDelete = (0, deliveryState_js_1.writeCleanup)({
          chatId: previousChatId,
          messageId: previousApplied.messageId,
          instanceKey: (0, deliveryState_js_1.normalizeString)(
            previousApplied.instanceKey,
          ),
          pendingDeleteId: (0, deliveryState_js_1.buildPendingDeleteId)({
            chatId: previousChatId,
            messageId: previousApplied.messageId,
          }),
          status: "pending",
          attempts: 0,
        });
        recoveredDelivery = (0, deliveryState_js_1.appendPendingDelete)(
          recoveredDelivery,
          pendingDelete,
        );
      }
      nextRecord = {
        ...record,
        applied: recoveredApplied,
        delivery: recoveredDelivery,
        manualRecoveryResult: {
          ...recoveryResult,
          status: "accepted",
          messageId: Number(request.messageId),
        },
      };
    } else if (action === "abandon" && recoverable) {
      nextRecord = {
        ...record,
        delivery: (0, deliveryState_js_1.writeDelivery)({
          ...(0, deliveryPolicy_js_1.omitRetryState)(
            (0, deliveryState_js_1.omitKeys)(baseDelivery, [
              "leaseOwner",
              "leaseExpiresAtMs",
              "sendInFlight",
              "uncertainAtMs",
              "uncertainReason",
            ]),
          ),
          status: "terminal",
          revision:
            latestRevision ||
            (0, deliveryState_js_1.normalizeString)(delivery.revision),
          deadLetterAtMs: processedAtMs,
          ...(markerAttemptId
            ? {
                abandonedSend: (0, records_js_2.sendEvidenceDocument)({
                  ...marker,
                  abandonedAtMs: processedAtMs,
                }),
              }
            : {}),
          lastError: {
            code: "manually-abandoned",
            atMs: processedAtMs,
          },
          ...(markerApiGateOwner
            ? { apiGateReleaseOwner: markerApiGateOwner }
            : {}),
        }),
        manualRecoveryResult: {
          ...recoveryResult,
          status: "accepted",
        },
      };
    } else {
      nextRecord = {
        ...record,
        delivery: baseDelivery,
        manualRecoveryResult: {
          ...recoveryResult,
          status: "rejected",
          code:
            markerAttemptId && delivery.status !== "uncertain"
              ? "recovery-not-uncertain"
              : markerAttemptId
                ? "invalid-manual-recovery"
                : "missing-send-in-flight",
        },
      };
    }
    return { value: nextRecord, decision: "manual-recovery-processed" };
  };
  const output = apply(asObject(current));
  return output;
}
function settleManualGateReleaseRecord(current, input) {
  const { owner } = input;
  const apply = (record) => {
    const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
    if (
      (0, deliveryState_js_1.normalizeString)(delivery.apiGateReleaseOwner) !==
      owner
    ) {
      return { commit: false, decision: "manual-gate-release-settled" };
    }
    return {
      value: {
        ...record,
        delivery: (0, deliveryState_js_1.omitKeys)(delivery, [
          "apiGateReleaseOwner",
        ]),
      },
      decision: "manual-gate-release-settled",
    };
  };
  const output = apply(asObject(current));
  return output;
}
function applyCleanupRetryProofRecord(current, input) {
  const {
    normalizedPendingDeleteId,
    now,
    proofRetryState,
    application,
    markApplied,
  } = input;
  const { apiGateReclaimOwner, retryProofLeaseOwner } = asObject(application);
  const apply = (record) => {
    const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
    const pendingDelete = (0, deliveryState_js_1.readPendingDelete)(
      delivery.pendingDelete,
    );
    if (
      (0, deliveryState_js_1.resolvePendingDeleteId)(pendingDelete) !==
        normalizedPendingDeleteId ||
      pendingDelete.status !== "processing" ||
      !(0, deliveryState_js_1.normalizeString)(retryProofLeaseOwner) ||
      (0, deliveryState_js_1.normalizeString)(pendingDelete.leaseOwner) !==
        (0, deliveryState_js_1.normalizeString)(retryProofLeaseOwner) ||
      proofRetryState.retrySequence <=
        (0, deliveryPolicy_js_1.normalizeRetrySequence)(
          pendingDelete.retrySequence,
        )
    ) {
      return {
        commit: false,
        decision: "stale-pending-delete-retry-window-proof",
      };
    }
    markApplied();
    const preservesApiGate =
      (0, deliveryState_js_1.normalizeString)(apiGateReclaimOwner) !== "" &&
      (0, deliveryState_js_1.normalizeString)(pendingDelete.apiGateOwner) ===
        (0, deliveryState_js_1.normalizeString)(apiGateReclaimOwner);
    return {
      value: {
        ...record,
        delivery: {
          ...(0, deliveryState_js_1.deliveryDocument)(delivery),
          pendingDelete: (0, deliveryState_js_1.writeCleanup)({
            ...(0, deliveryState_js_1.omitKeys)(pendingDelete, [
              "leaseOwner",
              "leaseExpiresAtMs",
              "lastError",
              ...(preservesApiGate
                ? []
                : [
                    "apiGateOwner",
                    "apiGateGeneration",
                    "apiGateStartedAtMs",
                    "apiGateProofRequired",
                  ]),
            ]),
            pendingDeleteId: normalizedPendingDeleteId,
            status: "retryable",
            ...proofRetryState,
            retryWindowRecoveredAtMs: now(),
          }),
        },
      },
      decision: "pending-delete-retry-window-proof-applied",
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
function observeManualRecoveryResult(result) {
  const recoveryResult = asObject(
    (0, records_js_1.messageRecoveryResultDocument)(result.value),
  );
  const processed =
    result.committed &&
    (0, deliveryState_js_1.normalizeString)(recoveryResult.requestId) !== "";
  const action = (0, deliveryState_js_1.normalizeString)(recoveryResult.action);
  const apiGateReleaseOwner = (0, deliveryState_js_1.normalizeString)(
    (0, values_js_1.readProperty)(
      (0, records_js_1.messageDeliveryDocument)(result.value),
      "apiGateReleaseOwner",
    ),
  );
  return {
    processed,
    action,
    apiGateReleaseOwner,
    shouldContinue: !(
      processed &&
      recoveryResult.status === "accepted" &&
      action === "abandon"
    ),
  };
}
