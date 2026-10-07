import {
  normalizeRetrySequence,
  normalizeTimestamp,
} from "./deliveryPolicy.js";
import { createTelegramRetryCoordinator } from "./deliveryRetryCoordinator.js";
import type {
  TelegramBarrierProofResult,
  TelegramLocalRetryBarrier,
  TelegramRetryFailure,
} from "./deliveryRetryTypes.js";
import {
  asObject,
  buildApiGateOwner,
  ensureCommitted,
  normalizeString,
  omitKeys,
  readDelivery,
  readPendingDelete,
  type ExactRetryInput,
  type MessageMutation,
  type OwnedMutation,
} from "./deliveryState.js";
import type {
  TelegramApiGateResult,
  TelegramRepository,
  TelegramRetryScheduler,
} from "./deliveryTypes.js";
import { TELEGRAM_DESIRED_TASK_KIND } from "./taskKinds.js";
import { readProperty } from "./values.js";
export function createTelegramDeliveryControl({
  repository,
  logger,
  now,
  scheduleRetry,
  localRetryBarrier,
}: {
  repository: TelegramRepository;
  logger: Pick<Console, "error" | "info">;
  now: () => number;
  scheduleRetry: TelegramRetryScheduler;
  localRetryBarrier: TelegramLocalRetryBarrier;
}) {
  const logFailure = (
    messageKey: string,
    status: string,
    error: TelegramRetryFailure,
  ) => {
    if (typeof logger?.error === "function") {
      logger.error("telegram:delivery:failed", {
        messageKey,
        status,
        code: error?.code || "telegram-error",
        httpStatus: error?.httpStatus || null,
      });
    }
  };
  const transact = (messageKey: string, updater: MessageMutation) =>
    repository.transactMessage(messageKey, (current) => {
      const record = asObject(current);
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
  }: ExactRetryInput) => {
    const normalizedTaskKind =
      normalizeString(taskKind) || TELEGRAM_DESIRED_TASK_KIND;
    const retrySequence = normalizeRetrySequence(retryState.retrySequence);
    const generation = [
      normalizedTaskKind,
      retrySequence,
      normalizeTimestamp(retryState.retryAtMs),
      safeRejectedAttemptId || pendingDeleteId || revision,
      normalizeString(retryProofLeaseOwner),
      normalizeString(sourceGeneration),
      normalizeString(proofTaskKind),
      normalizeString(barrierProofOwner),
      normalizeTimestamp(barrierRetryNotBeforeMs),
      normalizeString(apiGateReclaimOwner),
      normalizeString(apiGateSettleOwner),
    ].join(":");
    return scheduleRetry({
      messageKey,
      revision,
      taskKind: normalizedTaskKind,
      retrySequence,
      generation,
      retryStartedAtMs: normalizeTimestamp(retryState.retryStartedAtMs),
      retryDeadlineAtMs: normalizeTimestamp(retryState.retryDeadlineAtMs),
      retryAtMs: normalizeTimestamp(retryState.retryAtMs),
      scheduleTimeMs:
        normalizeTimestamp(scheduleTimeMs) ||
        normalizeTimestamp(retryState.retryAtMs),
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
  const retryCoordinator = createTelegramRetryCoordinator({
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
  }: {
    barrierProofOwner?: unknown;
    barrierRetryNotBeforeMs?: unknown;
  }): Promise<Partial<TelegramBarrierProofResult> & { applied: boolean }> => {
    const owner = normalizeString(barrierProofOwner);
    const retryNotBeforeMs = normalizeTimestamp(barrierRetryNotBeforeMs);
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
  const clearAppliedRateLimitProofMarker = async (
    messageKey: string,
    ownerInput: unknown,
  ) => {
    const owner = normalizeString(ownerInput);
    if (!owner) {
      return;
    }
    await transact(messageKey, (record) => {
      const delivery = readDelivery(record.delivery);
      const pendingDelete = readPendingDelete(delivery.pendingDelete);
      const clearsDesired =
        normalizeString(
          readProperty(delivery.apiGateProofRequired, "owner"),
        ) === owner;
      const clearsPending =
        normalizeString(
          readProperty(pendingDelete.apiGateProofRequired, "owner"),
        ) === owner;
      if (!clearsDesired && !clearsPending) {
        return { commit: false, decision: "rate-limit-proof-marker-stale" };
      }
      return {
        value: {
          ...record,
          delivery: {
            ...(clearsDesired
              ? omitKeys(delivery, ["apiGateProofRequired"])
              : delivery.source),
            ...(clearsPending
              ? {
                  pendingDelete: omitKeys(pendingDelete, [
                    "apiGateProofRequired",
                  ]),
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
  }: {
    messageKey: string;
    revision: string;
    operation: string;
    owner: string;
    attemptId?: string;
    pendingDeleteId?: string;
    reclaimOwner?: string;
    taskGeneration?: string;
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
  const buildGateBlockedFailure = (
    gateResult: TelegramApiGateResult,
    checkedAtMs: number,
  ): TelegramRetryFailure => ({
    code:
      gateResult.reason === "retry-after"
        ? "global-retry-after"
        : "global-api-gate-held",
    retryAfterSeconds:
      gateResult.retryNotBeforeMs > checkedAtMs
        ? (gateResult.retryNotBeforeMs - checkedAtMs) / 1000
        : null,
  });
  const updateOwned = async (
    messageKey: string,
    ownerToken: string,
    updater: OwnedMutation,
  ) =>
    transact(messageKey, (record) => {
      const delivery = readDelivery(record.delivery);
      if (normalizeString(delivery.leaseOwner) !== ownerToken) {
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
  }: {
    messageKey: string;
    ownerToken: string;
    revision: string;
    requestedGeneration?: string;
    apiGateReclaimOwner?: string;
  }) => {
    const generation =
      normalizeString(requestedGeneration) || `direct:${revision}`;
    const preparedAtMs = now();
    const prepared = ensureCommitted(
      await updateOwned(messageKey, ownerToken, (record, delivery) => {
        const existingOwner = normalizeString(delivery.apiGateOwner);
        return {
          ...record,
          delivery: {
            ...delivery.source,
            apiGateOwner:
              existingOwner ||
              buildApiGateOwner(messageKey, "desired", revision, generation),
            apiGateGeneration:
              normalizeString(delivery.apiGateGeneration) || generation,
            apiGateStartedAtMs:
              normalizeTimestamp(delivery.apiGateStartedAtMs) || preparedAtMs,
          },
        };
      }),
      "api-gate-identity-not-persisted",
    );
    const delivery = readDelivery(prepared.value?.delivery);
    const owner = normalizeString(delivery.apiGateOwner);
    const persistedGeneration = normalizeString(delivery.apiGateGeneration);
    const proofRequiredOwner = normalizeString(
      readProperty(delivery.apiGateProofRequired, "owner"),
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
  }: {
    messageKey: string;
    field: "apiGateSettleOwner" | "pendingDeleteApiGateSettleOwner";
    owner: unknown;
  }) => {
    const settleOwner = normalizeString(ownerInput);
    if (!settleOwner) {
      return null;
    }
    await repository.releaseApiGate(settleOwner);
    const result = await transact(messageKey, (record) => {
      const delivery = readDelivery(record.delivery);
      if (delivery.settlementOwner(field) !== settleOwner) {
        return { commit: false, decision: "api-gate-settle-stale" };
      }
      return {
        value: {
          ...record,
          delivery: omitKeys(delivery, [field]),
        },
        decision: "api-gate-settled",
      };
    });
    if (!result.committed && result.decision !== "api-gate-settle-stale") {
      ensureCommitted(result, "api-gate-settle-finalization-failed");
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
export type TelegramDeliveryControl = ReturnType<
  typeof createTelegramDeliveryControl
>;
