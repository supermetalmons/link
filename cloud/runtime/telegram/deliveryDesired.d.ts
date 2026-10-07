// Generated from src/telegram/deliveryDesired.ts. Run npm run generate:runtime.
import type { TelegramClient } from "./client.js";
import type { TelegramDeliveryControl } from "./deliveryControl.js";
import type { TelegramDeliveryRecovery } from "./deliveryRecovery.js";
import type { TelegramLocalRetryBarrier } from "./deliveryRetryTypes.js";
import type {
  TelegramReconcileInput,
  TelegramRepository,
} from "./deliveryTypes.js";
export declare function createTelegramDesiredDelivery({
  repository,
  client,
  resolveDestination,
  now,
  createOwnerToken,
  createAttemptId,
  logger,
  leaseTtlMs,
  localRetryBarrier,
  control,
  recovery,
}: {
  repository: TelegramRepository;
  client: TelegramClient;
  resolveDestination: (destination: string) => string;
  now: () => number;
  createOwnerToken: () => string;
  createAttemptId: () => string;
  logger: Pick<Console, "error" | "info">;
  leaseTtlMs: number;
  localRetryBarrier: TelegramLocalRetryBarrier;
  control: Pick<
    TelegramDeliveryControl,
    | "transact"
    | "updateOwned"
    | "retryCoordinator"
    | "prepareDesiredApiGateIdentity"
    | "settlePersistedApiGate"
    | "acquireApiGate"
    | "buildGateBlockedFailure"
    | "logFailure"
    | "scheduleExactRetry"
    | "applyRateLimitBarrierProof"
    | "clearAppliedRateLimitProofMarker"
  >;
  recovery: TelegramDeliveryRecovery;
}): {
  reconcileDesired: ({
    messageKey,
    requestedRevision,
    safeRejectedAttemptId,
    retryStartedAtMs,
    retryDeadlineAtMs,
    retryAtMs,
    retrySequence,
    retryProofLeaseOwner,
    requestedGeneration,
    taskKind,
    apiGateReclaimOwner,
    apiGateSettleOwner,
  }?: TelegramReconcileInput) => Promise<
    | {
        status: string;
        reason: string;
      }
    | {
        status: string;
        retryAtMs: number;
        scheduled: boolean;
      }
    | {
        status: string;
        retryAtMs?: undefined;
        scheduled?: undefined;
      }
    | {
        status: string;
        reason: string;
        retryAtMs: number | null;
        scheduled: boolean;
      }
  >;
};
