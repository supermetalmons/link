// Generated from src/telegram/deliveryRecovery.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTelegramDeliveryRecovery = createTelegramDeliveryRecovery;
const deliveryRecoveryRecords_js_1 = require("./deliveryRecoveryRecords.js");
const retryRecords_js_1 = require("./retryRecords.js");
const deliveryRecoveryRecords_js_2 = require("./deliveryRecoveryRecords.js");
const records_js_1 = require("./records.js");
const deliveryState_js_1 = require("./deliveryState.js");
function createTelegramDeliveryRecovery({ repository, now, control }) {
  const {
    transact,
    scheduleExactRetry,
    applyRateLimitBarrierProof,
    clearAppliedRateLimitProofMarker,
  } = control;
  const applySafeRetryProof = async (messageKey, input) => {
    const application = (0, retryRecords_js_1.captureSafeRetryProof)(input);
    const { normalizedAttemptId, normalizedRevision } = (0,
    retryRecords_js_1.safeRetryProofIdentity)(application);
    if (!normalizedAttemptId || !normalizedRevision) return { applied: false };
    let applied = false;
    const result = await transact(messageKey, (record) =>
      (0, deliveryRecoveryRecords_js_2.applySafeRetryProofRecord)(
        (0, records_js_1.messageDocument)(record),
        {
          normalizedAttemptId,
          normalizedRevision,
          now,
          application,
          markApplied: () => {
            applied = true;
          },
        },
      ),
    );
    return { applied: applied && result.committed };
  };
  const applyDesiredRetryWindowProof = async (messageKey, input) => {
    const application = (0, retryRecords_js_1.captureDesiredWindowProof)(input);
    const state = (0, retryRecords_js_1.desiredWindowProofState)(application);
    if (!state) return { applied: false };
    const { normalizedRevision, proofRetryState } = state;
    let applied = false;
    const result = await transact(messageKey, (record) =>
      (0, deliveryRecoveryRecords_js_2.applyDesiredRetryProofRecord)(
        (0, records_js_1.messageDocument)(record),
        {
          normalizedRevision,
          now,
          proofRetryState,
          application,
          markApplied: () => {
            applied = true;
          },
        },
      ),
    );
    return { applied: applied && result.committed };
  };
  const applyManualRecovery = async (messageKey) => {
    const processedAtMs = now();
    const result = await transact(messageKey, (record) =>
      (0, deliveryRecoveryRecords_js_2.applyManualRecoveryRecord)(
        (0, records_js_1.messageDocument)(record),
        { processedAtMs },
      ),
    );
    return (0, deliveryRecoveryRecords_js_1.observeManualRecoveryResult)(
      result,
    );
  };
  const settleManualApiGateRelease = async (messageKey, ownerInput) => {
    const owner = (0, deliveryState_js_1.normalizeString)(ownerInput);
    if (!owner) {
      return;
    }
    await repository.releaseApiGate(owner);
    (0, deliveryState_js_1.ensureCommitted)(
      await transact(messageKey, (record) =>
        (0, deliveryRecoveryRecords_js_2.settleManualGateReleaseRecord)(
          (0, records_js_1.messageDocument)(record),
          { owner },
        ),
      ),
      "manual-gate-release-finalization-failed",
    );
  };
  const applyPendingDeleteRetryWindowProof = async (messageKey, input) => {
    const application = (0, retryRecords_js_1.captureCleanupWindowProof)(input);
    const state = (0, retryRecords_js_1.cleanupWindowProofState)(application);
    if (!state) return { applied: false };
    const { normalizedPendingDeleteId, proofRetryState } = state;
    let applied = false;
    const result = await transact(messageKey, (record) =>
      (0, deliveryRecoveryRecords_js_2.applyCleanupRetryProofRecord)(
        (0, records_js_1.messageDocument)(record),
        {
          normalizedPendingDeleteId,
          now,
          proofRetryState,
          application,
          markApplied: () => {
            applied = true;
          },
        },
      ),
    );
    return { applied: applied && result.committed };
  };
  const resumeRateLimitProof = async ({
    messageKey,
    proof,
    requestedRevision,
    nowMs,
    target,
  }) => {
    const proofRetryState = (0, retryRecords_js_1.readRateLimitRetryState)(
      proof,
    );
    await scheduleExactRetry(
      (0, retryRecords_js_1.resumedRateLimitRetryInput)(proof, {
        messageKey,
        requestedRevision,
        nowMs,
        target,
        retryState: proofRetryState,
      }),
    );
    let barrierProof = { applied: false };
    try {
      barrierProof = await applyRateLimitBarrierProof(
        (0, retryRecords_js_1.rateLimitBarrierInput)(proof),
      );
    } catch (_error) {
      barrierProof = { applied: false };
    }
    if (!barrierProof.applied) return;
    if (target.kind === "desired") {
      await applySafeRetryProof(
        messageKey,
        (0, retryRecords_js_1.desiredSafeProofInput)(proof, proofRetryState),
      );
      await applyDesiredRetryWindowProof(
        messageKey,
        (0, retryRecords_js_1.desiredWindowProofInput)(proof, proofRetryState),
      );
    } else {
      await applyPendingDeleteRetryWindowProof(
        messageKey,
        (0, retryRecords_js_1.cleanupWindowProofInput)(
          proof,
          proofRetryState,
          target,
        ),
      );
    }
    await clearAppliedRateLimitProofMarker(
      messageKey,
      (0, retryRecords_js_1.rateLimitProofOwner)(proof),
    );
  };
  return {
    applySafeRetryProof,
    applyDesiredRetryWindowProof,
    applyManualRecovery,
    settleManualApiGateRelease,
    applyPendingDeleteRetryWindowProof,
    resumeRateLimitProof,
  };
}
