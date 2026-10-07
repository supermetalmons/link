// Generated from src/telegram/deliveryControl.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTelegramDeliveryControl = createTelegramDeliveryControl;
const deliveryPolicy_js_1 = require("./deliveryPolicy.js");
const deliveryRetryCoordinator_js_1 = require("./deliveryRetryCoordinator.js");
const deliveryState_js_1 = require("./deliveryState.js");
const taskKinds_js_1 = require("./taskKinds.js");
const values_js_1 = require("./values.js");
function createTelegramDeliveryControl({
  repository,
  logger,
  now,
  scheduleRetry,
  localRetryBarrier,
}) {
  const logFailure = (messageKey, status, error) => {
    if (typeof logger?.error === "function") {
      logger.error("telegram:delivery:failed", {
        messageKey,
        status,
        code: error?.code || "telegram-error",
        httpStatus: error?.httpStatus || null,
      });
    }
  };
  const transact = (messageKey, updater) =>
    repository.transactMessage(messageKey, (current) => {
      const record = (0, deliveryState_js_1.asObject)(current);
      return updater(record);
    });
  const scheduleExactRetry = async ({
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
      (0, deliveryState_js_1.normalizeString)(taskKind) ||
      taskKinds_js_1.TELEGRAM_DESIRED_TASK_KIND;
    const retrySequence = (0, deliveryPolicy_js_1.normalizeRetrySequence)(
      retryState.retrySequence,
    );
    const generation = [
      normalizedTaskKind,
      retrySequence,
      (0, deliveryPolicy_js_1.normalizeTimestamp)(retryState.retryAtMs),
      safeRejectedAttemptId || pendingDeleteId || revision,
      (0, deliveryState_js_1.normalizeString)(retryProofLeaseOwner),
      (0, deliveryState_js_1.normalizeString)(sourceGeneration),
      (0, deliveryState_js_1.normalizeString)(proofTaskKind),
      (0, deliveryState_js_1.normalizeString)(barrierProofOwner),
      (0, deliveryPolicy_js_1.normalizeTimestamp)(barrierRetryNotBeforeMs),
      (0, deliveryState_js_1.normalizeString)(apiGateReclaimOwner),
      (0, deliveryState_js_1.normalizeString)(apiGateSettleOwner),
    ].join(":");
    return scheduleRetry({
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
    });
  };
  const retryCoordinator = (0,
  deliveryRetryCoordinator_js_1.createTelegramRetryCoordinator)({
    now,
    scheduleExactRetry,
    releaseApiGate: (owner) => repository.releaseApiGate(owner),
    extendRetryBarrierAndReleaseApiGate: (proof) =>
      repository.extendRetryBarrierAndReleaseApiGate(proof),
    localRetryBarrier,
  });
  const applyRateLimitBarrierProof = async ({
    barrierProofOwner,
    barrierRetryNotBeforeMs,
  }) => {
    const owner = (0, deliveryState_js_1.normalizeString)(barrierProofOwner);
    const retryNotBeforeMs = (0, deliveryPolicy_js_1.normalizeTimestamp)(
      barrierRetryNotBeforeMs,
    );
    if (!owner || !retryNotBeforeMs) {
      return { applied: false };
    }
    const result = await repository.extendRetryBarrierAndReleaseApiGate({
      owner,
      retryNotBeforeMs,
    });
    if (result.applied) {
      localRetryBarrier.extendRetryNotBeforeMs(result.retryNotBeforeMs);
    }
    return result;
  };
  const clearAppliedRateLimitProofMarker = async (messageKey, ownerInput) => {
    const owner = (0, deliveryState_js_1.normalizeString)(ownerInput);
    if (!owner) {
      return;
    }
    await transact(messageKey, (record) => {
      const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
      const pendingDelete = (0, deliveryState_js_1.readPendingDelete)(
        delivery.pendingDelete,
      );
      const clearsDesired =
        (0, deliveryState_js_1.normalizeString)(
          (0, values_js_1.readProperty)(delivery.apiGateProofRequired, "owner"),
        ) === owner;
      const clearsPending =
        (0, deliveryState_js_1.normalizeString)(
          (0, values_js_1.readProperty)(
            pendingDelete.apiGateProofRequired,
            "owner",
          ),
        ) === owner;
      if (!clearsDesired && !clearsPending) {
        return { commit: false, decision: "rate-limit-proof-marker-stale" };
      }
      return {
        value: {
          ...record,
          delivery: {
            ...(clearsDesired
              ? (0, deliveryState_js_1.omitKeys)(delivery, [
                  "apiGateProofRequired",
                ])
              : delivery.source),
            ...(clearsPending
              ? {
                  pendingDelete: (0, deliveryState_js_1.omitKeys)(
                    pendingDelete,
                    ["apiGateProofRequired"],
                  ),
                }
              : {}),
          },
        },
        decision: "rate-limit-proof-marker-cleared",
      };
    });
  };
  const acquireApiGate = ({
    messageKey,
    revision,
    operation,
    owner,
    attemptId = "",
    pendingDeleteId = "",
    reclaimOwner = "",
    taskGeneration = "",
  }) =>
    repository.acquireApiGate({
      messageKey,
      revision,
      operation,
      owner,
      acquiredAtMs: now(),
      ...(attemptId ? { attemptId } : {}),
      ...(pendingDeleteId ? { pendingDeleteId } : {}),
      ...(reclaimOwner ? { reclaimOwner } : {}),
      ...(taskGeneration ? { taskGeneration } : {}),
    });
  const buildGateBlockedFailure = (gateResult, checkedAtMs) => ({
    code:
      gateResult.reason === "retry-after"
        ? "global-retry-after"
        : "global-api-gate-held",
    retryAfterSeconds:
      gateResult.retryNotBeforeMs > checkedAtMs
        ? (gateResult.retryNotBeforeMs - checkedAtMs) / 1000
        : null,
  });
  const updateOwned = async (messageKey, ownerToken, updater) =>
    transact(messageKey, (record) => {
      const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
      if (
        (0, deliveryState_js_1.normalizeString)(delivery.leaseOwner) !==
        ownerToken
      ) {
        return { commit: false, decision: "lease-lost" };
      }
      return {
        value: updater(record, delivery),
        decision: "updated",
      };
    });
  const prepareDesiredApiGateIdentity = async ({
    messageKey,
    ownerToken,
    revision,
    requestedGeneration,
  }) => {
    const generation =
      (0, deliveryState_js_1.normalizeString)(requestedGeneration) ||
      `direct:${revision}`;
    const preparedAtMs = now();
    const prepared = (0, deliveryState_js_1.ensureCommitted)(
      await updateOwned(messageKey, ownerToken, (record, delivery) => {
        const existingOwner = (0, deliveryState_js_1.normalizeString)(
          delivery.apiGateOwner,
        );
        return {
          ...record,
          delivery: {
            ...delivery.source,
            apiGateOwner:
              existingOwner ||
              (0, deliveryState_js_1.buildApiGateOwner)(
                messageKey,
                "desired",
                revision,
                generation,
              ),
            apiGateGeneration:
              (0, deliveryState_js_1.normalizeString)(
                delivery.apiGateGeneration,
              ) || generation,
            apiGateStartedAtMs:
              (0, deliveryPolicy_js_1.normalizeTimestamp)(
                delivery.apiGateStartedAtMs,
              ) || preparedAtMs,
          },
        };
      }),
      "api-gate-identity-not-persisted",
    );
    const delivery = (0, deliveryState_js_1.readDelivery)(
      prepared.value?.delivery,
    );
    const owner = (0, deliveryState_js_1.normalizeString)(
      delivery.apiGateOwner,
    );
    const persistedGeneration = (0, deliveryState_js_1.normalizeString)(
      delivery.apiGateGeneration,
    );
    const proofRequiredOwner = (0, deliveryState_js_1.normalizeString)(
      (0, values_js_1.readProperty)(delivery.apiGateProofRequired, "owner"),
    );
    const mayReclaim = owner !== "" && proofRequiredOwner !== owner;
    return {
      owner,
      generation: persistedGeneration,
      reclaimOwner: mayReclaim ? owner : "",
      delivery,
    };
  };
  const settlePersistedApiGate = async ({
    messageKey,
    field,
    owner: ownerInput,
  }) => {
    const settleOwner = (0, deliveryState_js_1.normalizeString)(ownerInput);
    if (!settleOwner) {
      return null;
    }
    await repository.releaseApiGate(settleOwner);
    const result = await transact(messageKey, (record) => {
      const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
      if (delivery.settlementOwner(field) !== settleOwner) {
        return { commit: false, decision: "api-gate-settle-stale" };
      }
      return {
        value: {
          ...record,
          delivery: (0, deliveryState_js_1.omitKeys)(delivery, [field]),
        },
        decision: "api-gate-settled",
      };
    });
    if (!result.committed && result.decision !== "api-gate-settle-stale") {
      (0, deliveryState_js_1.ensureCommitted)(
        result,
        "api-gate-settle-finalization-failed",
      );
    }
    return result;
  };
  return {
    logFailure,
    transact,
    scheduleExactRetry,
    retryCoordinator,
    applyRateLimitBarrierProof,
    clearAppliedRateLimitProofMarker,
    acquireApiGate,
    buildGateBlockedFailure,
    updateOwned,
    prepareDesiredApiGateIdentity,
    settlePersistedApiGate,
  };
}
