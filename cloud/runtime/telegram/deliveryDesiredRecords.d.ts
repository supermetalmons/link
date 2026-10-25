// Generated from src/telegram/deliveryDesiredRecords.ts. Run npm run generate:runtime.
import type { TransactionDecision } from "../transactions.js";
import type {
  TelegramRetryFailure,
  TelegramRetryState,
} from "./deliveryRetryTypes.js";
import {
  DeliverySnapshot,
  type DesiredAcquireDecision,
  type AppliedReceiptAction,
  type FinishStatusInput,
} from "./deliveryState.js";
import type { TelegramMessageDocument } from "./records.js";
type AcquireDesiredRecordInput = {
  leaseTtlMs: number;
  nowMs: number;
  ownerToken: string;
  observeDecision(decision: DesiredAcquireDecision): void;
};
export declare function acquireDesiredRecord(
  current: TelegramMessageDocument,
  input: AcquireDesiredRecordInput,
): TransactionDecision<TelegramMessageDocument>;
type FinishDesiredRecordInput = {
  apiGateSettleOwner: FinishStatusInput["apiGateSettleOwner"];
  clearAppliedStateUnknown: boolean;
  desired: {
    readonly revision: string;
  };
  nowMs: number;
  receipt: AppliedReceiptAction | undefined;
  result: TelegramRetryFailure | undefined;
  status: FinishStatusInput["status"];
};
export declare function finishDesiredRecord(
  current: TelegramMessageDocument,
  delivery: DeliverySnapshot,
  input: FinishDesiredRecordInput,
): TelegramMessageDocument;
type RecordDesiredRetryProofInput = {
  apiGateOwner: string;
  barrierRetryNotBeforeMs: number;
  desired: {
    readonly revision: string;
  };
  ownerToken: string;
  pendingDeleteId: string;
  proofTaskKind: "desired" | "pending-delete";
  retryState: TelegramRetryState;
  safeRejectedAttemptId: string;
};
export declare function recordDesiredRetryProof(
  current: TelegramMessageDocument,
  delivery: DeliverySnapshot,
  input: RecordDesiredRetryProofInput,
): TelegramMessageDocument;
type RecordDesiredRetryStateInput = {
  desired: {
    readonly revision: string;
  };
  finalizedAtMs: number;
  preserveApiGateIdentity: boolean;
  result: TelegramRetryFailure | undefined;
  retryState: TelegramRetryState;
};
export declare function recordDesiredRetryState(
  current: TelegramMessageDocument,
  delivery: DeliverySnapshot,
  input: RecordDesiredRetryStateInput,
): TelegramMessageDocument;
type MarkAppliedStateUnknownRecordInput = {
  apiGateOwner: string;
  desired: {
    readonly revision: string;
  };
  markedAtMs: number;
  operation: "edit" | "delete";
};
export declare function markAppliedStateUnknownRecord(
  current: TelegramMessageDocument,
  delivery: DeliverySnapshot,
  input: MarkAppliedStateUnknownRecordInput,
): TelegramMessageDocument;
type ClearMissingAppliedRecordInput = {
  apiGateOwner: string;
};
export declare function clearMissingAppliedRecord(
  current: TelegramMessageDocument,
  delivery: DeliverySnapshot,
  input: ClearMissingAppliedRecordInput,
): TelegramMessageDocument;
export {};
