// Generated from src/telegram/deliveryRecoveryRecords.ts. Run npm run generate:runtime.
import type { TransactionResult } from "../transactions.js";
import type { TelegramProofApplicationDocument } from "./retryRecords.js";
import type { TransactionDecision } from "../transactions.js";
import type { TelegramRetryState } from "./deliveryRetryTypes.js";
import type { TelegramMessageDocument } from "./records.js";
type ApplySafeRetryProofRecordInput = {
  normalizedAttemptId: string;
  normalizedRevision: string;
  now: () => number;
  markApplied(): void;
  application: TelegramProofApplicationDocument;
};
export declare function applySafeRetryProofRecord(
  current: TelegramMessageDocument,
  input: ApplySafeRetryProofRecordInput,
): TransactionDecision<TelegramMessageDocument>;
type ApplyDesiredRetryProofRecordInput = {
  normalizedRevision: string;
  now: () => number;
  proofRetryState: TelegramRetryState;
  markApplied(): void;
  application: TelegramProofApplicationDocument;
};
export declare function applyDesiredRetryProofRecord(
  current: TelegramMessageDocument,
  input: ApplyDesiredRetryProofRecordInput,
): TransactionDecision<TelegramMessageDocument>;
type ApplyManualRecoveryRecordInput = {
  processedAtMs: number;
};
export declare function applyManualRecoveryRecord(
  current: TelegramMessageDocument,
  input: ApplyManualRecoveryRecordInput,
): TransactionDecision<TelegramMessageDocument>;
type SettleManualGateReleaseRecordInput = {
  owner: string;
};
export declare function settleManualGateReleaseRecord(
  current: TelegramMessageDocument,
  input: SettleManualGateReleaseRecordInput,
): TransactionDecision<TelegramMessageDocument>;
type ApplyCleanupRetryProofRecordInput = {
  normalizedPendingDeleteId: string;
  now: () => number;
  proofRetryState: TelegramRetryState;
  markApplied(): void;
  application: TelegramProofApplicationDocument;
};
export declare function applyCleanupRetryProofRecord(
  current: TelegramMessageDocument,
  input: ApplyCleanupRetryProofRecordInput,
): TransactionDecision<TelegramMessageDocument>;
export declare function observeManualRecoveryResult(
  result: TransactionResult<TelegramMessageDocument>,
): {
  processed: boolean;
  action: string;
  apiGateReleaseOwner: string;
  shouldContinue: boolean;
};
export {};
