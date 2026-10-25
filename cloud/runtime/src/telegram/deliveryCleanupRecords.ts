import type { TransactionDecision } from "../transactions.js";

import type {
  TelegramRetryFailure,
  TelegramRetryState,
} from "./deliveryRetryTypes.js";
import {
  buildApiGateOwner,
  normalizeString,
  omitKeys,
  promotePendingDeleteQueue,
  readDelivery,
  readPendingDelete,
  resolvePendingDeleteId,
  writeCleanup,
  type CleanupAcquireDecision,
  type FinishStatusInput,
  DeliverySnapshot,
  PendingDeleteSnapshot,
  deliveryDocument,
  pendingDeleteDocument,
} from "./deliveryState.js";
import {
  buildErrorState,
  normalizeAttempts,
  normalizeTimestamp,
  omitRetryState,
  resolveRetryDeadlineAtMs,
} from "./deliveryPolicy.js";
import { TELEGRAM_PENDING_DELETE_TASK_KIND } from "./taskKinds.js";
import { readProperty } from "./values.js";
import type { TelegramMessageDocument } from "./records.js";
type RawRecord = Record<string, unknown>;

type OrphanPendingDeleteRecordInput = {
  apiGateSettleOwner: FinishStatusInput["apiGateSettleOwner"];
  nowMs: number;
  ownerToken: string;
  pendingDeleteId: string;
  result: TelegramRetryFailure | undefined;
};
export function orphanPendingDeleteRecord(
  current: TelegramMessageDocument,
  input: OrphanPendingDeleteRecordInput,
): TransactionDecision<TelegramMessageDocument> {
  const { apiGateSettleOwner, nowMs, ownerToken, pendingDeleteId, result } =
    input;
  const apply = (record: RawRecord) => {
    const delivery = readDelivery(record.delivery);
    const pendingDelete = readPendingDelete(delivery.pendingDelete);
    if (
      normalizeString(pendingDelete.pendingDeleteId) !== pendingDeleteId ||
      (ownerToken && normalizeString(pendingDelete.leaseOwner) !== ownerToken)
    ) {
      return { commit: false, decision: "pending-delete-lost" };
    }
    const orphanedDeletes = asObject(delivery.orphanedDeletes);
    const nextDelivery = promotePendingDeleteQueue({
      ...omitKeys(delivery, ["pendingDelete"]),
      orphanedDeletes: {
        ...orphanedDeletes,
        [pendingDeleteId]: {
          ...omitRetryState(
            omitKeys(pendingDelete, [
              "leaseOwner",
              "leaseExpiresAtMs",
              "status",
            ]),
          ),
          terminalAtMs: nowMs,
          lastError: buildErrorState(result, nowMs),
        },
      },
    });
    return {
      value: {
        ...record,
        delivery: {
          ...nextDelivery,
          ...(normalizeString(apiGateSettleOwner)
            ? { pendingDeleteApiGateSettleOwner: apiGateSettleOwner }
            : {}),
        },
      },
      decision: "pending-delete-orphaned",
    };
  };
  const output: unknown = apply(asObject(current));
  return output as TransactionDecision<TelegramMessageDocument>;
}

type RecordCleanupRetryProofInput = {
  apiGateOwner: string;
  barrierRetryNotBeforeMs: number;
  ownerToken: string;
  pendingDeleteId: string;
  retryState: TelegramRetryState;
  revision: string;
};
export function recordCleanupRetryProof(
  current: TelegramMessageDocument,
  input: RecordCleanupRetryProofInput,
): TransactionDecision<TelegramMessageDocument> {
  const {
    apiGateOwner,
    barrierRetryNotBeforeMs,
    ownerToken,
    pendingDeleteId,
    retryState,
    revision,
  } = input;
  const apply = (record: RawRecord) => {
    const delivery = readDelivery(record.delivery);
    const latestPendingDelete = readPendingDelete(delivery.pendingDelete);
    if (
      normalizeString(latestPendingDelete.pendingDeleteId) !==
        pendingDeleteId ||
      normalizeString(latestPendingDelete.leaseOwner) !== ownerToken
    ) {
      return { commit: false, decision: "pending-delete-lost" };
    }
    return {
      value: {
        ...record,
        delivery: {
          ...deliveryDocument(delivery),
          pendingDelete: {
            ...pendingDeleteDocument(latestPendingDelete),
            apiGateProofRequired: {
              owner: apiGateOwner,
              retryNotBeforeMs: barrierRetryNotBeforeMs,
              revision,
              proofTaskKind: TELEGRAM_PENDING_DELETE_TASK_KIND,
              pendingDeleteId,
              retryProofLeaseOwner: ownerToken,
              ...retryState,
            },
          },
        },
      },
      decision: "pending-rate-limit-proof-required",
    };
  };
  const output: unknown = apply(asObject(current));
  return output as TransactionDecision<TelegramMessageDocument>;
}

type RecordCleanupRetryStateInput = {
  finalizedAtMs: number;
  ownerToken: string;
  pendingDeleteId: string;
  preserveApiGateIdentity: boolean;
  result: TelegramRetryFailure | undefined;
  retryState: TelegramRetryState;
};
export function recordCleanupRetryState(
  current: TelegramMessageDocument,
  input: RecordCleanupRetryStateInput,
): TransactionDecision<TelegramMessageDocument> {
  const {
    finalizedAtMs,
    ownerToken,
    pendingDeleteId,
    preserveApiGateIdentity,
    result,
    retryState,
  } = input;
  const apply = (record: RawRecord) => {
    const delivery = readDelivery(record.delivery);
    const latestPendingDelete = readPendingDelete(delivery.pendingDelete);
    if (
      normalizeString(latestPendingDelete.pendingDeleteId) !==
        pendingDeleteId ||
      normalizeString(latestPendingDelete.leaseOwner) !== ownerToken
    ) {
      return { commit: false, decision: "pending-delete-lost" };
    }
    return {
      value: {
        ...record,
        delivery: {
          ...deliveryDocument(delivery),
          pendingDelete: writeCleanup({
            ...omitRetryState(
              omitKeys(latestPendingDelete, [
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
            lastError: buildErrorState(result, finalizedAtMs),
          }),
        },
      },
      decision: "pending-delete-retryable",
    };
  };
  const output: unknown = apply(asObject(current));
  return output as TransactionDecision<TelegramMessageDocument>;
}

type AcquirePendingDeleteRecordInput = {
  leaseTtlMs: number;
  normalizedMessageKey: string;
  nowMs: number;
  ownerToken: string;
  requestedGeneration: string | undefined;
  requestedPendingDeleteId: string | undefined;
  observeDecision(decision: CleanupAcquireDecision): void;
};
export function acquirePendingDeleteRecord(
  current: TelegramMessageDocument,
  input: AcquirePendingDeleteRecordInput,
): TransactionDecision<TelegramMessageDocument> {
  const {
    leaseTtlMs,
    normalizedMessageKey,
    nowMs,
    ownerToken,
    requestedGeneration,
    requestedPendingDeleteId,
    observeDecision,
  } = input;
  const apply = (record: RawRecord) => {
    let decision: CleanupAcquireDecision = "missing";

    const delivery = readDelivery(record.delivery);
    const pendingDelete = readPendingDelete(delivery.pendingDelete);
    if (delivery.status === "uncertain" || delivery.hasSendInFlight) {
      decision = "blocked-uncertain";
      observeDecision(decision);
      return { commit: false, decision };
    }
    const chatId = pendingDelete.chatIdText;
    const messageId = pendingDelete.numericMessageId;
    if (!pendingDelete.present) {
      decision = "missing";
      observeDecision(decision);
      return { commit: false, decision };
    }
    const pendingDeleteId = resolvePendingDeleteId(pendingDelete);
    if (
      requestedPendingDeleteId &&
      requestedPendingDeleteId !== pendingDeleteId
    ) {
      decision = "stale";
      observeDecision(decision);
      return { commit: false, decision };
    }
    const currentApiGateOwner = normalizeString(pendingDelete.apiGateOwner);
    const currentProofGateOwner = normalizeString(
      readProperty(pendingDelete.apiGateProofRequired, "owner"),
    );
    if (currentApiGateOwner && currentApiGateOwner === currentProofGateOwner) {
      decision = "rate-limit-proof-pending";
      observeDecision(decision);
      return { commit: false, decision };
    }
    if (!chatId || !Number.isInteger(messageId) || messageId <= 0) {
      decision = "invalid";
      observeDecision(decision);
      const apiGateOwner = normalizeString(pendingDelete.apiGateOwner);
      const proofGateOwner = normalizeString(
        readProperty(pendingDelete.apiGateProofRequired, "owner"),
      );
      const shouldSettleApiGate =
        apiGateOwner && apiGateOwner !== proofGateOwner;
      const nextDelivery = promotePendingDeleteQueue({
        ...omitKeys(delivery, ["pendingDelete"]),
        orphanedDeletes: {
          ...asObject(delivery.orphanedDeletes),
          [pendingDeleteId]: {
            ...pendingDeleteDocument(pendingDelete),
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
    const retryDeadlineAtMs = resolveRetryDeadlineAtMs(pendingDelete);
    const leaseExpiresAtMs = normalizeTimestamp(pendingDelete.leaseExpiresAtMs);
    if (
      pendingDelete.status === "processing" &&
      normalizeString(pendingDelete.leaseOwner) !== ownerToken &&
      leaseExpiresAtMs > nowMs
    ) {
      decision = "locked";
      observeDecision(decision);
      return { commit: false, decision };
    }
    if (
      ["pending", "processing", "retryable"].includes(
        pendingDelete.status as string,
      ) &&
      retryDeadlineAtMs > 0 &&
      retryDeadlineAtMs <= nowMs
    ) {
      decision = "exhausted";
      observeDecision(decision);
      const apiGateOwner = normalizeString(pendingDelete.apiGateOwner);
      const proofGateOwner = normalizeString(
        readProperty(pendingDelete.apiGateProofRequired, "owner"),
      );
      const shouldSettleApiGate =
        apiGateOwner && apiGateOwner !== proofGateOwner;
      const nextDelivery = promotePendingDeleteQueue({
        ...omitKeys(delivery, ["pendingDelete"]),
        orphanedDeletes: {
          ...asObject(delivery.orphanedDeletes),
          [pendingDeleteId]: {
            ...omitRetryState(pendingDeleteDocument(pendingDelete)),
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
      normalizeTimestamp(pendingDelete.retryAtMs) > nowMs
    ) {
      decision = "deferred";
      observeDecision(decision);
      return { commit: false, decision };
    }
    decision = "acquired";
    observeDecision(decision);
    const apiGateGeneration =
      normalizeString(pendingDelete.apiGateGeneration) ||
      normalizeString(requestedGeneration) ||
      `direct:${pendingDeleteId}`;
    return {
      value: {
        ...record,
        delivery: {
          ...deliveryDocument(delivery),
          pendingDelete: writeCleanup({
            ...pendingDeleteDocument(pendingDelete),
            pendingDeleteId,
            status: "processing",
            attempts: normalizeAttempts(pendingDelete.attempts) + 1,
            leaseOwner: ownerToken,
            leaseExpiresAtMs: nowMs + leaseTtlMs,
            startedAtMs: nowMs,
            apiGateOwner:
              normalizeString(pendingDelete.apiGateOwner) ||
              buildApiGateOwner(
                normalizedMessageKey,
                "pending-delete",
                pendingDeleteId,
                apiGateGeneration,
              ),
            apiGateGeneration,
            apiGateStartedAtMs:
              normalizeTimestamp(pendingDelete.apiGateStartedAtMs) || nowMs,
          }),
        },
      },
      decision,
    };
  };
  const output: unknown = apply(asObject(current));
  return output as TransactionDecision<TelegramMessageDocument>;
}

type ClearPendingDeleteRecordInput = {
  apiGateOwner: string;
  ownerToken: string;
  pendingDeleteId: string;
};
export function clearPendingDeleteRecord(
  current: TelegramMessageDocument,
  input: ClearPendingDeleteRecordInput,
): TransactionDecision<TelegramMessageDocument> {
  const { apiGateOwner, ownerToken, pendingDeleteId } = input;
  const apply = (record: RawRecord) => {
    const delivery = readDelivery(record.delivery);
    const latestPendingDelete = readPendingDelete(delivery.pendingDelete);
    if (
      normalizeString(latestPendingDelete.pendingDeleteId) !==
        pendingDeleteId ||
      normalizeString(latestPendingDelete.leaseOwner) !== ownerToken
    ) {
      return { commit: false, decision: "pending-delete-lost" };
    }
    return {
      value: {
        ...record,
        delivery: {
          ...promotePendingDeleteQueue(delivery),
          pendingDeleteApiGateSettleOwner: apiGateOwner,
        },
      },
      decision: "pending-delete-cleared",
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
