// Generated from src/telegram/deliveryRetryTypes.ts. Run npm run generate:runtime.
import type { TelegramTaskKind } from "./taskIdentity.js";
export type TelegramRetryState = {
  retryStartedAtMs: number;
  retryDeadlineAtMs: number;
  retryAtMs: number;
  retrySequence: number;
};
export type TelegramRetryFailure = {
  code?: string;
  description?: string;
  httpStatus?: number | null;
  retryAfterSeconds?: number | null;
};
export type TelegramDeliveryErrorState = {
  code: string;
  atMs: number;
  description?: string;
  httpStatus?: number;
};
export type TelegramLocalRetryBarrier = {
  getRetryNotBeforeMs(): number;
  extendRetryNotBeforeMs(candidateMs: number): number;
};
export type TelegramBarrierProof = {
  owner: string;
  retryNotBeforeMs: number;
};
export type TelegramBarrierProofResult = {
  applied: boolean;
  retryNotBeforeMs: number;
  gate: Record<string, unknown>;
};
export type TelegramExactRetryInput = {
  messageKey: string;
  revision: string;
  taskKind: TelegramTaskKind;
  retryState: Partial<TelegramRetryState> &
    Pick<TelegramRetryState, "retryAtMs" | "retrySequence">;
  safeRejectedAttemptId?: string;
  pendingDeleteId?: string;
  retryProofLeaseOwner?: string;
  sourceGeneration?: string;
  proofTaskKind?: "desired" | "pending-delete" | "";
  barrierProofOwner?: string;
  barrierRetryNotBeforeMs?: number;
  scheduleTimeMs?: number;
  apiGateReclaimOwner?: string;
  apiGateSettleOwner?: string;
};
export type TelegramRetryContext = {
  finalizedAtMs: number;
  retryState: TelegramRetryState;
  rateLimited: boolean;
  barrierRetryNotBeforeMs: number;
};
export type TelegramRetryTarget =
  | {
      kind: "desired";
      safeRejectedAttemptId?: string;
      pendingDeleteId?: string;
    }
  | {
      kind: "pending-delete";
      pendingDeleteId: string;
    };
export type TelegramRetryInput = {
  current: unknown;
  failure: TelegramRetryFailure;
  target: TelegramRetryTarget;
  messageKey: string;
  revision: string;
  ownerToken: string;
  apiGateOwner?: string;
  persistBeforeSchedule?: boolean;
  persistProof(context: TelegramRetryContext): Promise<void>;
  persistState(context: TelegramRetryContext): Promise<void>;
};
export type TelegramRetryDependencies = {
  now(): number;
  scheduleExactRetry(input: TelegramExactRetryInput): Promise<unknown>;
  releaseApiGate(owner: string): Promise<boolean>;
  extendRetryBarrierAndReleaseApiGate(
    proof: TelegramBarrierProof,
  ): Promise<TelegramBarrierProofResult>;
  localRetryBarrier: TelegramLocalRetryBarrier;
};
export type TelegramRetryResult = TelegramRetryState & {
  barrierProofPending?: true;
};
