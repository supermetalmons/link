// Generated from src/telegram/deliveryCleanup.ts. Run npm run generate:runtime.
import type { TelegramClient } from "./client.js";
import type { TelegramDeliveryControl } from "./deliveryControl.js";
import type { TelegramDeliveryRecovery } from "./deliveryRecovery.js";
import type { TelegramLocalRetryBarrier } from "./deliveryRetryTypes.js";
import type {
  TelegramEngineResult,
  TelegramReconcileInput,
  TelegramRepository,
} from "./deliveryTypes.js";
export declare function createTelegramCleanupDelivery({
  repository,
  client,
  now,
  createOwnerToken,
  leaseTtlMs,
  localRetryBarrier,
  control,
  recovery,
}: {
  repository: TelegramRepository;
  client: TelegramClient;
  now: () => number;
  createOwnerToken: () => string;
  leaseTtlMs: number;
  localRetryBarrier: TelegramLocalRetryBarrier;
  control: Pick<
    TelegramDeliveryControl,
    | "transact"
    | "retryCoordinator"
    | "settlePersistedApiGate"
    | "acquireApiGate"
    | "buildGateBlockedFailure"
    | "scheduleExactRetry"
    | "applyRateLimitBarrierProof"
    | "clearAppliedRateLimitProofMarker"
  >;
  recovery: Pick<
    TelegramDeliveryRecovery,
    "applyPendingDeleteRetryWindowProof"
  >;
}): {
  reconcilePendingDelete: ({
    messageKey,
    requestedRevision,
    requestedPendingDeleteId,
    requestedGeneration,
    retryStartedAtMs,
    retryDeadlineAtMs,
    retryAtMs,
    retrySequence,
    retryProofLeaseOwner,
    apiGateReclaimOwner,
  }: TelegramReconcileInput & {
    requestedPendingDeleteId?: string;
  }) => Promise<TelegramEngineResult>;
};
