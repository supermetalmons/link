// Generated from src/telegram/deliveryRecovery.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTelegramDeliveryRecovery = createTelegramDeliveryRecovery;
const deliveryPolicy_js_1 = require("./deliveryPolicy.js");
const deliveryState_js_1 = require("./deliveryState.js");
const values_js_1 = require("./values.js");
function createTelegramDeliveryRecovery({ repository, now, control }) {
  const { transact } = control;
  const applySafeRetryProof = async (
    messageKey,
    {
      requestedRevision,
      safeRejectedAttemptId,
      retryStartedAtMs,
      retryDeadlineAtMs,
      retryAtMs,
      retrySequence,
    },
  ) => {
    const normalizedAttemptId = (0, deliveryState_js_1.normalizeString)(
      safeRejectedAttemptId,
    );
    const normalizedRevision = (0, deliveryState_js_1.normalizeString)(
      requestedRevision,
    );
    if (!normalizedAttemptId || !normalizedRevision) {
      return { applied: false };
    }
    let applied = false;
    const result = await transact(messageKey, (record) => {
      const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
      const marker = (0, deliveryState_js_1.asObject)(delivery.sendInFlight);
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
      applied = true;
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
    });
    return { applied: applied && result.committed };
  };
  const applyDesiredRetryWindowProof = async (
    messageKey,
    {
      requestedRevision,
      safeRejectedAttemptId,
      retryStartedAtMs,
      retryDeadlineAtMs,
      retryAtMs,
      retrySequence,
      retryProofLeaseOwner,
      apiGateReclaimOwner,
    },
  ) => {
    if ((0, deliveryState_js_1.normalizeString)(safeRejectedAttemptId)) {
      return { applied: false };
    }
    const normalizedRevision = (0, deliveryState_js_1.normalizeString)(
      requestedRevision,
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
    if (
      !normalizedRevision ||
      !proofRetryState.retryStartedAtMs ||
      !proofRetryState.retryDeadlineAtMs ||
      !proofRetryState.retryAtMs
    ) {
      return { applied: false };
    }
    let applied = false;
    const result = await transact(messageKey, (record) => {
      const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
      if (
        (0, deliveryState_js_1.normalizeString)(
          (0, values_js_1.readProperty)(record.desired, "revision"),
        ) !== normalizedRevision ||
        !delivery.matchesRevision(normalizedRevision) ||
        delivery.status !== "processing" ||
        delivery.sendInFlight ||
        !(0, deliveryState_js_1.normalizeString)(retryProofLeaseOwner) ||
        (0, deliveryState_js_1.normalizeString)(delivery.leaseOwner) !==
          (0, deliveryState_js_1.normalizeString)(retryProofLeaseOwner) ||
        proofRetryState.retrySequence <=
          (0, deliveryPolicy_js_1.normalizeRetrySequence)(
            delivery.retrySequence,
          )
      ) {
        return { commit: false, decision: "stale-retry-window-proof" };
      }
      applied = true;
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
    });
    return { applied: applied && result.committed };
  };
  const applyManualRecovery = async (messageKey) => {
    const processedAtMs = now();
    const result = await transact(messageKey, (record) => {
      const request = (0, deliveryState_js_1.asObject)(record.manualRecovery);
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
      const marker = (0, deliveryState_js_1.asObject)(delivery.sendInFlight);
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
        ...delivery.source,
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
        const previousApplied = (0, deliveryState_js_1.asObject)(
          record.applied,
        );
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
                  abandonedSend: {
                    ...marker,
                    abandonedAtMs: processedAtMs,
                  },
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
    });
    const recoveryResult = (0, deliveryState_js_1.asObject)(
      result.value?.manualRecoveryResult,
    );
    const processed =
      result.committed &&
      (0, deliveryState_js_1.normalizeString)(recoveryResult.requestId) !== "";
    const action = (0, deliveryState_js_1.normalizeString)(
      recoveryResult.action,
    );
    const apiGateReleaseOwner = (0, deliveryState_js_1.normalizeString)(
      (0, values_js_1.readProperty)(
        result.value?.delivery,
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
  };
  const settleManualApiGateRelease = async (messageKey, ownerInput) => {
    const owner = (0, deliveryState_js_1.normalizeString)(ownerInput);
    if (!owner) {
      return;
    }
    await repository.releaseApiGate(owner);
    (0, deliveryState_js_1.ensureCommitted)(
      await transact(messageKey, (record) => {
        const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
        if (
          (0, deliveryState_js_1.normalizeString)(
            delivery.apiGateReleaseOwner,
          ) !== owner
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
      }),
      "manual-gate-release-finalization-failed",
    );
  };
  const applyPendingDeleteRetryWindowProof = async (
    messageKey,
    {
      pendingDeleteId,
      retryStartedAtMs,
      retryDeadlineAtMs,
      retryAtMs,
      retrySequence,
      retryProofLeaseOwner,
      apiGateReclaimOwner,
    },
  ) => {
    const normalizedPendingDeleteId = (0, deliveryState_js_1.normalizeString)(
      pendingDeleteId,
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
    if (
      !normalizedPendingDeleteId ||
      !proofRetryState.retryStartedAtMs ||
      !proofRetryState.retryDeadlineAtMs ||
      !proofRetryState.retryAtMs
    ) {
      return { applied: false };
    }
    let applied = false;
    const result = await transact(messageKey, (record) => {
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
      applied = true;
      const preservesApiGate =
        (0, deliveryState_js_1.normalizeString)(apiGateReclaimOwner) !== "" &&
        (0, deliveryState_js_1.normalizeString)(pendingDelete.apiGateOwner) ===
          (0, deliveryState_js_1.normalizeString)(apiGateReclaimOwner);
      return {
        value: {
          ...record,
          delivery: {
            ...delivery.source,
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
    });
    return { applied: applied && result.committed };
  };
  return {
    applySafeRetryProof,
    applyDesiredRetryWindowProof,
    applyManualRecovery,
    settleManualApiGateRelease,
    applyPendingDeleteRetryWindowProof,
  };
}
