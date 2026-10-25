// Generated from src/telegram/deliveryRecovery.ts. Run npm run generate:runtime.
import {
  type RetainedTelegramProofInput,
  type RetainedTelegramOwner,
} from "./retryRecords.js";
import type { TelegramRetryProofDocument } from "./records.js";
import type { TelegramDeliveryControl } from "./deliveryControl.js";
import { type ProofInput } from "./deliveryState.js";
import type { TelegramRepository } from "./deliveryTypes.js";
type RateLimitProofRecoveryInput = {
  messageKey: string;
  proof: TelegramRetryProofDocument;
  requestedRevision: string;
  nowMs: number;
  target:
    | {
        kind: "desired";
      }
    | {
        kind: "pending-delete";
        requestedPendingDeleteId?: string;
      };
};
export declare function createTelegramDeliveryRecovery({
  repository,
  now,
  control,
}: {
  repository: TelegramRepository;
  now: () => number;
  control: Pick<
    TelegramDeliveryControl,
    | "transact"
    | "scheduleExactRetry"
    | "applyRateLimitBarrierProof"
    | "clearAppliedRateLimitProofMarker"
  >;
}): {
  applySafeRetryProof: (
    messageKey: string,
    input: ProofInput | RetainedTelegramProofInput,
  ) => Promise<{
    applied: boolean;
  }>;
  applyDesiredRetryWindowProof: (
    messageKey: string,
    input: ProofInput | RetainedTelegramProofInput,
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
    ownerInput: string | RetainedTelegramOwner | undefined,
  ) => Promise<void>;
  applyPendingDeleteRetryWindowProof: (
    messageKey: string,
    input: ProofInput | RetainedTelegramProofInput,
  ) => Promise<{
    applied: boolean;
  }>;
  resumeRateLimitProof: ({
    messageKey,
    proof,
    requestedRevision,
    nowMs,
    target,
  }: RateLimitProofRecoveryInput) => Promise<void>;
};
export type TelegramDeliveryRecovery = ReturnType<
  typeof createTelegramDeliveryRecovery
>;
export {};
