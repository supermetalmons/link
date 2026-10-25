// Generated from src/telegram/deliveryCleanup.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTelegramCleanupDelivery = createTelegramCleanupDelivery;
const deliveryState_js_1 = require("./deliveryState.js");
const retryRecords_js_1 = require("./retryRecords.js");
const records_js_1 = require("./records.js");
const deliveryCleanupRecords_js_1 = require("./deliveryCleanupRecords.js");
const records_js_2 = require("./records.js");
const deliveryPolicy_js_1 = require("./deliveryPolicy.js");
const deliveryState_js_2 = require("./deliveryState.js");
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
  } = control;
  const { applyPendingDeleteRetryWindowProof, resumeRateLimitProof } = recovery;
  const orphanPendingDelete = async ({
    messageKey,
    pendingDeleteId,
    result,
    nowMs,
    ownerToken = "",
    apiGateSettleOwner = "",
  }) =>
    (0, deliveryState_js_2.ensureCommitted)(
      await transact(messageKey, (record) =>
        (0, deliveryCleanupRecords_js_1.orphanPendingDeleteRecord)(
          (0, records_js_2.messageDocument)(record),
          {
            apiGateSettleOwner,
            nowMs,
            ownerToken,
            pendingDeleteId,
            result,
          },
        ),
      ),
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
      current: (0, deliveryState_js_1.retryDocument)(pendingDelete),
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
        (0, deliveryState_js_2.ensureCommitted)(
          await transact(messageKey, (record) =>
            (0, deliveryCleanupRecords_js_1.recordCleanupRetryProof)(
              (0, records_js_2.messageDocument)(record),
              {
                apiGateOwner,
                barrierRetryNotBeforeMs,
                ownerToken,
                pendingDeleteId,
                retryState,
                revision,
              },
            ),
          ),
          "pending-rate-limit-proof-marker-failed",
        );
      },
      persistState: async ({ finalizedAtMs, retryState, rateLimited }) => {
        const finalization = await transact(messageKey, (record) =>
          (0, deliveryCleanupRecords_js_1.recordCleanupRetryState)(
            (0, records_js_2.messageDocument)(record),
            {
              finalizedAtMs,
              ownerToken,
              pendingDeleteId,
              preserveApiGateIdentity,
              result,
              retryState,
            },
          ),
        );
        if (!finalization.committed) {
          const current = await repository.getMessage(messageKey);
          const currentPendingDelete = (0,
          deliveryState_js_2.readPendingDelete)(
            (0, values_js_1.readProperty)(
              (0, records_js_1.messageDeliveryDocument)(current),
              "pendingDelete",
            ),
          );
          const proofAlreadyApplied =
            rateLimited &&
            (0, deliveryPolicy_js_1.normalizeRetrySequence)(
              currentPendingDelete.retrySequence,
            ) >= retryState.retrySequence &&
            currentPendingDelete.apiGateProofOwner !==
              (0, deliveryState_js_2.normalizeString)(apiGateOwner);
          if (!proofAlreadyApplied) {
            (0, deliveryState_js_2.ensureCommitted)(
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
    const acquired = await transact(normalizedMessageKey, (record) =>
      (0, deliveryCleanupRecords_js_1.acquirePendingDeleteRecord)(
        (0, records_js_2.messageDocument)(record),
        {
          leaseTtlMs,
          normalizedMessageKey,
          nowMs,
          ownerToken,
          requestedGeneration,
          requestedPendingDeleteId,
          observeDecision: (value) => {
            decision = value;
          },
        },
      ),
    );
    if (decision === "missing" || decision === "stale") {
      return { status: "settled", cleanup: decision };
    }
    if (decision === "blocked-uncertain") {
      return { status: "uncertain", cleanup: decision };
    }
    if (decision === "rate-limit-proof-pending") {
      const proof = (0, retryRecords_js_1.messageRateLimitProof)(
        (0, records_js_1.messageDeliveryDocument)(acquired.value),
        true,
      );
      await resumeRateLimitProof({
        messageKey: normalizedMessageKey,
        proof,
        requestedRevision,
        nowMs,
        target: { kind: "pending-delete", requestedPendingDeleteId },
      });
      return {
        status: "retryable",
        cleanup: decision,
        retryAtMs: (0, retryRecords_js_1.rateLimitProofRetryAt)(proof),
        scheduled: true,
      };
    }
    if (decision === "invalid" || decision === "exhausted") {
      await settlePersistedApiGate({
        messageKey: normalizedMessageKey,
        field: "pendingDeleteApiGateSettleOwner",
        owner: (0, retryRecords_js_1.messageSettlementOwnerInput)(
          acquired.value,
          "pendingDeleteApiGateSettleOwner",
        ),
      });
      return { status: "settled", cleanup: decision };
    }
    if (decision === "deferred" || decision === "locked") {
      const pendingDelete = (0, deliveryState_js_2.readPendingDelete)(
        (0, values_js_1.readProperty)(
          (0, records_js_1.messageDeliveryDocument)(acquired.value),
          "pendingDelete",
        ),
      );
      const lockedGateOwner = (0, deliveryState_js_2.normalizeString)(
        pendingDelete.apiGateOwner,
      );
      const lockedGateGeneration = (0, deliveryState_js_2.normalizeString)(
        pendingDelete.apiGateGeneration,
      );
      const mayReclaimLockedGate =
        lockedGateOwner &&
        ((0, deliveryState_js_2.normalizeString)(apiGateReclaimOwner) ===
          lockedGateOwner ||
          (lockedGateGeneration &&
            lockedGateGeneration ===
              (0, deliveryState_js_2.normalizeString)(requestedGeneration)));
      const retryAtMs =
        decision === "deferred"
          ? (0, deliveryPolicy_js_1.normalizeTimestamp)(pendingDelete.retryAtMs)
          : (0, deliveryPolicy_js_1.normalizeTimestamp)(
              pendingDelete.leaseExpiresAtMs,
            ) || nowMs + 1000;
      await scheduleExactRetry({
        messageKey: normalizedMessageKey,
        revision:
          (0, deliveryState_js_2.normalizeString)(
            (0, values_js_1.readProperty)(
              (0, records_js_1.messageDesiredDocument)(acquired.value),
              "revision",
            ),
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
        pendingDeleteId: (0, deliveryState_js_2.resolvePendingDeleteId)(
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
    const pendingDelete = (0, deliveryState_js_2.readPendingDelete)(
      (0, values_js_1.readProperty)(
        (0, records_js_1.messageDeliveryDocument)(acquired.value),
        "pendingDelete",
      ),
    );
    const pendingDeleteId = (0, deliveryState_js_2.normalizeString)(
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
          (0, deliveryState_js_2.normalizeString)(
            (0, values_js_1.readProperty)(
              (0, records_js_1.messageDesiredDocument)(acquired.value),
              "revision",
            ),
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
    const apiGateOwner = (0, deliveryState_js_2.normalizeString)(
      pendingDelete.apiGateOwner,
    );
    const pendingGateGeneration = (0, deliveryState_js_2.normalizeString)(
      pendingDelete.apiGateGeneration,
    );
    const proofRequiredOwner = (0, deliveryState_js_2.normalizeString)(
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
        (0, deliveryState_js_2.normalizeString)(
          (0, values_js_1.readProperty)(
            (0, records_js_1.messageDesiredDocument)(acquired.value),
            "revision",
          ),
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
          (0, deliveryState_js_2.normalizeString)(
            (0, values_js_1.readProperty)(
              (0, records_js_1.messageDesiredDocument)(acquired.value),
              "revision",
            ),
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
    const result = await client.deleteTelegramMessage(
      pendingDelete.deleteInput(),
    );
    if (result.ok) {
      (0, deliveryState_js_2.ensureCommitted)(
        await transact(normalizedMessageKey, (record) =>
          (0, deliveryCleanupRecords_js_1.clearPendingDeleteRecord)(
            (0, records_js_2.messageDocument)(record),
            {
              apiGateOwner,
              ownerToken,
              pendingDeleteId,
            },
          ),
        ),
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
          (0, deliveryState_js_2.normalizeString)(
            (0, values_js_1.readProperty)(
              (0, records_js_1.messageDesiredDocument)(acquired.value),
              "revision",
            ),
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
