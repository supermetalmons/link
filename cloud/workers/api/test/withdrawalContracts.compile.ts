import type {
  CompletedWithdrawalDocument,
  CompletedWithdrawalWrite,
  WithdrawalDocument,
  WithdrawalClaimFields,
  WithdrawalSubmissionEvidence,
  writeProcessingWithdrawal,
  writeReacquiredSubmittedWithdrawal,
} from "../../../runtime/eventPrizes/records.js";
import type {
  WithdrawalRecord,
  WithdrawalStore,
} from "../../../runtime/eventPrizes/types.js";

type Assert<T extends true> = T;
type Rejects<Value, Contract> = Value extends Contract ? false : true;

export type ReadsHaveNoIndexSignature = Assert<
  string extends keyof WithdrawalDocument ? false : true
>;
export type RecordsHaveNoGenericTransaction = Assert<
  "transaction" extends keyof WithdrawalRecord ? false : true
>;
export type StoresHaveNoArbitraryReplacement = Assert<
  "replaceRecords" extends keyof WithdrawalStore ? false : true
>;
export type StoredStatusDoesNotProveCompletedWrite = Assert<
  Rejects<
    WithdrawalDocument & { status: "completed" },
    CompletedWithdrawalDocument
  >
>;
export type CompletionRequiresConfirmedIdentity = Assert<
  Rejects<
    Omit<CompletedWithdrawalWrite, "transactionSignature">,
    CompletedWithdrawalWrite
  >
>;
export type CompletionCannotWriteProcessingStatus = Assert<
  Rejects<
    Omit<CompletedWithdrawalWrite, "status"> & { status: "processing" },
    CompletedWithdrawalWrite
  >
>;
export type SubmissionRequiresAllEvidence = Assert<
  Rejects<
    Omit<WithdrawalSubmissionEvidence, "blockhash">,
    WithdrawalSubmissionEvidence
  >
>;
export type ProcessingCannotMergePriorRecord = Assert<
  Rejects<
    [WithdrawalDocument, WithdrawalClaimFields],
    Parameters<typeof writeProcessingWithdrawal>
  >
>;
export type ProcessingCannotChooseSubmittedStatus = Assert<
  Rejects<
    Omit<WithdrawalClaimFields, "status"> & { status: "submitted" },
    WithdrawalClaimFields
  >
>;
export type SubmittedReacquisitionRequiresPriorRecord = Assert<
  Rejects<
    [WithdrawalClaimFields],
    Parameters<typeof writeReacquiredSubmittedWithdrawal>
  >
>;
export type SubmittedReacquisitionPreservesIncompleteEvidence = Assert<
  [WithdrawalDocument, WithdrawalClaimFields] extends Parameters<
    typeof writeReacquiredSubmittedWithdrawal
  >
    ? true
    : false
>;
