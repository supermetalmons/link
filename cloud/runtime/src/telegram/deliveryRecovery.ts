import type { TelegramDeliveryControl } from "./deliveryControl.js";
import {
  normalizeAttempts,
  normalizeRetrySequence,
  normalizeTimestamp,
  omitRetryState,
} from "./deliveryPolicy.js";
import {
  appendPendingDelete,
  asObject,
  buildPendingDeleteId,
  ensureCommitted,
  normalizeString,
  omitKeys,
  readDelivery,
  readPendingDelete,
  resolvePendingDeleteId,
  writeCleanup,
  writeDelivery,
  type ProofInput,
  type RawRecord,
} from "./deliveryState.js";
import type { TelegramRepository } from "./deliveryTypes.js";
import { readProperty } from "./values.js";
export function createTelegramDeliveryRecovery({
  repository,
  now,
  control,
}: {
  repository: TelegramRepository;
  now: () => number;
  control: Pick<TelegramDeliveryControl, "transact">;
}) {
  const { transact } = control;
  const applySafeRetryProof = async (
    messageKey: string,
    {
      requestedRevision,
      safeRejectedAttemptId,
      retryStartedAtMs,
      retryDeadlineAtMs,
      retryAtMs,
      retrySequence,
    }: ProofInput,
  ) => {
    const normalizedAttemptId = normalizeString(safeRejectedAttemptId);
    const normalizedRevision = normalizeString(requestedRevision);
    if (!normalizedAttemptId || !normalizedRevision) {
      return { applied: false };
    }
    let applied = false;
    const result = await transact(messageKey, (record) => {
      const delivery = readDelivery(record.delivery);
      const marker = asObject(delivery.sendInFlight);
      if (
        normalizeString(marker.attemptId) !== normalizedAttemptId ||
        normalizeString(marker.revision) !== normalizedRevision
      ) {
        return { commit: false, decision: "stale-safe-retry-proof" };
      }
      const latestRevision = normalizeString(
        readProperty(record.desired, "revision"),
      );
      const proofRetryState = {
        retryStartedAtMs: normalizeTimestamp(retryStartedAtMs),
        retryDeadlineAtMs: normalizeTimestamp(retryDeadlineAtMs),
        retryAtMs: normalizeTimestamp(retryAtMs),
        retrySequence: normalizeRetrySequence(retrySequence),
      };
      const proofIsComplete =
        proofRetryState.retryStartedAtMs > 0 &&
        proofRetryState.retryDeadlineAtMs > 0 &&
        proofRetryState.retryAtMs > 0;
      applied = true;
      return {
        value: {
          ...record,
          delivery: writeDelivery({
            ...omitKeys(delivery, [
              "leaseOwner",
              "leaseExpiresAtMs",
              "sendInFlight",
              "lastError",
              "apiGateProofRequired",
            ]),
            ...(latestRevision === normalizedRevision && proofIsComplete
              ? {
                  status: "retryable" as const,
                  revision: latestRevision || normalizedRevision,
                  attempts: normalizeAttempts(delivery.attempts),
                  ...proofRetryState,
                }
              : {
                  status: "pending" as const,
                  revision: latestRevision || normalizedRevision,
                  attempts:
                    latestRevision === normalizedRevision
                      ? normalizeAttempts(delivery.attempts)
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
    messageKey: string,
    {
      requestedRevision,
      safeRejectedAttemptId,
      retryStartedAtMs,
      retryDeadlineAtMs,
      retryAtMs,
      retrySequence,
      retryProofLeaseOwner,
      apiGateReclaimOwner,
    }: ProofInput,
  ) => {
    if (normalizeString(safeRejectedAttemptId)) {
      return { applied: false };
    }
    const normalizedRevision = normalizeString(requestedRevision);
    const proofRetryState = {
      retryStartedAtMs: normalizeTimestamp(retryStartedAtMs),
      retryDeadlineAtMs: normalizeTimestamp(retryDeadlineAtMs),
      retryAtMs: normalizeTimestamp(retryAtMs),
      retrySequence: normalizeRetrySequence(retrySequence),
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
      const delivery = readDelivery(record.delivery);
      if (
        normalizeString(readProperty(record.desired, "revision")) !==
          normalizedRevision ||
        !delivery.matchesRevision(normalizedRevision) ||
        delivery.status !== "processing" ||
        delivery.sendInFlight ||
        !normalizeString(retryProofLeaseOwner) ||
        normalizeString(delivery.leaseOwner) !==
          normalizeString(retryProofLeaseOwner) ||
        proofRetryState.retrySequence <=
          normalizeRetrySequence(delivery.retrySequence)
      ) {
        return { commit: false, decision: "stale-retry-window-proof" };
      }
      applied = true;
      const preservesApiGate =
        normalizeString(apiGateReclaimOwner) !== "" &&
        normalizeString(delivery.apiGateOwner) ===
          normalizeString(apiGateReclaimOwner);
      return {
        value: {
          ...record,
          delivery: writeDelivery({
            ...omitKeys(delivery, [
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
  const applyManualRecovery = async (messageKey: string) => {
    const processedAtMs = now();
    const result = await transact(messageKey, (record) => {
      const request = asObject(record.manualRecovery);
      const requestId = normalizeString(request.requestId);
      const delivery = readDelivery(record.delivery);
      if (
        !requestId ||
        normalizeString(delivery.lastRecoveryRequestId) === requestId
      ) {
        return { commit: false, decision: "no-manual-recovery" };
      }
      const action = normalizeString(request.action);
      const marker = asObject(delivery.sendInFlight);
      const markerAttemptId = normalizeString(marker.attemptId);
      const markerApiGateOwner = normalizeString(marker.apiGateOwner);
      const recoverable =
        delivery.status === "uncertain" && markerAttemptId !== "";
      const latestRevision = normalizeString(
        readProperty(record.desired, "revision"),
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
          delivery: writeDelivery({
            ...omitRetryState(
              omitKeys(baseDelivery, [
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
          destination: normalizeString(marker.destination),
          chatId: normalizeString(marker.chatId),
          messageId: Number(request.messageId),
          instanceKey: normalizeString(marker.instanceKey),
          revision: normalizeString(marker.revision),
          contentHash: normalizeString(marker.contentHash),
          appliedAtMs: processedAtMs,
          recoveredAtMs: processedAtMs,
        };
        let recoveredDelivery: RawRecord = writeDelivery({
          ...omitRetryState(
            omitKeys(baseDelivery, [
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
        const previousApplied = asObject(record.applied);
        const previousChatId =
          normalizeString(previousApplied.chatId) || recoveredApplied.chatId;
        if (
          typeof previousApplied.messageId === "number" &&
          Number.isInteger(previousApplied.messageId) &&
          previousApplied.messageId > 0 &&
          (previousApplied.messageId !== recoveredApplied.messageId ||
            previousChatId !== recoveredApplied.chatId)
        ) {
          const pendingDelete = writeCleanup({
            chatId: previousChatId,
            messageId: previousApplied.messageId,
            instanceKey: normalizeString(previousApplied.instanceKey),
            pendingDeleteId: buildPendingDeleteId({
              chatId: previousChatId,
              messageId: previousApplied.messageId,
            }),
            status: "pending",
            attempts: 0,
          });
          recoveredDelivery = appendPendingDelete(
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
          delivery: writeDelivery({
            ...omitRetryState(
              omitKeys(baseDelivery, [
                "leaseOwner",
                "leaseExpiresAtMs",
                "sendInFlight",
                "uncertainAtMs",
                "uncertainReason",
              ]),
            ),
            status: "terminal",
            revision: latestRevision || normalizeString(delivery.revision),
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
    const recoveryResult = asObject(result.value?.manualRecoveryResult);
    const processed =
      result.committed && normalizeString(recoveryResult.requestId) !== "";
    const action = normalizeString(recoveryResult.action);
    const apiGateReleaseOwner = normalizeString(
      readProperty(result.value?.delivery, "apiGateReleaseOwner"),
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
  const settleManualApiGateRelease = async (
    messageKey: string,
    ownerInput: unknown,
  ) => {
    const owner = normalizeString(ownerInput);
    if (!owner) {
      return;
    }
    await repository.releaseApiGate(owner);
    ensureCommitted(
      await transact(messageKey, (record) => {
        const delivery = readDelivery(record.delivery);
        if (normalizeString(delivery.apiGateReleaseOwner) !== owner) {
          return { commit: false, decision: "manual-gate-release-settled" };
        }
        return {
          value: {
            ...record,
            delivery: omitKeys(delivery, ["apiGateReleaseOwner"]),
          },
          decision: "manual-gate-release-settled",
        };
      }),
      "manual-gate-release-finalization-failed",
    );
  };
  const applyPendingDeleteRetryWindowProof = async (
    messageKey: string,
    {
      pendingDeleteId,
      retryStartedAtMs,
      retryDeadlineAtMs,
      retryAtMs,
      retrySequence,
      retryProofLeaseOwner,
      apiGateReclaimOwner,
    }: ProofInput,
  ) => {
    const normalizedPendingDeleteId = normalizeString(pendingDeleteId);
    const proofRetryState = {
      retryStartedAtMs: normalizeTimestamp(retryStartedAtMs),
      retryDeadlineAtMs: normalizeTimestamp(retryDeadlineAtMs),
      retryAtMs: normalizeTimestamp(retryAtMs),
      retrySequence: normalizeRetrySequence(retrySequence),
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
      const delivery = readDelivery(record.delivery);
      const pendingDelete = readPendingDelete(delivery.pendingDelete);
      if (
        resolvePendingDeleteId(pendingDelete) !== normalizedPendingDeleteId ||
        pendingDelete.status !== "processing" ||
        !normalizeString(retryProofLeaseOwner) ||
        normalizeString(pendingDelete.leaseOwner) !==
          normalizeString(retryProofLeaseOwner) ||
        proofRetryState.retrySequence <=
          normalizeRetrySequence(pendingDelete.retrySequence)
      ) {
        return {
          commit: false,
          decision: "stale-pending-delete-retry-window-proof",
        };
      }
      applied = true;
      const preservesApiGate =
        normalizeString(apiGateReclaimOwner) !== "" &&
        normalizeString(pendingDelete.apiGateOwner) ===
          normalizeString(apiGateReclaimOwner);
      return {
        value: {
          ...record,
          delivery: {
            ...delivery.source,
            pendingDelete: writeCleanup({
              ...omitKeys(pendingDelete, [
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
export type TelegramDeliveryRecovery = ReturnType<
  typeof createTelegramDeliveryRecovery
>;
