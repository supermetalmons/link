import type { TransactionDecision } from "../transactions.js";

import type {
  TelegramRetryFailure,
  TelegramRetryState,
} from "./deliveryRetryTypes.js";
import {
  normalizeString,
  omitKeys,
  preserveSendEvidence,
  readDelivery,
  readPendingDelete,
  validateDesiredForDelivery,
  writeDelivery,
  DeliverySnapshot,
  type DesiredAcquireDecision,
  type AppliedReceiptAction,
  type FinishStatusInput,
  type DeliveryTransition,
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

import { readProperty } from "./values.js";
import type { TelegramMessageDocument } from "./records.js";
type RawRecord = Record<string, unknown>;

type AcquireDesiredRecordInput = {
  leaseTtlMs: number;
  nowMs: number;
  ownerToken: string;
  observeDecision(decision: DesiredAcquireDecision): void;
};
export function acquireDesiredRecord(
  current: TelegramMessageDocument,
  input: AcquireDesiredRecordInput,
): TransactionDecision<TelegramMessageDocument> {
  const { leaseTtlMs, nowMs, ownerToken, observeDecision } = input;
  const apply = (record: RawRecord) => {
    let acquireDecision: DesiredAcquireDecision = "missing";

    const desired = asObject(record.desired);
    const delivery = readDelivery(record.delivery);
    const desiredRevision = normalizeString(desired.revision);
    const leaseExpiresAtMs = Number(delivery.leaseExpiresAtMs) || 0;
    if (normalizeString(delivery.apiGateSettleOwner)) {
      acquireDecision = "desired-api-gate-settle-pending";
      observeDecision(acquireDecision);
      return { commit: false, decision: acquireDecision };
    }
    if (normalizeString(delivery.pendingDeleteApiGateSettleOwner)) {
      acquireDecision = "pending-api-gate-settle-pending";
      observeDecision(acquireDecision);
      return { commit: false, decision: acquireDecision };
    }
    if (
      delivery.status === "processing" &&
      normalizeString(delivery.leaseOwner) !== ownerToken &&
      leaseExpiresAtMs > nowMs
    ) {
      acquireDecision = "locked";
      observeDecision(acquireDecision);
      return { commit: false, decision: acquireDecision };
    }
    const currentApiGateOwner =
      normalizeString(delivery.apiGateOwner) ||
      normalizeString(readProperty(delivery.sendInFlight, "apiGateOwner"));
    const currentProofGateOwner = normalizeString(
      readProperty(delivery.apiGateProofRequired, "owner"),
    );
    if (currentApiGateOwner && currentApiGateOwner === currentProofGateOwner) {
      acquireDecision = "rate-limit-proof-pending";
      observeDecision(acquireDecision);
      return { commit: false, decision: acquireDecision };
    }
    const pendingDelete = readPendingDelete(delivery.pendingDelete);
    const pendingApiGateOwner = normalizeString(pendingDelete.apiGateOwner);
    const pendingProofGateOwner = normalizeString(
      readProperty(pendingDelete.apiGateProofRequired, "owner"),
    );
    if (pendingApiGateOwner && pendingApiGateOwner === pendingProofGateOwner) {
      acquireDecision = "pending-rate-limit-proof-pending";
      observeDecision(acquireDecision);
      return { commit: false, decision: acquireDecision };
    }
    if (
      pendingApiGateOwner &&
      pendingDelete.status === "processing" &&
      normalizeTimestamp(pendingDelete.leaseExpiresAtMs) <= nowMs
    ) {
      acquireDecision = "pending-api-gate-settle-pending";
      observeDecision(acquireDecision);
      return {
        value: {
          ...record,
          delivery: {
            ...deliveryDocument(delivery),
            pendingDelete: omitKeys(pendingDelete, [
              "apiGateOwner",
              "apiGateGeneration",
            ]),
            pendingDeleteApiGateSettleOwner: pendingApiGateOwner,
          },
        },
        decision: acquireDecision,
      };
    }
    if (delivery.hasSendInFlight) {
      const sendInFlight = asObject(delivery.sendInFlight);
      const sendApiGateOwner = normalizeString(sendInFlight.apiGateOwner);
      const revision =
        desiredRevision || normalizeString(delivery.revision) || "invalid";
      acquireDecision = "in-flight-uncertain";
      observeDecision(acquireDecision);
      if (delivery.status === "uncertain") {
        if (normalizeString(delivery.revision) === revision) {
          return { commit: false, decision: acquireDecision };
        }
        return {
          value: {
            ...record,
            delivery: writeDelivery({
              ...deliveryDocument(delivery),
              status: "uncertain",
              revision,
              attempts: 0,
              sendInFlight: preserveSendEvidence(sendInFlight),
            }),
          },
          decision: acquireDecision,
        };
      }
      return {
        value: {
          ...record,
          delivery: writeDelivery({
            ...omitKeys(delivery, [
              "leaseOwner",
              "leaseExpiresAtMs",
              "retryAtMs",
            ]),
            status: "uncertain",
            revision,
            uncertainAtMs: nowMs,
            uncertainReason: "abandoned-send-in-flight",
            sendInFlight: preserveSendEvidence(sendInFlight),
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
    if (!validateDesiredForDelivery(desired)) {
      acquireDecision = "invalid";
      observeDecision(acquireDecision);
      const apiGateOwner = normalizeString(delivery.apiGateOwner);
      const proofGateOwner = normalizeString(
        readProperty(delivery.apiGateProofRequired, "owner"),
      );
      const shouldSettleApiGate =
        apiGateOwner && apiGateOwner !== proofGateOwner;
      return {
        value: {
          ...record,
          delivery: writeDelivery({
            ...omitRetryState(
              omitKeys(delivery, [
                "leaseOwner",
                "leaseExpiresAtMs",
                "lastError",
                ...(shouldSettleApiGate
                  ? ["apiGateOwner", "apiGateGeneration", "apiGateStartedAtMs"]
                  : []),
              ]),
            ),
            ...(shouldSettleApiGate
              ? { apiGateSettleOwner: apiGateOwner }
              : {}),
            status: "terminal",
            revision: desiredRevision || "invalid",
            attempts: normalizeAttempts(delivery.attempts),
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
      ["pending", "processing", "retryable"].includes(
        delivery.status as string,
      ) &&
      resolveRetryDeadlineAtMs(delivery) > 0 &&
      resolveRetryDeadlineAtMs(delivery) <= nowMs
    ) {
      acquireDecision = "retry-exhausted";
      observeDecision(acquireDecision);
      const apiGateOwner = normalizeString(delivery.apiGateOwner);
      const proofGateOwner = normalizeString(
        readProperty(delivery.apiGateProofRequired, "owner"),
      );
      const shouldSettleApiGate =
        apiGateOwner && apiGateOwner !== proofGateOwner;
      return {
        value: {
          ...record,
          delivery: writeDelivery({
            ...omitRetryState(
              omitKeys(delivery, [
                "leaseOwner",
                "leaseExpiresAtMs",
                "sendInFlight",
                ...(shouldSettleApiGate
                  ? ["apiGateOwner", "apiGateGeneration", "apiGateStartedAtMs"]
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
      observeDecision(acquireDecision);
      return { commit: false, decision: acquireDecision };
    }
    if (
      delivery.revision === revision &&
      (delivery.status === "terminal" ||
        delivery.status === "uncertain" ||
        delivery.status === "delivered")
    ) {
      acquireDecision = "settled";
      observeDecision(acquireDecision);
      return { commit: false, decision: acquireDecision };
    }
    const deliveryForAcquire = delivery;
    acquireDecision = "acquired";
    observeDecision(acquireDecision);
    const sameRevision = deliveryForAcquire.revision === revision;
    const proofRequiredOwner = normalizeString(
      readProperty(deliveryForAcquire.apiGateProofRequired, "owner"),
    );
    const previousApiGateOwner = normalizeString(
      deliveryForAcquire.apiGateOwner,
    );
    const supersededApiGateOwner =
      normalizeString(deliveryForAcquire.apiGateSettleOwner) ||
      (sameRevision || previousApiGateOwner === proofRequiredOwner
        ? ""
        : previousApiGateOwner);
    const deliveryForRevision = sameRevision
      ? deliveryForAcquire
      : omitRetryState(
          omitKeys(deliveryForAcquire, [
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
        delivery: writeDelivery({
          ...omitKeys(deliveryForRevision, [
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
            ? normalizeAttempts(deliveryForRevision.attempts) + 1
            : 1,
          leaseOwner: ownerToken,
          leaseExpiresAtMs: nowMs + leaseTtlMs,
          startedAtMs: nowMs,
        }),
      },
      decision: acquireDecision,
    };
  };
  const output: unknown = apply(asObject(current));
  return output as TransactionDecision<TelegramMessageDocument>;
}

type FinishDesiredRecordInput = {
  apiGateSettleOwner: FinishStatusInput["apiGateSettleOwner"];
  clearAppliedStateUnknown: boolean;
  desired: { readonly revision: string };
  nowMs: number;
  receipt: AppliedReceiptAction | undefined;
  result: TelegramRetryFailure | undefined;
  status: FinishStatusInput["status"];
};
export function finishDesiredRecord(
  current: TelegramMessageDocument,
  delivery: DeliverySnapshot,
  input: FinishDesiredRecordInput,
): TelegramMessageDocument {
  const {
    apiGateSettleOwner,
    clearAppliedStateUnknown,
    desired,
    nowMs,
    receipt,
    result,
    status,
  } = input;
  const apply = (record: RawRecord) => {
    const latestRevision = normalizeString(
      readProperty(record.desired, "revision"),
    );
    const desiredStillLatest = latestRevision === desired.revision;
    const revision = desiredStillLatest ? desired.revision : latestRevision;
    const transition: DeliveryTransition =
      status === "uncertain"
        ? {
            status,
            revision,
            sendInFlight: delivery.preservedSendInFlight(),
          }
        : !desiredStillLatest
          ? { status: "pending", revision }
          : status === "delivered"
            ? { status, revision, deliveredAtMs: nowMs }
            : { status, revision };
    const nextDelivery = asObject(
      writeDelivery({
        ...omitRetryState(
          omitKeys(delivery, [
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
        ...(normalizeString(apiGateSettleOwner)
          ? { apiGateSettleOwner: apiGateSettleOwner as string }
          : {}),
      }),
    );
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
      nextDelivery.lastError = buildErrorState(result, nowMs);
    }
    if (status === "uncertain") {
      nextDelivery.uncertainAtMs = nowMs;
      nextDelivery.uncertainReason =
        normalizeString(result?.code) || "ambiguous-send";
    }
    if (
      desiredStillLatest &&
      status === "terminal" &&
      result?.code === "safe-retry-window-exhausted"
    ) {
      nextDelivery.deadLetterAtMs = nowMs;
    }
    const nextRecord: RawRecord = {
      ...record,
      delivery: nextDelivery,
    };
    if (receipt?.kind === "clear") {
      delete nextRecord.applied;
    } else if (receipt?.kind === "set") {
      nextRecord.applied = receipt.value;
    }
    return nextRecord;
  };
  const output: unknown = apply(asObject(current));
  return output as TelegramMessageDocument;
}

type RecordDesiredRetryProofInput = {
  apiGateOwner: string;
  barrierRetryNotBeforeMs: number;
  desired: { readonly revision: string };
  ownerToken: string;
  pendingDeleteId: string;
  proofTaskKind: "desired" | "pending-delete";
  retryState: TelegramRetryState;
  safeRejectedAttemptId: string;
};
export function recordDesiredRetryProof(
  current: TelegramMessageDocument,
  delivery: DeliverySnapshot,
  input: RecordDesiredRetryProofInput,
): TelegramMessageDocument {
  const {
    apiGateOwner,
    barrierRetryNotBeforeMs,
    desired,
    ownerToken,
    pendingDeleteId,
    proofTaskKind,
    retryState,
    safeRejectedAttemptId,
  } = input;
  const apply = (record: RawRecord) => ({
    ...record,
    delivery: {
      ...deliveryDocument(delivery),
      apiGateProofRequired: {
        owner: apiGateOwner,
        retryNotBeforeMs: barrierRetryNotBeforeMs,
        revision: desired.revision,
        proofTaskKind,
        ...retryState,
        ...(safeRejectedAttemptId ? { safeRejectedAttemptId } : {}),
        ...(pendingDeleteId ? { pendingDeleteId } : {}),
        ...(!safeRejectedAttemptId ? { retryProofLeaseOwner: ownerToken } : {}),
      },
    },
  });
  const output: unknown = apply(asObject(current));
  return output as TelegramMessageDocument;
}

type RecordDesiredRetryStateInput = {
  desired: { readonly revision: string };
  finalizedAtMs: number;
  preserveApiGateIdentity: boolean;
  result: TelegramRetryFailure | undefined;
  retryState: TelegramRetryState;
};
export function recordDesiredRetryState(
  current: TelegramMessageDocument,
  delivery: DeliverySnapshot,
  input: RecordDesiredRetryStateInput,
): TelegramMessageDocument {
  const {
    desired,
    finalizedAtMs,
    preserveApiGateIdentity,
    result,
    retryState,
  } = input;
  const apply = (record: RawRecord) => {
    const latestRevision = normalizeString(
      readProperty(record.desired, "revision"),
    );
    const desiredStillLatest = latestRevision === desired.revision;
    return {
      ...record,
      delivery: writeDelivery({
        ...omitRetryState(
          omitKeys(delivery, [
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
              status: "retryable" as const,
              revision: desired.revision,
              attempts: normalizeAttempts(delivery.attempts),
              ...retryState,
            }
          : {
              status: "pending" as const,
              revision: latestRevision,
              attempts: 0,
            }),
        ...(desiredStillLatest
          ? {
              lastError: buildErrorState(result, finalizedAtMs),
              ...(result?.code === "rate-limited"
                ? { safeRejectionAtMs: finalizedAtMs }
                : {}),
            }
          : {}),
      }),
    };
  };
  const output: unknown = apply(asObject(current));
  return output as TelegramMessageDocument;
}

type MarkAppliedStateUnknownRecordInput = {
  apiGateOwner: string;
  desired: { readonly revision: string };
  markedAtMs: number;
  operation: "edit" | "delete";
};
export function markAppliedStateUnknownRecord(
  current: TelegramMessageDocument,
  delivery: DeliverySnapshot,
  input: MarkAppliedStateUnknownRecordInput,
): TelegramMessageDocument {
  const { apiGateOwner, desired, markedAtMs, operation } = input;
  const apply = (record: RawRecord) => ({
    ...record,
    delivery: {
      ...deliveryDocument(delivery),
      appliedStateUnknown: {
        revision: desired.revision,
        operation,
        apiGateOwner,
        markedAtMs,
      },
    },
  });
  const output: unknown = apply(asObject(current));
  return output as TelegramMessageDocument;
}

type ClearMissingAppliedRecordInput = {
  apiGateOwner: string;
};
export function clearMissingAppliedRecord(
  current: TelegramMessageDocument,
  delivery: DeliverySnapshot,
  input: ClearMissingAppliedRecordInput,
): TelegramMessageDocument {
  const { apiGateOwner } = input;
  const apply = (record: RawRecord) => {
    const nextRecord: RawRecord = {
      ...record,
      delivery: {
        ...omitKeys(delivery, [
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
  };
  const output: unknown = apply(asObject(current));
  return output as TelegramMessageDocument;
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
