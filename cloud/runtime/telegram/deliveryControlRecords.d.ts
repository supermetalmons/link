// Generated from src/telegram/deliveryControlRecords.ts. Run npm run generate:runtime.
import type { TransactionDecision } from "../transactions.js";
import { DeliverySnapshot } from "./deliveryState.js";
import type { TelegramMessageDocument } from "./records.js";
type ClearRateLimitProofRecordInput = {
  owner: string;
};
export declare function clearRateLimitProofRecord(
  current: TelegramMessageDocument,
  input: ClearRateLimitProofRecordInput,
): TransactionDecision<TelegramMessageDocument>;
type PrepareDesiredGateRecordInput = {
  generation: string;
  messageKey: string;
  preparedAtMs: number;
  revision: string;
};
export declare function prepareDesiredGateRecord(
  current: TelegramMessageDocument,
  delivery: DeliverySnapshot,
  input: PrepareDesiredGateRecordInput,
): TelegramMessageDocument;
type SettleApiGateRecordInput = {
  field: "apiGateSettleOwner" | "pendingDeleteApiGateSettleOwner";
  settleOwner: string;
};
export declare function settleApiGateRecord(
  current: TelegramMessageDocument,
  input: SettleApiGateRecordInput,
): TransactionDecision<TelegramMessageDocument>;
export {};
