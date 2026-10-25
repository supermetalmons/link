import type { TransactionResult } from "../transactions.js";
import {
  messageRecoveryResultDocument,
  messageDeliveryDocument,
} from "./records.js";
import type { TelegramProofApplicationDocument } from "./retryRecords.js";
import { sendEvidenceDocument } from "./records.js";
import type { TransactionDecision } from "../transactions.js";

import type { TelegramRetryState } from "./deliveryRetryTypes.js";
import {
  appendPendingDelete,
  buildPendingDeleteId,
  normalizeString,
  omitKeys,
  readDelivery,
  readPendingDelete,
  resolvePendingDeleteId,
  writeCleanup,
  writeDelivery,
  DeliverySnapshot,
  PendingDeleteSnapshot,
  deliveryDocument,
  pendingDeleteDocument,
} from "./deliveryState.js";
import {
  normalizeAttempts,
  normalizeRetrySequence,
  normalizeTimestamp,
  omitRetryState,
} from "./deliveryPolicy.js";

import { readProperty } from "./values.js";
import type { TelegramMessageDocument } from "./records.js";
type RawRecord = Record<string, unknown>;

type ApplySafeRetryProofRecordInput = {
  normalizedAttemptId: string;
  normalizedRevision: string;
  now: () => number;
  markApplied(): void;
  application: TelegramProofApplicationDocument;
};
export function applySafeRetryProofRecord(
  current: TelegramMessageDocument,
  input: ApplySafeRetryProofRecordInput,
): TransactionDecision<TelegramMessageDocument> {
  const {
    normalizedAttemptId,
    normalizedRevision,
    now,
    application,
    markApplied,
  } = input;
  const { retryAtMs, retryDeadlineAtMs, retrySequence, retryStartedAtMs } =
    asObject(application);
  const apply = (record: RawRecord) => {
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
    markApplied();
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
  };
  const output: unknown = apply(asObject(current));
  return output as TransactionDecision<TelegramMessageDocument>;
}

type ApplyDesiredRetryProofRecordInput = {
  normalizedRevision: string;
  now: () => number;
  proofRetryState: TelegramRetryState;
  markApplied(): void;
  application: TelegramProofApplicationDocument;
};
export function applyDesiredRetryProofRecord(
  current: TelegramMessageDocument,
  input: ApplyDesiredRetryProofRecordInput,
): TransactionDecision<TelegramMessageDocument> {
  const { normalizedRevision, now, proofRetryState, application, markApplied } =
    input;
  const { apiGateReclaimOwner, retryProofLeaseOwner } = asObject(application);
  const apply = (record: RawRecord) => {
    const delivery = readDelivery(record.delivery);
    if (
      normalizeString(readProperty(record.desired, "revision")) !==
        normalizedRevision ||
      !delivery.matchesRevision(normalizedRevision) ||
      delivery.status !== "processing" ||
      delivery.hasSendInFlight ||
      !normalizeString(retryProofLeaseOwner) ||
      normalizeString(delivery.leaseOwner) !==
        normalizeString(retryProofLeaseOwner) ||
      proofRetryState.retrySequence <=
        normalizeRetrySequence(delivery.retrySequence)
    ) {
      return { commit: false, decision: "stale-retry-window-proof" };
    }
    markApplied();
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
  };
  const output: unknown = apply(asObject(current));
  return output as TransactionDecision<TelegramMessageDocument>;
}

type ApplyManualRecoveryRecordInput = {
  processedAtMs: number;
};
export function applyManualRecoveryRecord(
  current: TelegramMessageDocument,
  input: ApplyManualRecoveryRecordInput,
): TransactionDecision<TelegramMessageDocument> {
  const { processedAtMs } = input;
  const apply = (record: RawRecord) => {
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
      ...deliveryDocument(delivery),
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
                abandonedSend: sendEvidenceDocument({
                  ...marker,
                  abandonedAtMs: processedAtMs,
                }),
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
  };
  const output: unknown = apply(asObject(current));
  return output as TransactionDecision<TelegramMessageDocument>;
}

type SettleManualGateReleaseRecordInput = {
  owner: string;
};
export function settleManualGateReleaseRecord(
  current: TelegramMessageDocument,
  input: SettleManualGateReleaseRecordInput,
): TransactionDecision<TelegramMessageDocument> {
  const { owner } = input;
  const apply = (record: RawRecord) => {
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
  };
  const output: unknown = apply(asObject(current));
  return output as TransactionDecision<TelegramMessageDocument>;
}

type ApplyCleanupRetryProofRecordInput = {
  normalizedPendingDeleteId: string;
  now: () => number;
  proofRetryState: TelegramRetryState;
  markApplied(): void;
  application: TelegramProofApplicationDocument;
};
export function applyCleanupRetryProofRecord(
  current: TelegramMessageDocument,
  input: ApplyCleanupRetryProofRecordInput,
): TransactionDecision<TelegramMessageDocument> {
  const {
    normalizedPendingDeleteId,
    now,
    proofRetryState,
    application,
    markApplied,
  } = input;
  const { apiGateReclaimOwner, retryProofLeaseOwner } = asObject(application);
  const apply = (record: RawRecord) => {
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
    markApplied();
    const preservesApiGate =
      normalizeString(apiGateReclaimOwner) !== "" &&
      normalizeString(pendingDelete.apiGateOwner) ===
        normalizeString(apiGateReclaimOwner);
    return {
      value: {
        ...record,
        delivery: {
          ...deliveryDocument(delivery),
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
  };
  const output: unknown = apply(asObject(current));
  return output as TransactionDecision<TelegramMessageDocument>;
}

const asObject = (value: unknown): Record<string, unknown> => {
  const retained =
    value instanceof DeliverySnapshot
      ? deliveryDocument(value)
      : value instanceof PendingDeleteSnapshot
        ? pendingDeleteDocument(value)
        : value;
  return retained && typeof retained === "object" && !Array.isArray(retained)
    ? (retained as Record<string, unknown>)
    : {};
};

export function observeManualRecoveryResult(
  result: TransactionResult<TelegramMessageDocument>,
) {
  const recoveryResult = asObject(messageRecoveryResultDocument(result.value));
  const processed =
    result.committed && normalizeString(recoveryResult.requestId) !== "";
  const action = normalizeString(recoveryResult.action);
  const apiGateReleaseOwner = normalizeString(
    readProperty(messageDeliveryDocument(result.value), "apiGateReleaseOwner"),
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
}
