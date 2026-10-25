// Generated from src/eventPrizes/projectionReconciliation.ts. Run npm run generate:runtime.
import type { WithdrawalDocument } from "./records.js";
import type {
  WithdrawalCompletionInput,
  WithdrawalProjectionDependencies,
  WithdrawalCompletionDependencies,
} from "./types.js";
type ProjectionReconciliationInput = {
  withdrawal: WithdrawalDocument;
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
) => Promise<import("./records.js").CompletedWithdrawalDocument>;
export {
  attemptCompletedWithdrawalProjectionReconciliation,
  finalizeWithdrawal,
  reconcileCompletedWithdrawalProjections,
};
