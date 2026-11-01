import type {
  BlockedWithdrawalDocument,
  CompletedWithdrawalDocument,
  CompletedWithdrawalWrite,
  ProcessingWithdrawalDocument,
  SubmittedWithdrawalDocument,
  WithdrawalDocument,
  WithdrawalClaimFields,
  WithdrawalSubmissionEvidence,
  readWithdrawalDocument,
  writeCompletedWithdrawal,
  writeProcessingWithdrawal,
  writeReacquiredSubmittedWithdrawal,
  writeSubmittedWithdrawal,
} from "../../../runtime/eventPrizes/records.js";
import type {
  WithdrawalRecord,
  WithdrawalStore,
} from "../../../runtime/eventPrizes/types.js";

type Assert<T extends true> = T;
type Rejects<Value, Contract> = [Value] extends [Contract] ? false : true;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

export type WithdrawalStorageContracts = [
  Assert<string extends keyof WithdrawalDocument ? false : true>,
  Assert<Equal<WithdrawalDocument["schemaVersion"], 1>>,
  Assert<
    Equal<
      WithdrawalDocument["status"],
      "blocked" | "completed" | "processing" | "submitted"
    >
  >,
  Assert<Rejects<Record<string, unknown>, WithdrawalDocument>>,
  Assert<
    Equal<
      Extract<WithdrawalDocument, { status: "processing" }>,
      ProcessingWithdrawalDocument
    >
  >,
  Assert<
    Equal<
      Extract<WithdrawalDocument, { status: "submitted" }>,
      SubmittedWithdrawalDocument
    >
  >,
  Assert<
    Equal<
      Extract<WithdrawalDocument, { status: "completed" }>,
      CompletedWithdrawalDocument
    >
  >,
  Assert<
    Equal<
      Extract<WithdrawalDocument, { status: "blocked" }>,
      BlockedWithdrawalDocument
    >
  >,
  Assert<
    Equal<ReturnType<typeof readWithdrawalDocument>, WithdrawalDocument | null>
  >,
  Assert<"transaction" extends keyof WithdrawalRecord ? false : true>,
  Assert<"replaceRecords" extends keyof WithdrawalStore ? false : true>,
  Assert<
    Equal<
      Parameters<WithdrawalStore["replaceCompleted"]>[0][number]["value"],
      CompletedWithdrawalDocument
    >
  >,
];

export type WithdrawalLifecycleContracts = [
  Assert<Equal<ProcessingWithdrawalDocument["transactionSignature"], null>>,
  Assert<Equal<ProcessingWithdrawalDocument["completedAtMs"], null>>,
  Assert<Equal<SubmittedWithdrawalDocument["signedTransactionBase64"], string>>,
  Assert<Equal<SubmittedWithdrawalDocument["blockhash"], string>>,
  Assert<Equal<SubmittedWithdrawalDocument["lastValidBlockHeight"], number>>,
  Assert<Equal<SubmittedWithdrawalDocument["submittedAtMs"], number>>,
  Assert<Equal<CompletedWithdrawalDocument["leaseId"], null>>,
  Assert<Equal<CompletedWithdrawalDocument["leaseExpiresAtMs"], null>>,
  Assert<Equal<CompletedWithdrawalDocument["transactionSignature"], string>>,
  Assert<Equal<CompletedWithdrawalDocument["completedAtMs"], number>>,
  Assert<Equal<BlockedWithdrawalDocument["completedAtMs"], null>>,
  Assert<Equal<BlockedWithdrawalDocument["leaseId"], null>>,
  Assert<
    Equal<
      BlockedWithdrawalDocument["blockReason"],
      "asset-owner-mismatch" | "canonical-data-cutover"
    >
  >,
  Assert<
    Rejects<
      Omit<CompletedWithdrawalWrite, "transactionSignature">,
      CompletedWithdrawalWrite
    >
  >,
  Assert<
    Rejects<
      Omit<WithdrawalSubmissionEvidence, "blockhash">,
      WithdrawalSubmissionEvidence
    >
  >,
  Assert<
    Rejects<
      Omit<CompletedWithdrawalWrite, "status"> & { status: "processing" },
      CompletedWithdrawalWrite
    >
  >,
  Assert<
    Rejects<
      Omit<WithdrawalClaimFields, "status"> & { status: "submitted" },
      WithdrawalClaimFields
    >
  >,
  Assert<
    Equal<
      Parameters<typeof writeProcessingWithdrawal>,
      [value: WithdrawalClaimFields]
    >
  >,
  Assert<
    Equal<
      ReturnType<typeof writeProcessingWithdrawal>,
      ProcessingWithdrawalDocument
    >
  >,
  Assert<
    Equal<
      ReturnType<typeof writeSubmittedWithdrawal>,
      SubmittedWithdrawalDocument
    >
  >,
  Assert<
    Equal<
      ReturnType<typeof writeReacquiredSubmittedWithdrawal>,
      SubmittedWithdrawalDocument
    >
  >,
  Assert<
    Equal<
      ReturnType<typeof writeCompletedWithdrawal>,
      CompletedWithdrawalDocument
    >
  >,
  Assert<
    Rejects<
      [WithdrawalClaimFields],
      Parameters<typeof writeReacquiredSubmittedWithdrawal>
    >
  >,
];
