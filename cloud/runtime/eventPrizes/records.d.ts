// Generated from src/eventPrizes/records.ts. Run npm run generate:runtime.
import type { EventPrizeStandard } from "../shared/event-prizes.js";
declare const withdrawalDocument: unique symbol;
declare const completedWithdrawalWrite: unique symbol;
export type WithdrawalDocument = {
  readonly [withdrawalDocument]: true;
};
export type CompletedWithdrawalDocument = WithdrawalDocument & {
  readonly [completedWithdrawalWrite]: true;
};
export type WithdrawalStatus =
  "blocked" | "completed" | "processing" | "submitted";
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
): string;
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
  value: WithdrawalDocument,
): number;
export declare function withdrawalPlace(
  value: WithdrawalDocument | null | undefined,
): number;
export declare function withdrawalStartedAtForClaim(
  value: WithdrawalDocument,
  nowMs: number,
): number;
export declare function withdrawalSubmittedAtForPersistence(
  value: WithdrawalDocument,
  now: () => number,
): number;
export declare function withdrawalStartedAtForCompletion(
  value: WithdrawalDocument,
  completedAtMs: number,
): number;
export declare function withdrawalSubmittedAtForCompletion(
  value: WithdrawalDocument,
  completedAtMs: number,
): number;
export declare function withdrawalStorageUpdatedAtMs(
  value: WithdrawalDocument,
): number;
export type WithdrawalSubmissionEvidence = {
  transactionSignature: string;
  signedTransactionBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
};
export declare function withdrawalSubmissionStrings(
  value: WithdrawalDocument | null | undefined,
): {
  signedTransactionBase64: string;
  transactionSignature: string;
  blockhash: string;
};
export declare function withdrawalLastValidBlockHeight(
  value: WithdrawalDocument | null | undefined,
): number;
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
export type WithdrawalClaimFields = {
  status?: never;
  eventId: string;
  prizeId: string;
  assetAddress: string;
  assetStandard: EventPrizeStandard | "";
  entitledProfileId: string;
  profileId: string;
  place: number;
  recipientAddress: string;
  requesterUid: string;
  leaseId: string;
  leaseExpiresAtMs: number;
  startedAtMs: number;
  updatedAtMs: number;
};
export declare function writeProcessingWithdrawal(
  value: WithdrawalClaimFields,
): WithdrawalDocument;
export declare function writeReacquiredSubmittedWithdrawal(
  previous: WithdrawalDocument,
  value: WithdrawalClaimFields,
): WithdrawalDocument;
export declare function writeBlockedWithdrawal(
  current: WithdrawalDocument,
  observedOwner: string,
  updatedAtMs: number,
): WithdrawalDocument;
export declare function writeSubmittedWithdrawal(
  current: WithdrawalDocument,
  evidence: WithdrawalSubmissionEvidence,
  submittedAtMs: number,
  updatedAtMs: number,
): WithdrawalDocument;
export type CompletedWithdrawalWrite = {
  eventId: string;
  prizeId: string;
  assetAddress: string;
  assetStandard: EventPrizeStandard | "";
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
};
export declare function writeCompletedWithdrawal(
  value: CompletedWithdrawalWrite,
): CompletedWithdrawalDocument;
export {};
