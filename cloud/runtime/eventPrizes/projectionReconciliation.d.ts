// Generated from src/eventPrizes/projectionReconciliation.ts. Run npm run generate:runtime.
import type {
  WithdrawalData,
  WithdrawalCompletionInput,
  WithdrawalProjectionDependencies,
  WithdrawalCompletionDependencies,
} from "./types.js";
type ProjectionReconciliationInput = {
  withdrawal: WithdrawalData;
  profileIds?: readonly string[];
  eventId: string;
  prizeId: string;
};
declare const reconcileCompletedWithdrawalProjections: (
  { withdrawal, profileIds, eventId, prizeId }: ProjectionReconciliationInput,
  dependencies: WithdrawalProjectionDependencies,
) => Promise<void>;
declare const attemptCompletedWithdrawalProjectionReconciliation: (
  args: ProjectionReconciliationInput,
  dependencies: WithdrawalProjectionDependencies,
) => Promise<void>;
declare const finalizeWithdrawal: (
  {
    withdrawal,
    profileId,
    eventId,
    prizeId,
    assetAddress,
    recipientAddress,
    transactionSignature,
  }: WithdrawalCompletionInput,
  dependencies: WithdrawalCompletionDependencies,
) => Promise<{
  eventId: string;
  prizeId: string;
  assetAddress: string;
  assetStandard: string;
  profileId: string;
  entitledProfileId: string;
  place: number;
  recipientAddress: string;
  requesterUid: string;
  status: "completed";
  transactionSignature: string;
  startedAtMs: number;
  submittedAtMs: number;
  completedAtMs: number;
  updatedAtMs: number;
}>;
export {
  attemptCompletedWithdrawalProjectionReconciliation,
  finalizeWithdrawal,
  reconcileCompletedWithdrawalProjections,
};
