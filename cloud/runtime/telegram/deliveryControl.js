// Generated from src/telegram/deliveryControl.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTelegramDeliveryControl = createTelegramDeliveryControl;
const retryRecords_js_1 = require("./retryRecords.js");
const records_js_1 = require("./records.js");
const deliveryControlRecords_js_1 = require("./deliveryControlRecords.js");
const records_js_2 = require("./records.js");
const deliveryRetryCoordinator_js_1 = require("./deliveryRetryCoordinator.js");
const deliveryState_js_1 = require("./deliveryState.js");
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
      const record = (0, records_js_2.messageDocument)(current);
      return updater(record);
    });
  const scheduleExactRetry = async (input) =>
    scheduleRetry((0, retryRecords_js_1.buildTelegramRetrySchedule)(input));
  const retryCoordinator = (0,
  deliveryRetryCoordinator_js_1.createTelegramRetryCoordinator)({
    now,
    scheduleExactRetry,
    releaseApiGate: (owner) => repository.releaseApiGate(owner),
    extendRetryBarrierAndReleaseApiGate: (proof) =>
      repository.extendRetryBarrierAndReleaseApiGate(proof),
    localRetryBarrier,
  });
  const applyRateLimitBarrierProof = async (input) => {
    const { owner, retryNotBeforeMs } = (0,
    retryRecords_js_1.readBarrierProofInput)(input);
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
    await transact(messageKey, (record) =>
      (0, deliveryControlRecords_js_1.clearRateLimitProofRecord)(
        (0, records_js_2.messageDocument)(record),
        { owner },
      ),
    );
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
      const delivery = (0, deliveryState_js_1.readDelivery)(
        (0, records_js_1.messageDeliveryDocument)(record),
      );
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
      await updateOwned(messageKey, ownerToken, (record, delivery) =>
        (0, deliveryControlRecords_js_1.prepareDesiredGateRecord)(
          (0, records_js_2.messageDocument)(record),
          delivery,
          {
            generation,
            messageKey,
            preparedAtMs,
            revision,
          },
        ),
      ),
      "api-gate-identity-not-persisted",
    );
    const delivery = (0, deliveryState_js_1.readDelivery)(
      (0, records_js_1.messageDeliveryDocument)(prepared.value),
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
    const result = await transact(messageKey, (record) =>
      (0, deliveryControlRecords_js_1.settleApiGateRecord)(
        (0, records_js_2.messageDocument)(record),
        { field, settleOwner },
      ),
    );
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
