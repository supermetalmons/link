// Generated from src/telegram/retryRecords.ts. Run npm run generate:runtime.
import type {
  TelegramExactRetryInput,
  TelegramRetryState,
} from "./deliveryRetryTypes.js";
import type {
  TelegramReconcileInput,
  TelegramRetrySchedule,
} from "./deliveryTypes.js";
import {
  type TelegramMessageDocument,
  type TelegramDeliveryDocument,
  type TelegramRetryProofDocument,
} from "./records.js";
declare const retainedRetry: unique symbol;
type RetainedRetry<Kind extends string> = {
  readonly [retainedRetry]: Kind;
};
export type RetainedTelegramExactRetryInput = RetainedRetry<"exact-input">;
export type RetainedTelegramRetrySchedule = RetainedRetry<"schedule">;
export type RetainedTelegramProofInput = RetainedRetry<"proof-input">;
export type TelegramProofApplicationDocument =
  RetainedRetry<"proof-application">;
export type RetainedTelegramBarrierInput = RetainedRetry<"barrier-input">;
export type RetainedTelegramOwner = RetainedRetry<"owner">;
export type TelegramProofInput = Partial<
  TelegramReconcileInput & {
    requestedPendingDeleteId: string;
  }
>;
export type TelegramBarrierInput = {
  barrierProofOwner?: string;
  barrierRetryNotBeforeMs?: number;
};
export declare const buildTelegramRetrySchedule: (
  input: TelegramExactRetryInput | RetainedTelegramExactRetryInput,
) => RetainedTelegramRetrySchedule;
export declare function telegramRetryScheduleTime(
  input: TelegramRetrySchedule | RetainedTelegramRetrySchedule,
): number;
export declare function retainedRateLimitProof(
  value: unknown,
): TelegramRetryProofDocument;
export declare function messageRateLimitProof(
  value: TelegramDeliveryDocument,
  pending?: boolean,
): TelegramRetryProofDocument;
export declare function readRateLimitRetryState(
  value: TelegramRetryProofDocument,
): TelegramRetryState;
export declare function rateLimitProofRetryAt(
  value: TelegramRetryProofDocument,
): number;
export declare function rateLimitProofOwner(
  value: TelegramRetryProofDocument,
): RetainedTelegramOwner;
export declare function lockedDesiredRetryInput(
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
): RetainedTelegramExactRetryInput;
export declare function deferredDesiredRetryInput(
  delivery: TelegramMessageDocument | null,
  context: {
    messageKey: string;
    revision: string;
    retryAtMs: number | null;
    sourceGeneration?: string;
  },
): RetainedTelegramExactRetryInput;
export type RateLimitProofTarget =
  | {
      kind: "desired";
    }
  | {
      kind: "pending-delete";
      requestedPendingDeleteId?: string;
    };
export declare function resumedRateLimitRetryInput(
  value: TelegramRetryProofDocument,
  context: {
    messageKey: string;
    requestedRevision?: string;
    nowMs: number;
    target: RateLimitProofTarget;
    retryState: TelegramRetryState;
  },
): RetainedTelegramExactRetryInput;
export declare function rateLimitBarrierInput(
  value: TelegramRetryProofDocument,
): RetainedTelegramBarrierInput;
export declare function desiredSafeProofInput(
  value: TelegramRetryProofDocument,
  state: TelegramRetryState,
): RetainedTelegramProofInput;
export declare function desiredWindowProofInput(
  value: TelegramRetryProofDocument,
  state: TelegramRetryState,
): RetainedTelegramProofInput;
export declare function cleanupWindowProofInput(
  value: TelegramRetryProofDocument,
  state: TelegramRetryState,
  target: Extract<
    RateLimitProofTarget,
    {
      kind: "pending-delete";
    }
  >,
): RetainedTelegramProofInput;
export declare const captureSafeRetryProof: (
  input: TelegramProofInput | RetainedTelegramProofInput,
) => TelegramProofApplicationDocument;
export declare const captureDesiredWindowProof: (
  input: TelegramProofInput | RetainedTelegramProofInput,
) => TelegramProofApplicationDocument;
export declare const captureCleanupWindowProof: (
  input: TelegramProofInput | RetainedTelegramProofInput,
) => TelegramProofApplicationDocument;
export declare function safeRetryProofIdentity(
  value: TelegramProofApplicationDocument,
): {
  normalizedAttemptId: string;
  normalizedRevision: string;
};
export declare function desiredWindowProofState(
  value: TelegramProofApplicationDocument,
): {
  normalizedRevision: string;
  proofRetryState: TelegramRetryState;
} | null;
export declare function cleanupWindowProofState(
  value: TelegramProofApplicationDocument,
): {
  normalizedPendingDeleteId: string;
  proofRetryState: TelegramRetryState;
} | null;
export declare const readBarrierProofInput: (
  input: TelegramBarrierInput | RetainedTelegramBarrierInput,
) => {
  owner: string;
  retryNotBeforeMs: number;
};
export declare function messageSettlementOwnerInput(
  message: TelegramMessageDocument | null | undefined,
  field: "apiGateSettleOwner" | "pendingDeleteApiGateSettleOwner",
): RetainedTelegramOwner;
export {};
