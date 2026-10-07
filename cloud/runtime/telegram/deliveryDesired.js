// Generated from src/telegram/deliveryDesired.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTelegramDesiredDelivery = createTelegramDesiredDelivery;
const deliveryPolicy_js_1 = require("./deliveryPolicy.js");
const deliverySend_js_1 = require("./deliverySend.js");
const deliveryState_js_1 = require("./deliveryState.js");
const desiredStateCore_js_1 = require("./desiredStateCore.js");
const taskKinds_js_1 = require("./taskKinds.js");
const values_js_1 = require("./values.js");
function createTelegramDesiredDelivery({
  repository,
  client,
  resolveDestination,
  now,
  createOwnerToken,
  createAttemptId,
  logger,
  leaseTtlMs,
  localRetryBarrier,
  control,
  recovery,
}) {
  const {
    transact,
    updateOwned,
    retryCoordinator,
    prepareDesiredApiGateIdentity,
    settlePersistedApiGate,
    acquireApiGate,
    buildGateBlockedFailure,
    logFailure,
    scheduleExactRetry,
    applyRateLimitBarrierProof,
    clearAppliedRateLimitProofMarker,
  } = control;
  const {
    applySafeRetryProof,
    applyDesiredRetryWindowProof,
    applyManualRecovery,
    settleManualApiGateRelease,
    applyPendingDeleteRetryWindowProof,
  } = recovery;
  const acquire = async (messageKey, ownerToken, nowMs) => {
    let acquireDecision = "missing";
    const result = await transact(messageKey, (record) => {
      const desired = (0, deliveryState_js_1.asObject)(record.desired);
      const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
      const desiredRevision = (0, deliveryState_js_1.normalizeString)(
        desired.revision,
      );
      const leaseExpiresAtMs = Number(delivery.leaseExpiresAtMs) || 0;
      if (
        (0, deliveryState_js_1.normalizeString)(delivery.apiGateSettleOwner)
      ) {
        acquireDecision = "desired-api-gate-settle-pending";
        return { commit: false, decision: acquireDecision };
      }
      if (
        (0, deliveryState_js_1.normalizeString)(
          delivery.pendingDeleteApiGateSettleOwner,
        )
      ) {
        acquireDecision = "pending-api-gate-settle-pending";
        return { commit: false, decision: acquireDecision };
      }
      if (
        delivery.status === "processing" &&
        (0, deliveryState_js_1.normalizeString)(delivery.leaseOwner) !==
          ownerToken &&
        leaseExpiresAtMs > nowMs
      ) {
        acquireDecision = "locked";
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
      if (
        currentApiGateOwner &&
        currentApiGateOwner === currentProofGateOwner
      ) {
        acquireDecision = "rate-limit-proof-pending";
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
      if (
        pendingApiGateOwner &&
        pendingApiGateOwner === pendingProofGateOwner
      ) {
        acquireDecision = "pending-rate-limit-proof-pending";
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
        return {
          value: {
            ...record,
            delivery: {
              ...delivery.source,
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
      if (delivery.sendInFlight) {
        const sendInFlight = (0, deliveryState_js_1.asObject)(
          delivery.sendInFlight,
        );
        const sendApiGateOwner = (0, deliveryState_js_1.normalizeString)(
          sendInFlight.apiGateOwner,
        );
        const revision =
          desiredRevision ||
          (0, deliveryState_js_1.normalizeString)(delivery.revision) ||
          "invalid";
        acquireDecision = "in-flight-uncertain";
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
                ...delivery.source,
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
                    ? [
                        "apiGateOwner",
                        "apiGateGeneration",
                        "apiGateStartedAtMs",
                      ]
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
                    ? [
                        "apiGateOwner",
                        "apiGateGeneration",
                        "apiGateStartedAtMs",
                      ]
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
        return { commit: false, decision: acquireDecision };
      }
      if (
        delivery.revision === revision &&
        (delivery.status === "terminal" ||
          delivery.status === "uncertain" ||
          delivery.status === "delivered")
      ) {
        acquireDecision = "settled";
        return { commit: false, decision: acquireDecision };
      }
      const deliveryForAcquire = delivery;
      acquireDecision = "acquired";
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
    });
    return { ...result, decision: acquireDecision };
  };
  const finishStatus = async ({
    messageKey,
    ownerToken,
    desired,
    status,
    nowMs,
    result,
    receipt,
    clearAppliedStateUnknown = false,
    apiGateSettleOwner = "",
  }) =>
    (0, deliveryState_js_1.ensureCommitted)(
      await updateOwned(messageKey, ownerToken, (record, delivery) => {
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
                sendInFlight: (0, deliveryState_js_1.preserveSendEvidence)(
                  delivery.sendInFlight,
                  Object.hasOwn(delivery.source, "sendInFlight"),
                ),
              }
            : !desiredStillLatest
              ? { status: "pending", revision }
              : status === "delivered"
                ? { status, revision, deliveredAtMs: nowMs }
                : { status, revision };
        const nextDelivery = (0, deliveryState_js_1.writeDelivery)({
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
            ? { apiGateSettleOwner }
            : {}),
        });
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
      }),
      `${status}-finalization-failed`,
    );
  const finishStatusAndSettleApiGate = async (input) => {
    const owner = (0, deliveryState_js_1.normalizeString)(
      input.apiGateSettleOwner,
    );
    const finalized = await finishStatus(input);
    if (owner) {
      await settlePersistedApiGate({
        messageKey: input.messageKey,
        field: "apiGateSettleOwner",
        owner,
      });
    }
    return finalized;
  };
  const finishRetryable = async ({
    messageKey,
    ownerToken,
    desired,
    result,
    safeRejectedAttemptId = "",
    currentDelivery,
    apiGateOwner = "",
    proofTaskKind = taskKinds_js_1.TELEGRAM_DESIRED_TASK_KIND,
    pendingDeleteId = "",
    preserveApiGateIdentity = false,
    persistBeforeSchedule = false,
  }) => {
    return retryCoordinator.finish({
      current: (0, deliveryState_js_1.asObject)(currentDelivery),
      failure: result,
      target: { kind: proofTaskKind, safeRejectedAttemptId, pendingDeleteId },
      messageKey,
      revision: desired.revision,
      ownerToken,
      apiGateOwner,
      persistBeforeSchedule,
      persistProof: async ({ retryState, barrierRetryNotBeforeMs }) => {
        (0, deliveryState_js_1.ensureCommitted)(
          await updateOwned(messageKey, ownerToken, (record, delivery) => ({
            ...record,
            delivery: {
              ...delivery.source,
              apiGateProofRequired: {
                owner: apiGateOwner,
                retryNotBeforeMs: barrierRetryNotBeforeMs,
                revision: desired.revision,
                proofTaskKind,
                ...retryState,
                ...(safeRejectedAttemptId ? { safeRejectedAttemptId } : {}),
                ...(pendingDeleteId ? { pendingDeleteId } : {}),
                ...(!safeRejectedAttemptId
                  ? { retryProofLeaseOwner: ownerToken }
                  : {}),
              },
            },
          })),
          "rate-limit-proof-marker-failed",
        );
      },
      persistState: async ({ finalizedAtMs, retryState, rateLimited }) => {
        const finalization = await updateOwned(
          messageKey,
          ownerToken,
          (record, delivery) => {
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
          },
        );
        if (!finalization.committed) {
          const current = (0, deliveryState_js_1.asObject)(
            await repository.getMessage(messageKey),
          );
          const currentDeliveryState = (0, deliveryState_js_1.readDelivery)(
            current.delivery,
          );
          const proofAlreadyApplied =
            rateLimited &&
            (0, deliveryPolicy_js_1.normalizeRetrySequence)(
              currentDeliveryState.retrySequence,
            ) >= retryState.retrySequence &&
            (0, deliveryState_js_1.normalizeString)(
              (0, values_js_1.readProperty)(
                currentDeliveryState.apiGateProofRequired,
                "owner",
              ),
            ) !== (0, deliveryState_js_1.normalizeString)(apiGateOwner);
          if (!proofAlreadyApplied) {
            (0, deliveryState_js_1.ensureCommitted)(
              finalization,
              "retryable-finalization-failed",
            );
          }
        }
      },
    });
  };
  const finishExpiredOwnedRetryWindow = async ({
    messageKey,
    ownerToken,
    desired,
    currentDelivery,
  }) => {
    const deadlineAtMs = (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(
      currentDelivery,
    );
    const checkedAtMs = now();
    if (!deadlineAtMs || checkedAtMs < deadlineAtMs) {
      return null;
    }
    const result = { code: "safe-retry-window-exhausted" };
    const current = (0, deliveryState_js_1.asObject)(currentDelivery);
    const apiGateOwner = (0, deliveryState_js_1.normalizeString)(
      current.apiGateOwner,
    );
    const proofGateOwner = (0, deliveryState_js_1.normalizeString)(
      (0, values_js_1.readProperty)(current.apiGateProofRequired, "owner"),
    );
    await finishStatusAndSettleApiGate({
      messageKey,
      ownerToken,
      desired,
      status: "terminal",
      result,
      nowMs: checkedAtMs,
      apiGateSettleOwner:
        apiGateOwner && apiGateOwner !== proofGateOwner ? apiGateOwner : "",
    });
    return { status: "terminal", reason: result.code };
  };
  const markAppliedStateUnknown = async ({
    messageKey,
    ownerToken,
    desired,
    operation,
    apiGateOwner,
  }) => {
    const markedAtMs = now();
    return (0, deliveryState_js_1.ensureCommitted)(
      await updateOwned(messageKey, ownerToken, (record, delivery) => ({
        ...record,
        delivery: {
          ...delivery.source,
          appliedStateUnknown: {
            revision: desired.revision,
            operation,
            apiGateOwner,
            markedAtMs,
          },
        },
      })),
      "applied-state-unknown-not-persisted",
    );
  };
  const markDelivered = (
    messageKey,
    ownerToken,
    desired,
    nowMs,
    options = {},
  ) =>
    finishStatus({
      messageKey,
      ownerToken,
      desired,
      status: "delivered",
      receipt: { kind: "preserve" },
      nowMs,
      ...options,
    });
  const runDelete = async ({
    messageKey,
    ownerToken,
    desired,
    chatId,
    messageId,
    nowMs,
    currentDelivery,
    requestedGeneration,
    apiGateReclaimOwner,
  }) => {
    const expired = await finishExpiredOwnedRetryWindow({
      messageKey,
      ownerToken,
      desired,
      currentDelivery,
    });
    if (expired) {
      return expired;
    }
    const gateIdentity = await prepareDesiredApiGateIdentity({
      messageKey,
      ownerToken,
      revision: desired.revision,
      requestedGeneration,
      apiGateReclaimOwner,
    });
    const apiGateOwner = gateIdentity.owner;
    const gateResult = await acquireApiGate({
      messageKey,
      revision: desired.revision,
      operation: "delete",
      owner: apiGateOwner,
      reclaimOwner: gateIdentity.reclaimOwner,
      taskGeneration: gateIdentity.generation,
    });
    if (!gateResult.acquired) {
      const checkedAtMs = now();
      const retryState = await finishRetryable({
        messageKey,
        ownerToken,
        desired,
        result: buildGateBlockedFailure(gateResult, checkedAtMs),
        currentDelivery: gateIdentity.delivery,
        preserveApiGateIdentity: true,
        persistBeforeSchedule: true,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    const callAtMs = now();
    if (
      (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(gateIdentity.delivery) >
        0 &&
      (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(
        gateIdentity.delivery,
      ) <= callAtMs
    ) {
      const result = { code: "safe-retry-window-exhausted" };
      await finishStatusAndSettleApiGate({
        messageKey,
        ownerToken,
        desired,
        status: "terminal",
        result,
        nowMs: callAtMs,
        apiGateSettleOwner: apiGateOwner,
      });
      return { status: "terminal", reason: result.code };
    }
    await markAppliedStateUnknown({
      messageKey,
      ownerToken,
      desired,
      operation: "delete",
      apiGateOwner,
    });
    const result = await client.deleteTelegramMessage({ chatId, messageId });
    if (result.ok) {
      await finishStatusAndSettleApiGate({
        messageKey,
        ownerToken,
        desired,
        status: "delivered",
        nowMs,
        receipt: { kind: "clear" },
        clearAppliedStateUnknown: true,
        apiGateSettleOwner: apiGateOwner,
      });
      return { status: "delivered" };
    }
    if (result.classification === "retryable") {
      const retryState = await finishRetryable({
        messageKey,
        ownerToken,
        desired,
        result,
        currentDelivery: gateIdentity.delivery,
        apiGateOwner,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    await finishStatusAndSettleApiGate({
      messageKey,
      ownerToken,
      desired,
      status: "terminal",
      result,
      nowMs,
      apiGateSettleOwner: apiGateOwner,
    });
    logFailure(messageKey, "terminal", result);
    return { status: "terminal", reason: result.code };
  };
  const { runSend } = (0, deliverySend_js_1.createTelegramSendDelivery)({
    client,
    now,
    createAttemptId,
    control,
    operations: {
      finishExpiredOwnedRetryWindow,
      finishRetryable,
      finishStatusAndSettleApiGate,
    },
  });
  const reconcileDesired = async (
    {
      messageKey,
      requestedRevision = "",
      safeRejectedAttemptId = "",
      retryStartedAtMs = 0,
      retryDeadlineAtMs = 0,
      retryAtMs = 0,
      retrySequence = 0,
      retryProofLeaseOwner = "",
      requestedGeneration = "",
      taskKind = taskKinds_js_1.TELEGRAM_DESIRED_TASK_KIND,
      apiGateReclaimOwner = "",
      apiGateSettleOwner = "",
    } = { messageKey: "" },
  ) => {
    const normalizedMessageKey = (0,
    desiredStateCore_js_1.validateTelegramMessageKey)(messageKey);
    const nowMs = now();
    if ((0, deliveryState_js_1.normalizeString)(apiGateSettleOwner)) {
      await repository.releaseApiGate(apiGateSettleOwner);
    }
    await applySafeRetryProof(normalizedMessageKey, {
      requestedRevision,
      safeRejectedAttemptId,
      retryStartedAtMs,
      retryDeadlineAtMs,
      retryAtMs,
      retrySequence,
    });
    if (taskKind !== taskKinds_js_1.TELEGRAM_PENDING_DELETE_TASK_KIND) {
      await applyDesiredRetryWindowProof(normalizedMessageKey, {
        requestedRevision,
        safeRejectedAttemptId,
        retryStartedAtMs,
        retryDeadlineAtMs,
        retryAtMs,
        retrySequence,
        retryProofLeaseOwner,
        apiGateReclaimOwner,
      });
    }
    const recovery = await applyManualRecovery(normalizedMessageKey);
    await settleManualApiGateRelease(
      normalizedMessageKey,
      recovery.apiGateReleaseOwner,
    );
    if (recovery.processed && !recovery.shouldContinue) {
      return { status: "terminal", reason: "manually-abandoned" };
    }
    const retryNotBeforeMs = Math.max(
      await repository.getRetryNotBeforeMs(),
      localRetryBarrier.getRetryNotBeforeMs(),
    );
    const ownerToken = createOwnerToken();
    let acquired = await acquire(normalizedMessageKey, ownerToken, nowMs);
    for (let settlementCount = 0; settlementCount < 2; settlementCount += 1) {
      const field =
        acquired.decision === "desired-api-gate-settle-pending"
          ? "apiGateSettleOwner"
          : acquired.decision === "pending-api-gate-settle-pending"
            ? "pendingDeleteApiGateSettleOwner"
            : "";
      if (!field) {
        break;
      }
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field,
        owner: (0, values_js_1.readProperty)(
          (0, values_js_1.readProperty)(acquired.value, "delivery"),
          field,
        ),
      });
      acquired = await acquire(normalizedMessageKey, ownerToken, nowMs);
    }
    if (
      (acquired.decision === "invalid" ||
        acquired.decision === "retry-exhausted") &&
      (0, deliveryState_js_1.normalizeString)(
        (0, values_js_1.readProperty)(
          acquired.value?.delivery,
          "apiGateSettleOwner",
        ),
      )
    ) {
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "apiGateSettleOwner",
        owner: (0, values_js_1.readProperty)(
          (0, values_js_1.readProperty)(acquired.value, "delivery"),
          "apiGateSettleOwner",
        ),
      });
    }
    if (acquired.decision === "invalid") {
      return { status: "terminal", reason: "invalid-desired-state" };
    }
    if (acquired.decision === "in-flight-uncertain") {
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "apiGateSettleOwner",
        owner: (0, values_js_1.readProperty)(
          acquired.value?.delivery,
          "apiGateSettleOwner",
        ),
      });
      return { status: "uncertain", reason: "abandoned-send-in-flight" };
    }
    if (acquired.decision === "pending-rate-limit-proof-pending") {
      const proof = (0, deliveryState_js_1.asObject)(
        (0, values_js_1.readProperty)(
          (0, values_js_1.readProperty)(
            acquired.value?.delivery,
            "pendingDelete",
          ),
          "apiGateProofRequired",
        ),
      );
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
      await scheduleExactRetry({
        messageKey: normalizedMessageKey,
        revision:
          (0, deliveryState_js_1.normalizeString)(proof.revision) ||
          requestedRevision ||
          "latest",
        taskKind: taskKinds_js_1.TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND,
        retryState: proofRetryState,
        pendingDeleteId: (0, deliveryState_js_1.normalizeString)(
          proof.pendingDeleteId,
        ),
        retryProofLeaseOwner: (0, deliveryState_js_1.normalizeString)(
          proof.retryProofLeaseOwner,
        ),
        proofTaskKind: taskKinds_js_1.TELEGRAM_PENDING_DELETE_TASK_KIND,
        barrierProofOwner: proof.owner,
        barrierRetryNotBeforeMs: proof.retryNotBeforeMs,
        scheduleTimeMs: nowMs,
      });
      let barrierProof = { applied: false };
      try {
        barrierProof = await applyRateLimitBarrierProof({
          barrierProofOwner: proof.owner,
          barrierRetryNotBeforeMs: proof.retryNotBeforeMs,
        });
      } catch (_error) {
        barrierProof = { applied: false };
      }
      if (barrierProof.applied) {
        await applyPendingDeleteRetryWindowProof(normalizedMessageKey, {
          pendingDeleteId: proof.pendingDeleteId,
          retryProofLeaseOwner: proof.retryProofLeaseOwner,
          ...proofRetryState,
        });
        await clearAppliedRateLimitProofMarker(
          normalizedMessageKey,
          proof.owner,
        );
      }
      return {
        status: "retryable",
        reason: "pending-rate-limit-proof-pending",
        retryAtMs: (0, deliveryPolicy_js_1.normalizeTimestamp)(
          proof.retryNotBeforeMs,
        ),
        scheduled: true,
      };
    }
    if (acquired.decision === "rate-limit-proof-pending") {
      const proof = (0, deliveryState_js_1.asObject)(
        (0, values_js_1.readProperty)(
          acquired.value?.delivery,
          "apiGateProofRequired",
        ),
      );
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
      await scheduleExactRetry({
        messageKey: normalizedMessageKey,
        revision:
          (0, deliveryState_js_1.normalizeString)(proof.revision) ||
          requestedRevision ||
          "latest",
        taskKind: taskKinds_js_1.TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND,
        retryState: proofRetryState,
        safeRejectedAttemptId: (0, deliveryState_js_1.normalizeString)(
          proof.safeRejectedAttemptId,
        ),
        retryProofLeaseOwner: (0, deliveryState_js_1.normalizeString)(
          proof.retryProofLeaseOwner,
        ),
        proofTaskKind: taskKinds_js_1.TELEGRAM_DESIRED_TASK_KIND,
        barrierProofOwner: proof.owner,
        barrierRetryNotBeforeMs: proof.retryNotBeforeMs,
        scheduleTimeMs: nowMs,
      });
      let barrierProof = { applied: false };
      try {
        barrierProof = await applyRateLimitBarrierProof({
          barrierProofOwner: proof.owner,
          barrierRetryNotBeforeMs: proof.retryNotBeforeMs,
        });
      } catch (_error) {
        barrierProof = { applied: false };
      }
      if (barrierProof.applied) {
        await applySafeRetryProof(normalizedMessageKey, {
          requestedRevision: proof.revision,
          safeRejectedAttemptId: proof.safeRejectedAttemptId,
          ...proofRetryState,
        });
        await applyDesiredRetryWindowProof(normalizedMessageKey, {
          requestedRevision: proof.revision,
          retryProofLeaseOwner: proof.retryProofLeaseOwner,
          ...proofRetryState,
        });
        await clearAppliedRateLimitProofMarker(
          normalizedMessageKey,
          proof.owner,
        );
      }
      return {
        status: "retryable",
        reason: "rate-limit-proof-pending",
        retryAtMs: (0, deliveryPolicy_js_1.normalizeTimestamp)(
          proof.retryNotBeforeMs,
        ),
        scheduled: true,
      };
    }
    if (acquired.decision === "locked") {
      const lockedGateOwner = (0, deliveryState_js_1.normalizeString)(
        (0, values_js_1.readProperty)(acquired.value?.delivery, "apiGateOwner"),
      );
      const lockedGateGeneration = (0, deliveryState_js_1.normalizeString)(
        (0, values_js_1.readProperty)(
          acquired.value?.delivery,
          "apiGateGeneration",
        ),
      );
      const mayReclaimLockedGate =
        lockedGateOwner &&
        ((0, deliveryState_js_1.normalizeString)(apiGateReclaimOwner) ===
          lockedGateOwner ||
          (lockedGateGeneration &&
            lockedGateGeneration ===
              (0, deliveryState_js_1.normalizeString)(requestedGeneration)));
      const lockedRetryAtMs =
        (0, deliveryPolicy_js_1.normalizeTimestamp)(
          (0, values_js_1.readProperty)(
            acquired.value?.delivery,
            "leaseExpiresAtMs",
          ),
        ) || nowMs + 1000;
      await scheduleExactRetry({
        messageKey: normalizedMessageKey,
        revision: requestedRevision || "latest",
        taskKind: taskKinds_js_1.TELEGRAM_DESIRED_TASK_KIND,
        retryState: {
          retryStartedAtMs:
            (0, values_js_1.readProperty)(
              acquired.value?.delivery,
              "retryStartedAtMs",
            ) || retryStartedAtMs,
          retryDeadlineAtMs:
            (0, values_js_1.readProperty)(
              acquired.value?.delivery,
              "retryDeadlineAtMs",
            ) || retryDeadlineAtMs,
          retryAtMs: lockedRetryAtMs,
          retrySequence:
            (0, values_js_1.readProperty)(
              acquired.value?.delivery,
              "retrySequence",
            ) ?? retrySequence,
        },
        sourceGeneration: requestedGeneration,
        apiGateReclaimOwner: mayReclaimLockedGate ? lockedGateOwner : "",
      });
      return {
        status: "retryable",
        reason: "locked",
        retryAtMs: lockedRetryAtMs,
        scheduled: true,
      };
    }
    if (acquired.decision === "deferred") {
      const deferredRetryAtMs =
        Number(
          (0, values_js_1.readProperty)(acquired.value?.delivery, "retryAtMs"),
        ) || null;
      await scheduleExactRetry({
        messageKey: normalizedMessageKey,
        revision:
          (0, deliveryState_js_1.normalizeString)(
            (0, values_js_1.readProperty)(acquired.value?.desired, "revision"),
          ) ||
          requestedRevision ||
          "latest",
        taskKind: taskKinds_js_1.TELEGRAM_DESIRED_TASK_KIND,
        retryState: {
          retryStartedAtMs: (0, values_js_1.readProperty)(
            acquired.value?.delivery,
            "retryStartedAtMs",
          ),
          retryDeadlineAtMs: (0, values_js_1.readProperty)(
            acquired.value?.delivery,
            "retryDeadlineAtMs",
          ),
          retryAtMs: deferredRetryAtMs,
          retrySequence: (0, values_js_1.readProperty)(
            acquired.value?.delivery,
            "retrySequence",
          ),
        },
        sourceGeneration: requestedGeneration,
      });
      return {
        status: "retryable",
        reason: "retry-after",
        retryAtMs: deferredRetryAtMs,
        scheduled: true,
      };
    }
    if (acquired.decision === "retry-exhausted") {
      return {
        status: "terminal",
        reason: "safe-retry-window-exhausted",
      };
    }
    if (acquired.decision === "settled") {
      return { status: "settled" };
    }
    if (acquired.decision !== "acquired") {
      return { status: "skipped", reason: "missing" };
    }
    let record = (0, deliveryState_js_1.asObject)(acquired.value);
    const settledSupersededGate = await settlePersistedApiGate({
      messageKey: normalizedMessageKey,
      field: "apiGateSettleOwner",
      owner: (0, values_js_1.readProperty)(
        record.delivery,
        "apiGateSettleOwner",
      ),
    });
    if (settledSupersededGate) {
      record = (0, deliveryState_js_1.asObject)(settledSupersededGate.value);
    }
    const desired = (0, deliveryState_js_1.asObject)(record.desired);
    const applied = (0, deliveryState_js_1.asObject)(record.applied);
    if (
      requestedRevision &&
      requestedRevision !== desired.revision &&
      typeof logger?.info === "function"
    ) {
      logger.info("telegram:delivery:stale-task", {
        messageKey: normalizedMessageKey,
      });
    }
    const barrierCheckedAtMs = now();
    if (retryNotBeforeMs > barrierCheckedAtMs) {
      const retryState = await finishRetryable({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        result: {
          code: "global-retry-after",
          retryAfterSeconds: Math.max(
            0,
            (retryNotBeforeMs - barrierCheckedAtMs) / 1000,
          ),
        },
        currentDelivery: record.delivery,
        preserveApiGateIdentity: Boolean(
          (0, values_js_1.readProperty)(record.delivery, "apiGateOwner"),
        ),
        persistBeforeSchedule: true,
      });
      return {
        status: "retryable",
        reason: "global-retry-after",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    const chatId = resolveDestination(desired.destination);
    if (!(0, deliveryState_js_1.normalizeString)(chatId)) {
      const result = {
        code: "missing-destination",
        description: `Telegram destination ${desired.destination} is not configured`,
      };
      await finishStatus({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        status: "terminal",
        result,
        nowMs,
      });
      logFailure(normalizedMessageKey, "terminal", result);
      return { status: "terminal", reason: result.code };
    }
    if (desired.operation === "delete") {
      if (
        typeof applied.messageId !== "number" ||
        !Number.isInteger(applied.messageId) ||
        applied.messageId <= 0
      ) {
        await markDelivered(normalizedMessageKey, ownerToken, desired, nowMs, {
          receipt: { kind: "clear" },
        });
        return { status: "delivered" };
      }
      return runDelete({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        chatId:
          (0, deliveryState_js_1.normalizeString)(applied.chatId) || chatId,
        messageId: applied.messageId,
        nowMs,
        currentDelivery: record.delivery,
        requestedGeneration,
        apiGateReclaimOwner,
      });
    }
    if (
      typeof applied.messageId !== "number" ||
      !Number.isInteger(applied.messageId) ||
      applied.messageId <= 0
    ) {
      if (desired.operation === "edit" && desired.ifMissing === "skip") {
        await markDelivered(normalizedMessageKey, ownerToken, desired, nowMs, {
          receipt: { kind: "clear" },
        });
        return { status: "delivered", reason: "missing-skipped" };
      }
      return runSend({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        chatId,
        previousApplied: null,
        nowMs,
        requestedGeneration,
      });
    }
    const appliedTargetMismatch =
      (0, deliveryState_js_1.normalizeString)(applied.instanceKey) !==
        desired.instanceKey ||
      (0, deliveryState_js_1.normalizeString)(applied.destination) !==
        desired.destination ||
      ((0, deliveryState_js_1.normalizeString)(applied.chatId) &&
        (0, deliveryState_js_1.normalizeString)(applied.chatId) !== chatId);
    if (appliedTargetMismatch) {
      if (desired.operation === "edit" && desired.ifMissing === "skip") {
        await markDelivered(normalizedMessageKey, ownerToken, desired, nowMs);
        return { status: "delivered", reason: "missing-skipped" };
      }
      return runSend({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        chatId,
        previousApplied: applied,
        nowMs,
        requestedGeneration,
      });
    }
    if (
      applied.contentHash === desired.contentHash &&
      !(0, values_js_1.readProperty)(record.delivery, "appliedStateUnknown")
    ) {
      await markDelivered(normalizedMessageKey, ownerToken, desired, nowMs, {
        receipt: {
          kind: "set",
          value: {
            ...applied,
            revision: desired.revision,
            appliedAtMs: nowMs,
          },
        },
      });
      return { status: "delivered", reason: "already-current" };
    }
    const expired = await finishExpiredOwnedRetryWindow({
      messageKey: normalizedMessageKey,
      ownerToken,
      desired,
      currentDelivery: record.delivery,
    });
    if (expired) {
      return expired;
    }
    const gateIdentity = await prepareDesiredApiGateIdentity({
      messageKey: normalizedMessageKey,
      ownerToken,
      revision: desired.revision,
      requestedGeneration,
      apiGateReclaimOwner,
    });
    const apiGateOwner = gateIdentity.owner;
    const gateResult = await acquireApiGate({
      messageKey: normalizedMessageKey,
      revision: desired.revision,
      operation: "edit",
      owner: apiGateOwner,
      reclaimOwner: gateIdentity.reclaimOwner,
      taskGeneration: gateIdentity.generation,
    });
    if (!gateResult.acquired) {
      const checkedAtMs = now();
      const retryState = await finishRetryable({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        result: buildGateBlockedFailure(gateResult, checkedAtMs),
        currentDelivery: gateIdentity.delivery,
        preserveApiGateIdentity: true,
        persistBeforeSchedule: true,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    const editCallAtMs = now();
    if (
      (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(gateIdentity.delivery) >
        0 &&
      (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(
        gateIdentity.delivery,
      ) <= editCallAtMs
    ) {
      const result = { code: "safe-retry-window-exhausted" };
      await finishStatusAndSettleApiGate({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        status: "terminal",
        result,
        nowMs: editCallAtMs,
        apiGateSettleOwner: apiGateOwner,
      });
      return { status: "terminal", reason: result.code };
    }
    await markAppliedStateUnknown({
      messageKey: normalizedMessageKey,
      ownerToken,
      desired,
      operation: "edit",
      apiGateOwner,
    });
    const editResult = await client.editTelegramMessage({
      chatId: (0, deliveryState_js_1.normalizeString)(applied.chatId) || chatId,
      messageId: applied.messageId,
      text: desired.text,
      parseMode: desired.parseMode || null,
      disableWebPagePreview: desired.disableWebPagePreview !== false,
    });
    if (editResult.ok) {
      await finishStatusAndSettleApiGate({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        status: "delivered",
        nowMs,
        receipt: {
          kind: "set",
          value: {
            ...applied,
            destination: desired.destination,
            chatId:
              (0, deliveryState_js_1.normalizeString)(applied.chatId) || chatId,
            instanceKey: desired.instanceKey,
            revision: desired.revision,
            contentHash: desired.contentHash,
            appliedAtMs: nowMs,
          },
        },
        clearAppliedStateUnknown: true,
        apiGateSettleOwner: apiGateOwner,
      });
      return { status: "delivered" };
    }
    if (editResult.classification === "missing") {
      if (desired.ifMissing === "skip") {
        await finishStatusAndSettleApiGate({
          messageKey: normalizedMessageKey,
          ownerToken,
          desired,
          status: "delivered",
          nowMs,
          receipt: { kind: "clear" },
          clearAppliedStateUnknown: true,
          apiGateSettleOwner: apiGateOwner,
        });
        return { status: "delivered", reason: "missing-skipped" };
      }
      (0, deliveryState_js_1.ensureCommitted)(
        await updateOwned(
          normalizedMessageKey,
          ownerToken,
          (record, delivery) => {
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
          },
        ),
        "missing-edit-transition-not-persisted",
      );
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "apiGateSettleOwner",
        owner: apiGateOwner,
      });
      return runSend({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        chatId,
        previousApplied: null,
        nowMs,
        requestedGeneration,
      });
    }
    if (editResult.classification === "retryable") {
      const retryState = await finishRetryable({
        messageKey: normalizedMessageKey,
        ownerToken,
        desired,
        result: editResult,
        currentDelivery: gateIdentity.delivery,
        apiGateOwner,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    await finishStatusAndSettleApiGate({
      messageKey: normalizedMessageKey,
      ownerToken,
      desired,
      status: "terminal",
      result: editResult,
      nowMs,
      apiGateSettleOwner: apiGateOwner,
    });
    logFailure(normalizedMessageKey, "terminal", editResult);
    return { status: "terminal", reason: editResult.code };
  };
  return { reconcileDesired };
}
