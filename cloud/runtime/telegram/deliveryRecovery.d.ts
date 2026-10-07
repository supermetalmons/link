// Generated from src/telegram/deliveryRecovery.ts. Run npm run generate:runtime.
import type { TelegramDeliveryControl } from "./deliveryControl.js";
import { type ProofInput } from "./deliveryState.js";
import type { TelegramRepository } from "./deliveryTypes.js";
export declare function createTelegramDeliveryRecovery({
  repository,
  now,
  control,
}: {
  repository: TelegramRepository;
  now: () => number;
  control: Pick<TelegramDeliveryControl, "transact">;
}): {
  applySafeRetryProof: (
    messageKey: string,
    {
      requestedRevision,
      safeRejectedAttemptId,
      retryStartedAtMs,
      retryDeadlineAtMs,
      retryAtMs,
      retrySequence,
    }: ProofInput,
  ) => Promise<{
    applied: boolean;
  }>;
  applyDesiredRetryWindowProof: (
    messageKey: string,
    {
      requestedRevision,
      safeRejectedAttemptId,
      retryStartedAtMs,
      retryDeadlineAtMs,
      retryAtMs,
      retrySequence,
      retryProofLeaseOwner,
      apiGateReclaimOwner,
    }: ProofInput,
  ) => Promise<{
    applied: boolean;
  }>;
  applyManualRecovery: (messageKey: string) => Promise<{
    processed: boolean;
    action: string;
    apiGateReleaseOwner: string;
    shouldContinue: boolean;
  }>;
  settleManualApiGateRelease: (
    messageKey: string,
    ownerInput: unknown,
  ) => Promise<void>;
  applyPendingDeleteRetryWindowProof: (
    messageKey: string,
    {
      pendingDeleteId,
      retryStartedAtMs,
      retryDeadlineAtMs,
      retryAtMs,
      retrySequence,
      retryProofLeaseOwner,
      apiGateReclaimOwner,
    }: ProofInput,
  ) => Promise<{
    applied: boolean;
  }>;
};
export type TelegramDeliveryRecovery = ReturnType<
  typeof createTelegramDeliveryRecovery
>;
