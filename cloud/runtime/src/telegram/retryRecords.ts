import { readTelegramRetryProof } from "./recordCodec.js";
import {
  normalizeRetrySequence,
  normalizeTimestamp,
} from "./deliveryPolicy.js";
import {
  normalizeOptionalTimestamp,
  normalizeTaskPayload,
} from "./taskIdentity.js";
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

export type RetainedTelegramExactRetryInput = TelegramExactRetryInput;
export type RetainedTelegramRetrySchedule = TelegramRetrySchedule;
export type RetainedTelegramProofInput = TelegramProofInput;
export type TelegramProofApplicationDocument = TelegramProofInput;
export type RetainedTelegramBarrierInput = TelegramBarrierInput;
export type RetainedTelegramOwner = string;
export type TelegramProofInput = Partial<
  TelegramReconcileInput & { requestedPendingDeleteId: string }
>;
export type TelegramBarrierInput = {
  barrierProofOwner?: string;
  barrierRetryNotBeforeMs?: number;
};
type ExactRetryEvidence = TelegramExactRetryInput;
type ProofEvidence = TelegramProofInput;
const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const proofFields = (
  value: TelegramRetryProofDocument,
): TelegramRetryProofDocument => value;
const applicationFields = (
  value: TelegramProofApplicationDocument,
): TelegramProofApplicationDocument => value;
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
  const normalizedTaskKind = taskKind;
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
  const payload = {
    messageKey,
    revision,
    taskKind: normalizedTaskKind,
    ...(retrySequence === undefined ? {} : { retrySequence }),
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
  return {
    ...normalizeTaskPayload(payload),
    scheduleTimeMs: payload.scheduleTimeMs,
  };
};

export function telegramRetryScheduleTime(
  input: TelegramRetrySchedule | RetainedTelegramRetrySchedule,
): number {
  return normalizeOptionalTimestamp(input.scheduleTimeMs);
}

export function messageRateLimitProof(
  value: Partial<TelegramDeliveryDocument>,
  pending = false,
): TelegramRetryProofDocument {
  const source = pending ? readProperty(value, "pendingDelete") : value;
  const proof = readProperty(source, "apiGateProofRequired");
  const parsed = readTelegramRetryProof(proof);
  if (!parsed) throw new TypeError("telegram-retry-proof-missing");
  return parsed;
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
  return proofFields(value).owner;
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
  const input: TelegramExactRetryInput = {
    messageKey: context.messageKey,
    revision: context.revision,
    taskKind: TELEGRAM_DESIRED_TASK_KIND,
    retryState: {
      retryStartedAtMs:
        messageDeliveryDocument(delivery).retryStartedAtMs ||
        context.retryStartedAtMs,
      retryDeadlineAtMs:
        messageDeliveryDocument(delivery).retryDeadlineAtMs ||
        context.retryDeadlineAtMs,
      retryAtMs: context.retryAtMs ?? 0,
      retrySequence:
        messageDeliveryDocument(delivery).retrySequence ??
        context.retrySequence,
    },
    ...(context.sourceGeneration === undefined
      ? {}
      : { sourceGeneration: context.sourceGeneration }),
    apiGateReclaimOwner: context.apiGateReclaimOwner,
  };
  return input;
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
  const { retryStartedAtMs, retryDeadlineAtMs } =
    messageDeliveryDocument(delivery);
  const input: TelegramExactRetryInput = {
    messageKey: context.messageKey,
    revision: context.revision,
    taskKind: TELEGRAM_DESIRED_TASK_KIND,
    retryState: {
      ...(retryStartedAtMs === undefined ? {} : { retryStartedAtMs }),
      ...(retryDeadlineAtMs === undefined ? {} : { retryDeadlineAtMs }),
      retryAtMs: context.retryAtMs ?? 0,
      retrySequence: messageDeliveryDocument(delivery).retrySequence ?? 0,
    },
    ...(context.sourceGeneration === undefined
      ? {}
      : { sourceGeneration: context.sourceGeneration }),
  };
  return input;
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
  const input: TelegramExactRetryInput = {
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
  return input;
}

export function rateLimitBarrierInput(
  value: TelegramRetryProofDocument,
): RetainedTelegramBarrierInput {
  const proof = proofFields(value);
  const input: TelegramBarrierInput = {
    barrierProofOwner: proof.owner,
    barrierRetryNotBeforeMs: proof.retryNotBeforeMs,
  };
  return input;
}

export function desiredSafeProofInput(
  value: TelegramRetryProofDocument,
  state: TelegramRetryState,
): RetainedTelegramProofInput {
  const proof = proofFields(value);
  const input: TelegramProofInput = {
    requestedRevision: proof.revision,
    ...(proof.safeRejectedAttemptId === undefined
      ? {}
      : { safeRejectedAttemptId: proof.safeRejectedAttemptId }),
    ...state,
  };
  return input;
}

export function desiredWindowProofInput(
  value: TelegramRetryProofDocument,
  state: TelegramRetryState,
): RetainedTelegramProofInput {
  const proof = proofFields(value);
  const input: TelegramProofInput = {
    requestedRevision: proof.revision,
    ...(proof.retryProofLeaseOwner === undefined
      ? {}
      : { retryProofLeaseOwner: proof.retryProofLeaseOwner }),
    ...state,
  };
  return input;
}

export function cleanupWindowProofInput(
  value: TelegramRetryProofDocument,
  state: TelegramRetryState,
  target: Extract<RateLimitProofTarget, { kind: "pending-delete" }>,
): RetainedTelegramProofInput {
  const proof = proofFields(value);
  const pendingDeleteId =
    target.requestedPendingDeleteId === undefined
      ? proof.pendingDeleteId
      : normalizeString(proof.pendingDeleteId) ||
        target.requestedPendingDeleteId;
  const input: TelegramProofInput = {
    ...(pendingDeleteId === undefined ? {} : { pendingDeleteId }),
    ...(proof.retryProofLeaseOwner === undefined
      ? {}
      : { retryProofLeaseOwner: proof.retryProofLeaseOwner }),
    ...state,
  };
  return input;
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
  const captured: TelegramProofApplicationDocument = {
    ...(requestedRevision === undefined ? {} : { requestedRevision }),
    ...(safeRejectedAttemptId === undefined ? {} : { safeRejectedAttemptId }),
    ...(retryStartedAtMs === undefined ? {} : { retryStartedAtMs }),
    ...(retryDeadlineAtMs === undefined ? {} : { retryDeadlineAtMs }),
    ...(retryAtMs === undefined ? {} : { retryAtMs }),
    ...(retrySequence === undefined ? {} : { retrySequence }),
  };
  return captured;
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
  const captured: TelegramProofApplicationDocument = {
    ...(requestedRevision === undefined ? {} : { requestedRevision }),
    ...(safeRejectedAttemptId === undefined ? {} : { safeRejectedAttemptId }),
    ...(retryStartedAtMs === undefined ? {} : { retryStartedAtMs }),
    ...(retryDeadlineAtMs === undefined ? {} : { retryDeadlineAtMs }),
    ...(retryAtMs === undefined ? {} : { retryAtMs }),
    ...(retrySequence === undefined ? {} : { retrySequence }),
    ...(retryProofLeaseOwner === undefined ? {} : { retryProofLeaseOwner }),
    ...(apiGateReclaimOwner === undefined ? {} : { apiGateReclaimOwner }),
  };
  return captured;
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
  const captured: TelegramProofApplicationDocument = {
    ...(pendingDeleteId === undefined ? {} : { pendingDeleteId }),
    ...(retryStartedAtMs === undefined ? {} : { retryStartedAtMs }),
    ...(retryDeadlineAtMs === undefined ? {} : { retryDeadlineAtMs }),
    ...(retryAtMs === undefined ? {} : { retryAtMs }),
    ...(retrySequence === undefined ? {} : { retrySequence }),
    ...(retryProofLeaseOwner === undefined ? {} : { retryProofLeaseOwner }),
    ...(apiGateReclaimOwner === undefined ? {} : { apiGateReclaimOwner }),
  };
  return captured;
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
  barrierProofOwner?: string;
  barrierRetryNotBeforeMs?: number;
} & Partial<RetainedTelegramBarrierInput>) => {
  const owner = normalizeString(barrierProofOwner);
  const retryNotBeforeMs = normalizeTimestamp(barrierRetryNotBeforeMs);
  return { owner, retryNotBeforeMs };
};

export function messageSettlementOwnerInput(
  message: TelegramMessageDocument | null | undefined,
  field: "apiGateSettleOwner" | "pendingDeleteApiGateSettleOwner",
): RetainedTelegramOwner {
  return message?.delivery?.[field] ?? "";
}
