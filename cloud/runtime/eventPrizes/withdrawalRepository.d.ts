// Generated from src/eventPrizes/withdrawalRepository.ts. Run npm run generate:runtime.
import type { WithdrawalData, WithdrawalRecord } from "./types.js";
import type { WithdrawalClaimInput } from "../eventPrizeWithdrawalState.js";
declare const acquireWithdrawalClaim: ({
  withdrawalRecord,
  eventId,
  prizeId,
  assetAddress,
  profileId,
  place,
  recipientAddress,
  requesterUid,
  canonicalRecordProfileId,
  canonicalRecordSourceProfileId,
}: Omit<WithdrawalClaimInput, "current" | "leaseId" | "nowMs"> & {
  withdrawalRecord: WithdrawalRecord;
}) => Promise<
  | {
      completed: WithdrawalData;
      leaseId?: never;
      withdrawal?: never;
    }
  | {
      leaseId: string;
      withdrawal: WithdrawalData;
      completed?: never;
    }
>;
declare const releaseProcessingClaim: ({
  withdrawalRecord,
  leaseId,
}: {
  withdrawalRecord: WithdrawalRecord;
  leaseId: string;
}) => Promise<void>;
declare const markWithdrawalBlocked: ({
  withdrawalRecord,
  leaseId,
  observedOwner,
}: {
  withdrawalRecord: WithdrawalRecord;
  leaseId: string;
  observedOwner: string;
}) => Promise<void>;
declare const persistSubmittedTransaction: ({
  withdrawalRecord,
  leaseId,
  transactionSignature,
  signedTransactionBase64,
  blockhash,
  lastValidBlockHeight,
}: {
  withdrawalRecord: WithdrawalRecord;
  leaseId: string;
  transactionSignature: string;
  signedTransactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
}) => Promise<WithdrawalData>;
declare const discardDefinitiveSubmittedTransaction: ({
  withdrawalRecord,
  leaseId,
  transactionSignature,
}: {
  withdrawalRecord: WithdrawalRecord;
  leaseId: string;
  transactionSignature: string;
}) => Promise<void>;
export {
  acquireWithdrawalClaim,
  discardDefinitiveSubmittedTransaction,
  markWithdrawalBlocked,
  persistSubmittedTransaction,
  releaseProcessingClaim,
};
