import {
  buildTelegramRetrySchedule,
  readBarrierProofInput,
  type TelegramBarrierInput,
  type RetainedTelegramBarrierInput,
  type RetainedTelegramOwner,
} from "./retryRecords.js";
import { messageDeliveryDocument } from "./records.js";
import {
  clearRateLimitProofRecord,
  prepareDesiredGateRecord,
  settleApiGateRecord,
} from "./deliveryControlRecords.js";
import { messageDocument } from "./records.js";

import { createTelegramRetryCoordinator } from "./deliveryRetryCoordinator.js";
import type {
  TelegramBarrierProofResult,
  TelegramLocalRetryBarrier,
  TelegramRetryFailure,
} from "./deliveryRetryTypes.js";
import {
  ensureCommitted,
  normalizeString,
  readDelivery,
  type ExactRetryInput,
  type MessageMutation,
  type OwnedMutation,
} from "./deliveryState.js";
import type {
  TelegramApiGateResult,
  TelegramRepository,
  TelegramRetryScheduler,
} from "./deliveryTypes.js";

import { readProperty } from "./values.js";
import type { TelegramApiOperation } from "./records.js";
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
      const record = messageDocument(current);
      return updater(record);
    });
  const scheduleExactRetry = async (input: ExactRetryInput) =>
    scheduleRetry(buildTelegramRetrySchedule(input));

  const retryCoordinator = createTelegramRetryCoordinator({
    now,
    scheduleExactRetry,
    releaseApiGate: (owner) => repository.releaseApiGate(owner),
    extendRetryBarrierAndReleaseApiGate: (proof) =>
      repository.extendRetryBarrierAndReleaseApiGate(proof),
    localRetryBarrier,
  });
  const applyRateLimitBarrierProof = async (
    input: TelegramBarrierInput | RetainedTelegramBarrierInput,
  ): Promise<Partial<TelegramBarrierProofResult> & { applied: boolean }> => {
    const { owner, retryNotBeforeMs } = readBarrierProofInput(input);
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
    ownerInput: string | RetainedTelegramOwner | undefined,
  ) => {
    const owner = normalizeString(ownerInput);
    if (!owner) {
      return;
    }
    await transact(messageKey, (record) =>
      clearRateLimitProofRecord(messageDocument(record), { owner }),
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
  }: {
    messageKey: string;
    revision: string;
    operation: TelegramApiOperation;
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
      const delivery = readDelivery(messageDeliveryDocument(record));
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
      await updateOwned(messageKey, ownerToken, (record, delivery) =>
        prepareDesiredGateRecord(messageDocument(record), delivery, {
          generation,
          messageKey,
          preparedAtMs,
          revision,
        }),
      ),
      "api-gate-identity-not-persisted",
    );
    const delivery = readDelivery(messageDeliveryDocument(prepared.value));
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
    owner: string | RetainedTelegramOwner | undefined;
  }) => {
    const settleOwner = normalizeString(ownerInput);
    if (!settleOwner) {
      return null;
    }
    await repository.releaseApiGate(settleOwner);
    const result = await transact(messageKey, (record) =>
      settleApiGateRecord(messageDocument(record), { field, settleOwner }),
    );
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
