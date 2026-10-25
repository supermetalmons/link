import {
  normalizeRetrySequence,
  normalizeTimestamp,
} from "./deliveryPolicy.js";
import { normalizeOptionalTimestamp } from "./taskIdentity.js";
import {
  TELEGRAM_DESIRED_TASK_KIND,
  TELEGRAM_PENDING_DELETE_TASK_KIND,
  TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND,
} from "./taskKinds.js";
import { readProperty } from "./values.js";
import type {
  TelegramExactRetryInput,
  TelegramRetryState,
} from "./deliveryRetryTypes.js";
import type {
  TelegramReconcileInput,
  TelegramRetrySchedule,
} from "./deliveryTypes.js";
import {
  messageDeliveryDocument,
  type TelegramMessageDocument,
  type TelegramDeliveryDocument,
  type TelegramRetryProofDocument,
} from "./records.js";

declare const retainedRetry: unique symbol;
type RetainedRetry<Kind extends string> = { readonly [retainedRetry]: Kind };
export type RetainedTelegramExactRetryInput = RetainedRetry<"exact-input">;
export type RetainedTelegramRetrySchedule = RetainedRetry<"schedule">;
export type RetainedTelegramProofInput = RetainedRetry<"proof-input">;
export type TelegramProofApplicationDocument =
  RetainedRetry<"proof-application">;
export type RetainedTelegramBarrierInput = RetainedRetry<"barrier-input">;
export type RetainedTelegramOwner = RetainedRetry<"owner">;
export type TelegramProofInput = Partial<
  TelegramReconcileInput & { requestedPendingDeleteId: string }
>;
export type TelegramBarrierInput = {
  barrierProofOwner?: string;
  barrierRetryNotBeforeMs?: number;
};
type RetryStateEvidence = {
  retryStartedAtMs?: unknown;
  retryDeadlineAtMs?: unknown;
  retryAtMs?: unknown;
  retrySequence?: unknown;
};
type ExactRetryEvidence = RetryStateEvidence & {
  messageKey?: unknown;
  revision?: unknown;
  taskKind?: unknown;
  retryState?: RetryStateEvidence;
  safeRejectedAttemptId?: unknown;
  pendingDeleteId?: unknown;
  retryProofLeaseOwner?: unknown;
  sourceGeneration?: unknown;
  proofTaskKind?: unknown;
  barrierProofOwner?: unknown;
  barrierRetryNotBeforeMs?: unknown;
  scheduleTimeMs?: unknown;
  apiGateReclaimOwner?: unknown;
  apiGateSettleOwner?: unknown;
};
type ProofEvidence = RetryStateEvidence & {
  requestedRevision?: unknown;
  safeRejectedAttemptId?: unknown;
  pendingDeleteId?: unknown;
  retryProofLeaseOwner?: unknown;
  apiGateReclaimOwner?: unknown;
};
type ProofRecordEvidence = RetryStateEvidence & {
  owner?: unknown;
  retryNotBeforeMs?: unknown;
  revision?: unknown;
  safeRejectedAttemptId?: unknown;
  pendingDeleteId?: unknown;
  retryProofLeaseOwner?: unknown;
};
const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const proofFields = (
  value: TelegramRetryProofDocument,
): ProofRecordEvidence => {
  const retained: unknown = value;
  return retained as ProofRecordEvidence;
};
const applicationFields = (
  value: TelegramProofApplicationDocument,
): ProofEvidence => {
  const retained: unknown = value;
  return retained as ProofEvidence;
};
export const buildTelegramRetrySchedule: (
  input: TelegramExactRetryInput | RetainedTelegramExactRetryInput,
) => RetainedTelegramRetrySchedule = ({
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
}: ExactRetryEvidence & Partial<RetainedTelegramExactRetryInput>) => {
  const normalizedTaskKind =
    normalizeString(taskKind) || TELEGRAM_DESIRED_TASK_KIND;
  const retrySequence = normalizeRetrySequence(retryState!.retrySequence);
  const generation = [
    normalizedTaskKind,
    retrySequence,
    normalizeTimestamp(retryState!.retryAtMs),
    safeRejectedAttemptId || pendingDeleteId || revision,
    normalizeString(retryProofLeaseOwner),
    normalizeString(sourceGeneration),
    normalizeString(proofTaskKind),
    normalizeString(barrierProofOwner),
    normalizeTimestamp(barrierRetryNotBeforeMs),
    normalizeString(apiGateReclaimOwner),
    normalizeString(apiGateSettleOwner),
  ].join(":");
  const payload: unknown = {
    messageKey,
    revision,
    taskKind: normalizedTaskKind,
    retrySequence,
    generation,
    retryStartedAtMs: normalizeTimestamp(retryState!.retryStartedAtMs),
    retryDeadlineAtMs: normalizeTimestamp(retryState!.retryDeadlineAtMs),
    retryAtMs: normalizeTimestamp(retryState!.retryAtMs),
    scheduleTimeMs:
      normalizeTimestamp(scheduleTimeMs) ||
      normalizeTimestamp(retryState!.retryAtMs),
    ...(safeRejectedAttemptId ? { safeRejectedAttemptId } : {}),
    ...(pendingDeleteId ? { pendingDeleteId } : {}),
    ...(retryProofLeaseOwner ? { retryProofLeaseOwner } : {}),
    ...(proofTaskKind ? { proofTaskKind } : {}),
    ...(barrierProofOwner ? { barrierProofOwner } : {}),
    ...(barrierRetryNotBeforeMs ? { barrierRetryNotBeforeMs } : {}),
    ...(apiGateReclaimOwner ? { apiGateReclaimOwner } : {}),
    ...(apiGateSettleOwner ? { apiGateSettleOwner } : {}),
  };
  return payload as RetainedTelegramRetrySchedule;
};

export function telegramRetryScheduleTime(
  input: TelegramRetrySchedule | RetainedTelegramRetrySchedule,
): number {
  const retained: unknown = input;
  const value = retained as { scheduleTimeMs?: unknown };
  return normalizeOptionalTimestamp(value.scheduleTimeMs);
}

export function retainedRateLimitProof(
  value: unknown,
): TelegramRetryProofDocument {
  return value as TelegramRetryProofDocument;
}

export function messageRateLimitProof(
  value: TelegramDeliveryDocument,
  pending = false,
): TelegramRetryProofDocument {
  const source = pending ? readProperty(value, "pendingDelete") : value;
  const proof = readProperty(source, "apiGateProofRequired");
  return (
    proof && typeof proof === "object" && !Array.isArray(proof) ? proof : {}
  ) as TelegramRetryProofDocument;
}

export function readRateLimitRetryState(
  value: TelegramRetryProofDocument,
): TelegramRetryState {
  const proof = proofFields(value);
  return {
    retryStartedAtMs: normalizeTimestamp(proof.retryStartedAtMs),
    retryDeadlineAtMs: normalizeTimestamp(proof.retryDeadlineAtMs),
    retryAtMs: normalizeTimestamp(proof.retryAtMs),
    retrySequence: normalizeRetrySequence(proof.retrySequence),
  };
}

export function rateLimitProofRetryAt(
  value: TelegramRetryProofDocument,
): number {
  return normalizeTimestamp(proofFields(value).retryNotBeforeMs);
}

export function rateLimitProofOwner(
  value: TelegramRetryProofDocument,
): RetainedTelegramOwner {
  return proofFields(value).owner as RetainedTelegramOwner;
}

export function lockedDesiredRetryInput(
  delivery: TelegramMessageDocument | null,
  context: {
    messageKey: string;
    revision: string;
    retryAtMs: number;
    retryStartedAtMs: number;
    retryDeadlineAtMs: number;
    retrySequence: number;
    sourceGeneration?: string;
    apiGateReclaimOwner: string;
  },
): RetainedTelegramExactRetryInput {
  const input: unknown = {
    messageKey: context.messageKey,
    revision: context.revision,
    taskKind: TELEGRAM_DESIRED_TASK_KIND,
    retryState: {
      retryStartedAtMs:
        readProperty(messageDeliveryDocument(delivery), "retryStartedAtMs") ||
        context.retryStartedAtMs,
      retryDeadlineAtMs:
        readProperty(messageDeliveryDocument(delivery), "retryDeadlineAtMs") ||
        context.retryDeadlineAtMs,
      retryAtMs: context.retryAtMs,
      retrySequence:
        readProperty(messageDeliveryDocument(delivery), "retrySequence") ??
        context.retrySequence,
    },
    sourceGeneration: context.sourceGeneration,
    apiGateReclaimOwner: context.apiGateReclaimOwner,
  };
  return input as RetainedTelegramExactRetryInput;
}

export function deferredDesiredRetryInput(
  delivery: TelegramMessageDocument | null,
  context: {
    messageKey: string;
    revision: string;
    retryAtMs: number | null;
    sourceGeneration?: string;
  },
): RetainedTelegramExactRetryInput {
  const input: unknown = {
    messageKey: context.messageKey,
    revision: context.revision,
    taskKind: TELEGRAM_DESIRED_TASK_KIND,
    retryState: {
      retryStartedAtMs: readProperty(
        messageDeliveryDocument(delivery),
        "retryStartedAtMs",
      ),
      retryDeadlineAtMs: readProperty(
        messageDeliveryDocument(delivery),
        "retryDeadlineAtMs",
      ),
      retryAtMs: context.retryAtMs,
      retrySequence: readProperty(
        messageDeliveryDocument(delivery),
        "retrySequence",
      ),
    },
    sourceGeneration: context.sourceGeneration,
  };
  return input as RetainedTelegramExactRetryInput;
}

export type RateLimitProofTarget =
  | { kind: "desired" }
  | { kind: "pending-delete"; requestedPendingDeleteId?: string };
export function resumedRateLimitRetryInput(
  value: TelegramRetryProofDocument,
  context: {
    messageKey: string;
    requestedRevision?: string;
    nowMs: number;
    target: RateLimitProofTarget;
    retryState: TelegramRetryState;
  },
): RetainedTelegramExactRetryInput {
  const proof = proofFields(value);
  const target = context.target;
  const input: unknown = {
    messageKey: context.messageKey,
    revision:
      normalizeString(proof.revision) || context.requestedRevision || "latest",
    taskKind: TELEGRAM_RATE_LIMIT_PROOF_TASK_KIND,
    retryState: context.retryState,
    ...(target.kind === "desired"
      ? {
          safeRejectedAttemptId: normalizeString(proof.safeRejectedAttemptId),
          proofTaskKind: TELEGRAM_DESIRED_TASK_KIND,
        }
      : {
          pendingDeleteId:
            normalizeString(proof.pendingDeleteId) ||
            target.requestedPendingDeleteId ||
            "",
          proofTaskKind: TELEGRAM_PENDING_DELETE_TASK_KIND,
        }),
    retryProofLeaseOwner: normalizeString(proof.retryProofLeaseOwner),
    barrierProofOwner: proof.owner,
    barrierRetryNotBeforeMs: proof.retryNotBeforeMs,
    scheduleTimeMs: context.nowMs,
  };
  return input as RetainedTelegramExactRetryInput;
}

export function rateLimitBarrierInput(
  value: TelegramRetryProofDocument,
): RetainedTelegramBarrierInput {
  const proof = proofFields(value);
  const input: unknown = {
    barrierProofOwner: proof.owner,
    barrierRetryNotBeforeMs: proof.retryNotBeforeMs,
  };
  return input as RetainedTelegramBarrierInput;
}

export function desiredSafeProofInput(
  value: TelegramRetryProofDocument,
  state: TelegramRetryState,
): RetainedTelegramProofInput {
  const proof = proofFields(value);
  const input: unknown = {
    requestedRevision: proof.revision,
    safeRejectedAttemptId: proof.safeRejectedAttemptId,
    ...state,
  };
  return input as RetainedTelegramProofInput;
}

export function desiredWindowProofInput(
  value: TelegramRetryProofDocument,
  state: TelegramRetryState,
): RetainedTelegramProofInput {
  const proof = proofFields(value);
  const input: unknown = {
    requestedRevision: proof.revision,
    retryProofLeaseOwner: proof.retryProofLeaseOwner,
    ...state,
  };
  return input as RetainedTelegramProofInput;
}

export function cleanupWindowProofInput(
  value: TelegramRetryProofDocument,
  state: TelegramRetryState,
  target: Extract<RateLimitProofTarget, { kind: "pending-delete" }>,
): RetainedTelegramProofInput {
  const proof = proofFields(value);
  const input: unknown = {
    pendingDeleteId:
      target.requestedPendingDeleteId === undefined
        ? proof.pendingDeleteId
        : normalizeString(proof.pendingDeleteId) ||
          target.requestedPendingDeleteId,
    retryProofLeaseOwner: proof.retryProofLeaseOwner,
    ...state,
  };
  return input as RetainedTelegramProofInput;
}

export const captureSafeRetryProof: (
  input: TelegramProofInput | RetainedTelegramProofInput,
) => TelegramProofApplicationDocument = ({
  requestedRevision,
  safeRejectedAttemptId,
  retryStartedAtMs,
  retryDeadlineAtMs,
  retryAtMs,
  retrySequence,
}: ProofEvidence & Partial<RetainedTelegramProofInput>) => {
  const captured: unknown = {
    requestedRevision,
    safeRejectedAttemptId,
    retryStartedAtMs,
    retryDeadlineAtMs,
    retryAtMs,
    retrySequence,
  };
  return captured as TelegramProofApplicationDocument;
};
export const captureDesiredWindowProof: (
  input: TelegramProofInput | RetainedTelegramProofInput,
) => TelegramProofApplicationDocument = ({
  requestedRevision,
  safeRejectedAttemptId,
  retryStartedAtMs,
  retryDeadlineAtMs,
  retryAtMs,
  retrySequence,
  retryProofLeaseOwner,
  apiGateReclaimOwner,
}: ProofEvidence & Partial<RetainedTelegramProofInput>) => {
  const captured: unknown = {
    requestedRevision,
    safeRejectedAttemptId,
    retryStartedAtMs,
    retryDeadlineAtMs,
    retryAtMs,
    retrySequence,
    retryProofLeaseOwner,
    apiGateReclaimOwner,
  };
  return captured as TelegramProofApplicationDocument;
};
export const captureCleanupWindowProof: (
  input: TelegramProofInput | RetainedTelegramProofInput,
) => TelegramProofApplicationDocument = ({
  pendingDeleteId,
  retryStartedAtMs,
  retryDeadlineAtMs,
  retryAtMs,
  retrySequence,
  retryProofLeaseOwner,
  apiGateReclaimOwner,
}: ProofEvidence & Partial<RetainedTelegramProofInput>) => {
  const captured: unknown = {
    pendingDeleteId,
    retryStartedAtMs,
    retryDeadlineAtMs,
    retryAtMs,
    retrySequence,
    retryProofLeaseOwner,
    apiGateReclaimOwner,
  };
  return captured as TelegramProofApplicationDocument;
};

export function safeRetryProofIdentity(
  value: TelegramProofApplicationDocument,
): { normalizedAttemptId: string; normalizedRevision: string } {
  const proof = applicationFields(value);
  const normalizedAttemptId = normalizeString(proof.safeRejectedAttemptId);
  const normalizedRevision = normalizeString(proof.requestedRevision);
  return { normalizedAttemptId, normalizedRevision };
}

export function desiredWindowProofState(
  value: TelegramProofApplicationDocument,
): { normalizedRevision: string; proofRetryState: TelegramRetryState } | null {
  const proof = applicationFields(value);
  if (normalizeString(proof.safeRejectedAttemptId)) return null;
  const normalizedRevision = normalizeString(proof.requestedRevision);
  const proofRetryState = {
    retryStartedAtMs: normalizeTimestamp(proof.retryStartedAtMs),
    retryDeadlineAtMs: normalizeTimestamp(proof.retryDeadlineAtMs),
    retryAtMs: normalizeTimestamp(proof.retryAtMs),
    retrySequence: normalizeRetrySequence(proof.retrySequence),
  };
  if (
    !normalizedRevision ||
    !proofRetryState.retryStartedAtMs ||
    !proofRetryState.retryDeadlineAtMs ||
    !proofRetryState.retryAtMs
  )
    return null;
  return { normalizedRevision, proofRetryState };
}

export function cleanupWindowProofState(
  value: TelegramProofApplicationDocument,
): {
  normalizedPendingDeleteId: string;
  proofRetryState: TelegramRetryState;
} | null {
  const proof = applicationFields(value);
  const normalizedPendingDeleteId = normalizeString(proof.pendingDeleteId);
  const proofRetryState = {
    retryStartedAtMs: normalizeTimestamp(proof.retryStartedAtMs),
    retryDeadlineAtMs: normalizeTimestamp(proof.retryDeadlineAtMs),
    retryAtMs: normalizeTimestamp(proof.retryAtMs),
    retrySequence: normalizeRetrySequence(proof.retrySequence),
  };
  if (
    !normalizedPendingDeleteId ||
    !proofRetryState.retryStartedAtMs ||
    !proofRetryState.retryDeadlineAtMs ||
    !proofRetryState.retryAtMs
  )
    return null;
  return { normalizedPendingDeleteId, proofRetryState };
}

export const readBarrierProofInput: (
  input: TelegramBarrierInput | RetainedTelegramBarrierInput,
) => { owner: string; retryNotBeforeMs: number } = ({
  barrierProofOwner,
  barrierRetryNotBeforeMs,
}: {
  barrierProofOwner?: unknown;
  barrierRetryNotBeforeMs?: unknown;
} & Partial<RetainedTelegramBarrierInput>) => {
  const owner = normalizeString(barrierProofOwner);
  const retryNotBeforeMs = normalizeTimestamp(barrierRetryNotBeforeMs);
  return { owner, retryNotBeforeMs };
};

export function messageSettlementOwnerInput(
  message: TelegramMessageDocument | null | undefined,
  field: "apiGateSettleOwner" | "pendingDeleteApiGateSettleOwner",
): RetainedTelegramOwner {
  return readProperty(
    readProperty(message, "delivery"),
    field,
  ) as RetainedTelegramOwner;
}
