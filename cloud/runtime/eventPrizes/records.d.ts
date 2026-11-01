// Generated from src/eventPrizes/records.ts. Run npm run generate:runtime.
import { type EventPrizeStandard } from "../shared/event-prizes.js";
export type WithdrawalStatus =
  "blocked" | "completed" | "processing" | "submitted";
type WithdrawalBlockReason = "asset-owner-mismatch" | "canonical-data-cutover";
export type WithdrawalSubmissionEvidence = {
  transactionSignature: string;
  signedTransactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
};
type WithdrawalIdentity = {
  schemaVersion: 1;
  eventId: string;
  prizeId: string;
  assetAddress: string;
  assetStandard: EventPrizeStandard;
  entitledProfileId: string;
  profileId: string;
  place: 1 | 2 | 3;
  recipientAddress: string;
  requesterUid: string;
  startedAtMs: number;
  updatedAtMs: number;
};
type NoSubmission = {
  transactionSignature: null;
  signedTransactionBase64: null;
  blockhash: null;
  lastValidBlockHeight: null;
  submittedAtMs: null;
};
type SubmittedEvidence = WithdrawalSubmissionEvidence & {
  submittedAtMs: number;
};
type NoBlock = {
  observedOwner: null;
  blockReason: null;
  blockedAtMs: null;
  sourceDigest: null;
};
type NoLease = {
  leaseId: null;
  leaseExpiresAtMs: null;
};
export type ProcessingWithdrawalDocument = WithdrawalIdentity &
  NoSubmission &
  NoBlock & {
    status: "processing";
    leaseId: string;
    leaseExpiresAtMs: number;
    completedAtMs: null;
  };
export type SubmittedWithdrawalDocument = WithdrawalIdentity &
  SubmittedEvidence &
  NoBlock & {
    status: "submitted";
    leaseId: string;
    leaseExpiresAtMs: number;
    completedAtMs: null;
  };
export type CompletedWithdrawalDocument = WithdrawalIdentity &
  NoLease &
  NoBlock & {
    status: "completed";
    transactionSignature: string;
    signedTransactionBase64: string | null;
    blockhash: string | null;
    lastValidBlockHeight: number | null;
    submittedAtMs: number;
    completedAtMs: number;
  };
export type BlockedWithdrawalDocument = WithdrawalIdentity &
  NoLease & {
    status: "blocked";
    transactionSignature: string | null;
    signedTransactionBase64: string | null;
    blockhash: string | null;
    lastValidBlockHeight: number | null;
    submittedAtMs: number | null;
    completedAtMs: null;
    observedOwner: string | null;
    blockReason: WithdrawalBlockReason;
    blockedAtMs: number;
    sourceDigest: string | null;
  };
export type WithdrawalDocument =
  | ProcessingWithdrawalDocument
  | SubmittedWithdrawalDocument
  | CompletedWithdrawalDocument
  | BlockedWithdrawalDocument;
export declare function readWithdrawalDocument(
  value: unknown,
): WithdrawalDocument | null;
export declare function readStoredWithdrawalDocument(
  value: unknown,
): WithdrawalDocument | null;
export declare function storedWithdrawalMatchesIdentity(
  value: WithdrawalDocument,
  eventId: string,
  prizeId: string,
): boolean;
export declare function withdrawalStatus(
  value: WithdrawalDocument | null | undefined,
): WithdrawalStatus | null;
export declare function withdrawalExecutionStatus(
  value: WithdrawalDocument | null | undefined,
): WithdrawalStatus | "";
export declare function withdrawalIdentity(
  value: WithdrawalDocument | null | undefined,
): {
  eventId: string;
  prizeId: string;
  assetAddress: string;
  assetStandard: string;
};
export declare function withdrawalOwnership(
  value: WithdrawalDocument | null | undefined,
): {
  profileId: string;
  entitledProfileId: string;
  requesterUid: string;
};
export declare function withdrawalRecipientAddress(
  value: WithdrawalDocument | null | undefined,
): string;
export declare function withdrawalLeaseId(
  value: WithdrawalDocument | null | undefined,
): string;
export declare function withdrawalLeaseExpiresAtMs(
  value: WithdrawalDocument | null | undefined,
): number;
export declare function withdrawalPlace(
  value: WithdrawalDocument | null | undefined,
): number;
export declare function withdrawalStartedAtForClaim(
  value: WithdrawalDocument | null,
  nowMs: number,
): number;
export declare function withdrawalSubmittedAtForPersistence(
  value: WithdrawalDocument,
  now: () => number,
): number;
export declare function withdrawalStartedAtForCompletion(
  value: WithdrawalDocument,
  _completedAtMs: number,
): number;
export declare function withdrawalSubmittedAtForCompletion(
  value: WithdrawalDocument,
  completedAtMs: number,
): number;
export declare function withdrawalStorageUpdatedAtMs(
  value: WithdrawalDocument,
): number;
export declare function withdrawalSubmissionStrings(
  value: WithdrawalDocument | null | undefined,
): {
  signedTransactionBase64: string;
  transactionSignature: string;
  blockhash: string;
};
export declare function withdrawalLastValidBlockHeight(
  value: WithdrawalDocument | null | undefined,
): number | null;
export type WithdrawalResponseFields = {
  eventId: string;
  prizeId: string;
  assetAddress: string;
  recipientAddress: string;
  transactionSignature: string;
};
export declare function withdrawalResponseFields(
  value: WithdrawalDocument,
): WithdrawalResponseFields;
export type WithdrawalClaimFields = Omit<
  WithdrawalIdentity,
  "schemaVersion"
> & {
  status?: never;
  leaseId: string;
  leaseExpiresAtMs: number;
};
export declare function writeProcessingWithdrawal(
  value: WithdrawalClaimFields,
): ProcessingWithdrawalDocument;
export declare function writeReacquiredSubmittedWithdrawal(
  previous: WithdrawalDocument,
  value: WithdrawalClaimFields,
): SubmittedWithdrawalDocument;
export declare function writeBlockedWithdrawal(
  current: WithdrawalDocument,
  observedOwner: string,
  updatedAtMs: number,
): BlockedWithdrawalDocument;
export declare function writeSubmittedWithdrawal(
  current: WithdrawalDocument,
  evidence: WithdrawalSubmissionEvidence,
  submittedAtMs: number,
  updatedAtMs: number,
): SubmittedWithdrawalDocument;
export type CompletedWithdrawalWrite = Omit<
  WithdrawalIdentity,
  "schemaVersion"
> & {
  status: "completed";
  transactionSignature: string;
  startedAtMs: number;
  submittedAtMs: number;
  completedAtMs: number;
  updatedAtMs: number;
  signedTransactionBase64: string | null;
  blockhash: string | null;
  lastValidBlockHeight: number | null;
};
export declare function writeCompletedWithdrawal(
  value: CompletedWithdrawalWrite,
): CompletedWithdrawalDocument;
export {};
