// Generated from src/telegram/deliveryControl.ts. Run npm run generate:runtime.
import type {
  TelegramBarrierProofResult,
  TelegramLocalRetryBarrier,
  TelegramRetryFailure,
} from "./deliveryRetryTypes.js";
import {
  type ExactRetryInput,
  type MessageMutation,
  type OwnedMutation,
} from "./deliveryState.js";
import type {
  TelegramApiGateResult,
  TelegramRepository,
  TelegramRetryScheduler,
} from "./deliveryTypes.js";
export declare function createTelegramDeliveryControl({
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
}): {
  logFailure: (
    messageKey: string,
    status: string,
    error: TelegramRetryFailure,
  ) => void;
  transact: (
    messageKey: string,
    updater: MessageMutation,
  ) => Promise<
    import("../transactions.js").TransactionResult<Record<string, unknown>>
  >;
  scheduleExactRetry: ({
    messageKey,
    revision,
    taskKind,
    retryState,
    safeRejectedAttemptId,
    pendingDeleteId,
    retryProofLeaseOwner,
    sourceGeneration,
    proofTaskKind,
    barrierProofOwner,
    barrierRetryNotBeforeMs,
    scheduleTimeMs,
    apiGateReclaimOwner,
    apiGateSettleOwner,
  }: ExactRetryInput) => Promise<Record<string, unknown>>;
  retryCoordinator: {
    finish(
      input: import("./deliveryRetryTypes.js").TelegramRetryInput,
    ): Promise<import("./deliveryRetryTypes.js").TelegramRetryResult>;
  };
  applyRateLimitBarrierProof: ({
    barrierProofOwner,
    barrierRetryNotBeforeMs,
  }: {
    barrierProofOwner?: unknown;
    barrierRetryNotBeforeMs?: unknown;
  }) => Promise<
    Partial<TelegramBarrierProofResult> & {
      applied: boolean;
    }
  >;
  clearAppliedRateLimitProofMarker: (
    messageKey: string,
    ownerInput: unknown,
  ) => Promise<void>;
  acquireApiGate: ({
    messageKey,
    revision,
    operation,
    owner,
    attemptId,
    pendingDeleteId,
    reclaimOwner,
    taskGeneration,
  }: {
    messageKey: string;
    revision: string;
    operation: string;
    owner: string;
    attemptId?: string;
    pendingDeleteId?: string;
    reclaimOwner?: string;
    taskGeneration?: string;
  }) => Promise<TelegramApiGateResult>;
  buildGateBlockedFailure: (
    gateResult: TelegramApiGateResult,
    checkedAtMs: number,
  ) => TelegramRetryFailure;
  updateOwned: (
    messageKey: string,
    ownerToken: string,
    updater: OwnedMutation,
  ) => Promise<
    import("../transactions.js").TransactionResult<Record<string, unknown>>
  >;
  prepareDesiredApiGateIdentity: ({
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
  }) => Promise<{
    owner: string;
    generation: string;
    reclaimOwner: string;
    delivery: import("./deliveryState.js").DeliverySnapshot;
  }>;
  settlePersistedApiGate: ({
    messageKey,
    field,
    owner: ownerInput,
  }: {
    messageKey: string;
    field: "apiGateSettleOwner" | "pendingDeleteApiGateSettleOwner";
    owner: unknown;
  }) => Promise<
    | import("../transactions.js").TransactionResult<Record<string, unknown>>
    | null
  >;
};
export type TelegramDeliveryControl = ReturnType<
  typeof createTelegramDeliveryControl
>;
