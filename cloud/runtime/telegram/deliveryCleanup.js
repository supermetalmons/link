// Generated from src/telegram/deliveryCleanup.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTelegramCleanupDelivery = createTelegramCleanupDelivery;
const deliveryPolicy_js_1 = require("./deliveryPolicy.js");
const deliveryState_js_1 = require("./deliveryState.js");
const desiredStateCore_js_1 = require("./desiredStateCore.js");
const taskKinds_js_1 = require("./taskKinds.js");
const values_js_1 = require("./values.js");
function createTelegramCleanupDelivery({
  repository,
  client,
  now,
  createOwnerToken,
  leaseTtlMs,
  localRetryBarrier,
  control,
  recovery,
}) {
  const {
    transact,
    retryCoordinator,
    settlePersistedApiGate,
    acquireApiGate,
    buildGateBlockedFailure,
    scheduleExactRetry,
    applyRateLimitBarrierProof,
    clearAppliedRateLimitProofMarker,
  } = control;
  const { applyPendingDeleteRetryWindowProof } = recovery;
  const orphanPendingDelete = async ({
    messageKey,
    pendingDeleteId,
    result,
    nowMs,
    ownerToken = "",
    apiGateSettleOwner = "",
  }) =>
    (0, deliveryState_js_1.ensureCommitted)(
      await transact(messageKey, (record) => {
        const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
        const pendingDelete = (0, deliveryState_js_1.readPendingDelete)(
          delivery.pendingDelete,
        );
        if (
          (0, deliveryState_js_1.normalizeString)(
            pendingDelete.pendingDeleteId,
          ) !== pendingDeleteId ||
          (ownerToken &&
            (0, deliveryState_js_1.normalizeString)(
              pendingDelete.leaseOwner,
            ) !== ownerToken)
        ) {
          return { commit: false, decision: "pending-delete-lost" };
        }
        const orphanedDeletes = (0, deliveryState_js_1.asObject)(
          delivery.orphanedDeletes,
        );
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
              lastError: (0, deliveryPolicy_js_1.buildErrorState)(
                result,
                nowMs,
              ),
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
      }),
      "pending-delete-orphan-finalization-failed",
    );
  const finishPendingDeleteRetryable = async ({
    messageKey,
    revision,
    pendingDelete,
    pendingDeleteId,
    ownerToken,
    result,
    apiGateOwner = "",
    preserveApiGateIdentity = false,
    persistBeforeSchedule = false,
  }) => {
    return retryCoordinator.finish({
      current: (0, deliveryState_js_1.asObject)(pendingDelete),
      failure: result,
      target: {
        kind: taskKinds_js_1.TELEGRAM_PENDING_DELETE_TASK_KIND,
        pendingDeleteId,
      },
      messageKey,
      revision,
      ownerToken,
      apiGateOwner,
      persistBeforeSchedule,
      persistProof: async ({ retryState, barrierRetryNotBeforeMs }) => {
        (0, deliveryState_js_1.ensureCommitted)(
          await transact(messageKey, (record) => {
            const delivery = (0, deliveryState_js_1.readDelivery)(
              record.delivery,
            );
            const latestPendingDelete = (0,
            deliveryState_js_1.readPendingDelete)(delivery.pendingDelete);
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
                  ...delivery.source,
                  pendingDelete: {
                    ...latestPendingDelete.source,
                    apiGateProofRequired: {
                      owner: apiGateOwner,
                      retryNotBeforeMs: barrierRetryNotBeforeMs,
                      revision,
                      proofTaskKind:
                        taskKinds_js_1.TELEGRAM_PENDING_DELETE_TASK_KIND,
                      pendingDeleteId,
                      retryProofLeaseOwner: ownerToken,
                      ...retryState,
                    },
                  },
                },
              },
              decision: "pending-rate-limit-proof-required",
            };
          }),
          "pending-rate-limit-proof-marker-failed",
        );
      },
      persistState: async ({ finalizedAtMs, retryState, rateLimited }) => {
        const finalization = await transact(messageKey, (record) => {
          const delivery = (0, deliveryState_js_1.readDelivery)(
            record.delivery,
          );
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
                ...delivery.source,
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
        });
        if (!finalization.committed) {
          const current = (0, deliveryState_js_1.asObject)(
            await repository.getMessage(messageKey),
          );
          const currentPendingDelete = (0, deliveryState_js_1.asObject)(
            (0, values_js_1.readProperty)(current.delivery, "pendingDelete"),
          );
          const proofAlreadyApplied =
            rateLimited &&
            (0, deliveryPolicy_js_1.normalizeRetrySequence)(
              currentPendingDelete.retrySequence,
            ) >= retryState.retrySequence &&
            (0, deliveryState_js_1.normalizeString)(
              (0, values_js_1.readProperty)(
                currentPendingDelete.apiGateProofRequired,
                "owner",
              ),
            ) !== (0, deliveryState_js_1.normalizeString)(apiGateOwner);
          if (!proofAlreadyApplied) {
            (0, deliveryState_js_1.ensureCommitted)(
              finalization,
              "pending-delete-retryable-finalization-failed",
            );
          }
        }
      },
    });
  };
  const reconcilePendingDelete = async ({
    messageKey,
    requestedRevision = "",
    requestedPendingDeleteId = "",
    requestedGeneration = "",
    retryStartedAtMs = 0,
    retryDeadlineAtMs = 0,
    retryAtMs = 0,
    retrySequence = 0,
    retryProofLeaseOwner = "",
    apiGateReclaimOwner = "",
  }) => {
    const normalizedMessageKey = (0,
    desiredStateCore_js_1.validateTelegramMessageKey)(messageKey);
    await applyPendingDeleteRetryWindowProof(normalizedMessageKey, {
      pendingDeleteId: requestedPendingDeleteId,
      retryStartedAtMs,
      retryDeadlineAtMs,
      retryAtMs,
      retrySequence,
      retryProofLeaseOwner,
      apiGateReclaimOwner,
    });
    const nowMs = now();
    const ownerToken = createOwnerToken();
    let decision = "missing";
    const acquired = await transact(normalizedMessageKey, (record) => {
      const delivery = (0, deliveryState_js_1.readDelivery)(record.delivery);
      const pendingDelete = (0, deliveryState_js_1.readPendingDelete)(
        delivery.pendingDelete,
      );
      if (delivery.status === "uncertain" || delivery.sendInFlight) {
        decision = "blocked-uncertain";
        return { commit: false, decision };
      }
      const chatId = (0, deliveryState_js_1.normalizeString)(
        pendingDelete.chatId,
      );
      const messageId = Number(pendingDelete.messageId);
      if (!pendingDelete.present) {
        decision = "missing";
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
      if (
        currentApiGateOwner &&
        currentApiGateOwner === currentProofGateOwner
      ) {
        decision = "rate-limit-proof-pending";
        return { commit: false, decision };
      }
      if (!chatId || !Number.isInteger(messageId) || messageId <= 0) {
        decision = "invalid";
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
            ...(0, deliveryState_js_1.asObject)(delivery.orphanedDeletes),
            [pendingDeleteId]: {
              ...pendingDelete.source,
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
      const retryDeadlineAtMs = (0,
      deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(pendingDelete);
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
        return { commit: false, decision };
      }
      if (
        ["pending", "processing", "retryable"].includes(pendingDelete.status) &&
        retryDeadlineAtMs > 0 &&
        retryDeadlineAtMs <= nowMs
      ) {
        decision = "exhausted";
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
            ...(0, deliveryState_js_1.asObject)(delivery.orphanedDeletes),
            [pendingDeleteId]: {
              ...(0, deliveryPolicy_js_1.omitRetryState)(pendingDelete.source),
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
        return { commit: false, decision };
      }
      decision = "acquired";
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
            ...delivery.source,
            pendingDelete: (0, deliveryState_js_1.writeCleanup)({
              ...pendingDelete.source,
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
    });
    if (decision === "missing" || decision === "stale") {
      return { status: "settled", cleanup: decision };
    }
    if (decision === "blocked-uncertain") {
      return { status: "uncertain", cleanup: decision };
    }
    if (decision === "rate-limit-proof-pending") {
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
        pendingDeleteId:
          (0, deliveryState_js_1.normalizeString)(proof.pendingDeleteId) ||
          requestedPendingDeleteId,
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
          pendingDeleteId:
            (0, deliveryState_js_1.normalizeString)(proof.pendingDeleteId) ||
            requestedPendingDeleteId,
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
        cleanup: decision,
        retryAtMs: (0, deliveryPolicy_js_1.normalizeTimestamp)(
          proof.retryNotBeforeMs,
        ),
        scheduled: true,
      };
    }
    if (decision === "invalid" || decision === "exhausted") {
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "pendingDeleteApiGateSettleOwner",
        owner: (0, values_js_1.readProperty)(
          acquired.value?.delivery,
          "pendingDeleteApiGateSettleOwner",
        ),
      });
      return { status: "settled", cleanup: decision };
    }
    if (decision === "deferred" || decision === "locked") {
      const pendingDelete = (0, deliveryState_js_1.readPendingDelete)(
        (0, values_js_1.readProperty)(
          acquired.value?.delivery,
          "pendingDelete",
        ),
      );
      const lockedGateOwner = (0, deliveryState_js_1.normalizeString)(
        pendingDelete.apiGateOwner,
      );
      const lockedGateGeneration = (0, deliveryState_js_1.normalizeString)(
        pendingDelete.apiGateGeneration,
      );
      const mayReclaimLockedGate =
        lockedGateOwner &&
        ((0, deliveryState_js_1.normalizeString)(apiGateReclaimOwner) ===
          lockedGateOwner ||
          (lockedGateGeneration &&
            lockedGateGeneration ===
              (0, deliveryState_js_1.normalizeString)(requestedGeneration)));
      const retryAtMs =
        decision === "deferred"
          ? (0, deliveryPolicy_js_1.normalizeTimestamp)(pendingDelete.retryAtMs)
          : (0, deliveryPolicy_js_1.normalizeTimestamp)(
              pendingDelete.leaseExpiresAtMs,
            ) || nowMs + 1000;
      await scheduleExactRetry({
        messageKey: normalizedMessageKey,
        revision:
          (0, deliveryState_js_1.normalizeString)(
            (0, values_js_1.readProperty)(acquired.value?.desired, "revision"),
          ) ||
          requestedRevision ||
          "latest",
        taskKind: taskKinds_js_1.TELEGRAM_PENDING_DELETE_TASK_KIND,
        retryState: {
          retryStartedAtMs: pendingDelete.retryTimestampOr(
            "retryStartedAtMs",
            retryStartedAtMs,
          ),
          retryDeadlineAtMs: pendingDelete.retryTimestampOr(
            "retryDeadlineAtMs",
            retryDeadlineAtMs,
          ),
          retryAtMs,
          retrySequence: pendingDelete.retrySequenceOr(retrySequence),
        },
        pendingDeleteId: (0, deliveryState_js_1.resolvePendingDeleteId)(
          pendingDelete,
        ),
        sourceGeneration: requestedGeneration,
        apiGateReclaimOwner: mayReclaimLockedGate ? lockedGateOwner : "",
      });
      return { status: "retryable", retryAtMs, scheduled: true };
    }
    if (decision !== "acquired") {
      return { status: "settled", cleanup: "missing" };
    }
    const pendingDelete = (0, deliveryState_js_1.readPendingDelete)(
      (0, values_js_1.readProperty)(acquired.value?.delivery, "pendingDelete"),
    );
    const pendingDeleteId = (0, deliveryState_js_1.normalizeString)(
      pendingDelete.pendingDeleteId,
    );
    const callAtMs = now();
    if (
      (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(pendingDelete) > 0 &&
      (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(pendingDelete) <=
        callAtMs
    ) {
      await orphanPendingDelete({
        messageKey: normalizedMessageKey,
        pendingDeleteId,
        result: { code: "safe-retry-window-exhausted" },
        nowMs: callAtMs,
        ownerToken,
        apiGateSettleOwner: pendingDelete.apiGateOwner,
      });
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "pendingDeleteApiGateSettleOwner",
        owner: pendingDelete.apiGateOwner,
      });
      return { status: "settled", cleanup: "exhausted" };
    }
    const retryNotBeforeMs = Math.max(
      await repository.getRetryNotBeforeMs(),
      localRetryBarrier.getRetryNotBeforeMs(),
    );
    const barrierCheckedAtMs = now();
    if (
      (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(pendingDelete) > 0 &&
      (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(pendingDelete) <=
        barrierCheckedAtMs
    ) {
      await orphanPendingDelete({
        messageKey: normalizedMessageKey,
        pendingDeleteId,
        result: { code: "safe-retry-window-exhausted" },
        nowMs: barrierCheckedAtMs,
        ownerToken,
        apiGateSettleOwner: pendingDelete.apiGateOwner,
      });
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "pendingDeleteApiGateSettleOwner",
        owner: pendingDelete.apiGateOwner,
      });
      return { status: "settled", cleanup: "exhausted" };
    }
    if (retryNotBeforeMs > barrierCheckedAtMs) {
      const retryState = await finishPendingDeleteRetryable({
        messageKey: normalizedMessageKey,
        revision:
          (0, deliveryState_js_1.normalizeString)(
            (0, values_js_1.readProperty)(acquired.value?.desired, "revision"),
          ) ||
          requestedRevision ||
          "latest",
        pendingDelete,
        pendingDeleteId,
        ownerToken,
        result: {
          code: "global-retry-after",
          retryAfterSeconds: Math.max(
            0,
            (retryNotBeforeMs - barrierCheckedAtMs) / 1000,
          ),
        },
        preserveApiGateIdentity: Boolean(pendingDelete.apiGateOwner),
        persistBeforeSchedule: true,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    const apiGateOwner = (0, deliveryState_js_1.normalizeString)(
      pendingDelete.apiGateOwner,
    );
    const pendingGateGeneration = (0, deliveryState_js_1.normalizeString)(
      pendingDelete.apiGateGeneration,
    );
    const proofRequiredOwner = (0, deliveryState_js_1.normalizeString)(
      (0, values_js_1.readProperty)(
        pendingDelete.apiGateProofRequired,
        "owner",
      ),
    );
    const mayReclaimApiGate =
      apiGateOwner !== "" && proofRequiredOwner !== apiGateOwner;
    const gateResult = await acquireApiGate({
      messageKey: normalizedMessageKey,
      revision:
        (0, deliveryState_js_1.normalizeString)(
          (0, values_js_1.readProperty)(acquired.value?.desired, "revision"),
        ) ||
        requestedRevision ||
        "latest",
      operation: "pending-delete",
      owner: apiGateOwner,
      pendingDeleteId,
      reclaimOwner: mayReclaimApiGate ? apiGateOwner : "",
      taskGeneration: pendingGateGeneration,
    });
    if (!gateResult.acquired) {
      const checkedAtMs = now();
      const retryState = await finishPendingDeleteRetryable({
        messageKey: normalizedMessageKey,
        revision:
          (0, deliveryState_js_1.normalizeString)(
            (0, values_js_1.readProperty)(acquired.value?.desired, "revision"),
          ) ||
          requestedRevision ||
          "latest",
        pendingDelete,
        pendingDeleteId,
        ownerToken,
        result: buildGateBlockedFailure(gateResult, checkedAtMs),
        preserveApiGateIdentity: true,
        persistBeforeSchedule: true,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    const deleteCallAtMs = now();
    if (
      (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(pendingDelete) > 0 &&
      (0, deliveryPolicy_js_1.resolveRetryDeadlineAtMs)(pendingDelete) <=
        deleteCallAtMs
    ) {
      await orphanPendingDelete({
        messageKey: normalizedMessageKey,
        pendingDeleteId,
        result: { code: "safe-retry-window-exhausted" },
        nowMs: deleteCallAtMs,
        ownerToken,
        apiGateSettleOwner: apiGateOwner,
      });
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "pendingDeleteApiGateSettleOwner",
        owner: apiGateOwner,
      });
      return { status: "settled", cleanup: "exhausted" };
    }
    const result = await client.deleteTelegramMessage({
      chatId: pendingDelete.chatId,
      messageId: pendingDelete.messageId,
    });
    if (result.ok) {
      (0, deliveryState_js_1.ensureCommitted)(
        await transact(normalizedMessageKey, (record) => {
          const delivery = (0, deliveryState_js_1.readDelivery)(
            record.delivery,
          );
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
        }),
        "pending-delete-finalization-failed",
      );
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "pendingDeleteApiGateSettleOwner",
        owner: apiGateOwner,
      });
      return { status: "settled", cleanup: "deleted" };
    }
    if (result.classification === "retryable") {
      const retryState = await finishPendingDeleteRetryable({
        messageKey: normalizedMessageKey,
        revision:
          (0, deliveryState_js_1.normalizeString)(
            (0, values_js_1.readProperty)(acquired.value?.desired, "revision"),
          ) ||
          requestedRevision ||
          "latest",
        pendingDelete,
        pendingDeleteId,
        ownerToken,
        result,
        apiGateOwner,
      });
      return {
        status: "retryable",
        retryAtMs: retryState.retryAtMs,
        scheduled: true,
      };
    }
    await orphanPendingDelete({
      messageKey: normalizedMessageKey,
      pendingDeleteId,
      result,
      nowMs: now(),
      ownerToken,
      apiGateSettleOwner: apiGateOwner,
    });
    await settlePersistedApiGate({
      messageKey: normalizedMessageKey,
      field: "pendingDeleteApiGateSettleOwner",
      owner: apiGateOwner,
    });
    return { status: "settled", cleanup: "orphaned" };
  };
  return { reconcilePendingDelete };
}
