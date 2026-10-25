// Generated from src/telegram/deliveryCleanupRecords.ts. Run npm run generate:runtime.
import type { TransactionDecision } from "../transactions.js";
import type {
  TelegramRetryFailure,
  TelegramRetryState,
} from "./deliveryRetryTypes.js";
import {
  type CleanupAcquireDecision,
  type FinishStatusInput,
} from "./deliveryState.js";
import type { TelegramMessageDocument } from "./records.js";
type OrphanPendingDeleteRecordInput = {
  apiGateSettleOwner: FinishStatusInput["apiGateSettleOwner"];
  nowMs: number;
  ownerToken: string;
  pendingDeleteId: string;
  result: TelegramRetryFailure | undefined;
};
export declare function orphanPendingDeleteRecord(
  current: TelegramMessageDocument,
  input: OrphanPendingDeleteRecordInput,
): TransactionDecision<TelegramMessageDocument>;
type RecordCleanupRetryProofInput = {
  apiGateOwner: string;
  barrierRetryNotBeforeMs: number;
  ownerToken: string;
  pendingDeleteId: string;
  retryState: TelegramRetryState;
  revision: string;
};
export declare function recordCleanupRetryProof(
  current: TelegramMessageDocument,
  input: RecordCleanupRetryProofInput,
): TransactionDecision<TelegramMessageDocument>;
type RecordCleanupRetryStateInput = {
  finalizedAtMs: number;
  ownerToken: string;
  pendingDeleteId: string;
  preserveApiGateIdentity: boolean;
  result: TelegramRetryFailure | undefined;
  retryState: TelegramRetryState;
};
export declare function recordCleanupRetryState(
  current: TelegramMessageDocument,
  input: RecordCleanupRetryStateInput,
): TransactionDecision<TelegramMessageDocument>;
type AcquirePendingDeleteRecordInput = {
  leaseTtlMs: number;
  normalizedMessageKey: string;
  nowMs: number;
  ownerToken: string;
  requestedGeneration: string | undefined;
  requestedPendingDeleteId: string | undefined;
  observeDecision(decision: CleanupAcquireDecision): void;
};
export declare function acquirePendingDeleteRecord(
  current: TelegramMessageDocument,
  input: AcquirePendingDeleteRecordInput,
): TransactionDecision<TelegramMessageDocument>;
type ClearPendingDeleteRecordInput = {
  apiGateOwner: string;
  ownerToken: string;
  pendingDeleteId: string;
};
export declare function clearPendingDeleteRecord(
  current: TelegramMessageDocument,
  input: ClearPendingDeleteRecordInput,
): TransactionDecision<TelegramMessageDocument>;
export {};
