// Generated from src/telegram/deliveryRetryCoordinator.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTelegramRetryCoordinator = void 0;
const deliveryPolicy_js_1 = require("./deliveryPolicy.js");
const taskKinds_js_1 = require("./taskKinds.js");
const createTelegramRetryCoordinator = ({
  now,
  scheduleExactRetry,
  releaseApiGate,
  extendRetryBarrierAndReleaseApiGate,
  localRetryBarrier,
}) => {
  const finish = async ({
    current,
    failure,
    target,
    messageKey,
    revision,
    ownerToken,
    apiGateOwner = "",
    persistBeforeSchedule = false,
    persistProof,
    persistState,
  }) => {
    const finalizedAtMs = now();
    const retryState = (0, deliveryPolicy_js_1.buildSafeRetryState)({
      current,
      result: failure,
      nowMs: finalizedAtMs,
    });
    const rateLimited = failure?.code === "rate-limited";
    const barrierRetryNotBeforeMs = rateLimited
      ? (0, deliveryPolicy_js_1.buildRateLimitBarrierAtMs)({
          result: failure,
          retryState,
          nowMs: finalizedAtMs,
        })
      : 0;
    const context = {
      finalizedAtMs,
      retryState,
      rateLimited,
      barrierRetryNotBeforeMs,
    };
    const hasApiGateOwner =
      typeof apiGateOwner === "string" && apiGateOwner.trim() !== "";
    if (rateLimited) {
      if (!hasApiGateOwner) {
        throw Object.assign(new Error("rate-limit-gate-owner-missing"), {
          code: "rate-limit-gate-owner-missing",
          retryable: true,
        });
      }
      await persistProof(context);
    }
    if (persistBeforeSchedule && !rateLimited) {
      await persistState(context);
    }
    const safeRejectedAttemptId =
      target.kind === "desired" ? target.safeRejectedAttemptId || "" : "";
    await scheduleExactRetry({
      messageKey,
      revision,
      taskKind: rateLimited
        ? taskKinds_js_1.TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND
        : target.kind,
      retryState,
      ...(target.kind === "desired" ? { safeRejectedAttemptId } : {}),
      pendingDeleteId: target.pendingDeleteId || "",
      retryProofLeaseOwner:
        safeRejectedAttemptId || persistBeforeSchedule ? "" : ownerToken,
      proofTaskKind: rateLimited ? target.kind : "",
      barrierProofOwner: rateLimited ? apiGateOwner : "",
      barrierRetryNotBeforeMs,
      scheduleTimeMs: rateLimited ? finalizedAtMs : retryState.retryAtMs,
      apiGateSettleOwner:
        rateLimited || persistBeforeSchedule ? "" : apiGateOwner,
    });
    if (rateLimited) {
      localRetryBarrier.extendRetryNotBeforeMs(barrierRetryNotBeforeMs);
      let barrierApplied = false;
      try {
        const barrierResult = await extendRetryBarrierAndReleaseApiGate({
          owner: apiGateOwner,
          retryNotBeforeMs: barrierRetryNotBeforeMs,
        });
        if (barrierResult.applied) {
          barrierApplied = true;
          localRetryBarrier.extendRetryNotBeforeMs(
            barrierResult.retryNotBeforeMs,
          );
        }
      } catch (_error) {
        barrierApplied = false;
      }
      if (!barrierApplied) {
        return { ...retryState, barrierProofPending: true };
      }
    } else if (!persistBeforeSchedule && hasApiGateOwner) {
      await releaseApiGate(apiGateOwner);
    }
    if (!persistBeforeSchedule || rateLimited) {
      await persistState(context);
    }
    return retryState;
  };
  return { finish };
};
exports.createTelegramRetryCoordinator = createTelegramRetryCoordinator;
