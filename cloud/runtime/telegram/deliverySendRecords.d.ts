// Generated from src/telegram/deliverySendRecords.ts. Run npm run generate:runtime.
import type { TelegramSendAttemptDocument } from "./desiredRecords.js";
import type { TelegramSendSuccess } from "./client.js";
import { DeliverySnapshot } from "./deliveryState.js";
import type {
  TelegramMessageDocument,
  TelegramAppliedDocument,
} from "./records.js";
type MarkSendInFlightRecordInput = {
  desired: {
    readonly revision: string;
  };
  marker: TelegramSendAttemptDocument;
};
export declare function markSendInFlightRecord(
  current: TelegramMessageDocument,
  delivery: DeliverySnapshot,
  input: MarkSendInFlightRecordInput,
): TelegramMessageDocument;
type AcknowledgeSendRecordInput = {
  applied: TelegramAppliedDocument;
  chatId: string;
  desired: {
    readonly revision: string;
  };
  marker: TelegramSendAttemptDocument;
  nowMs: number;
  previousApplied: TelegramAppliedDocument | null;
  result: TelegramSendSuccess;
};
export declare function acknowledgeSendRecord(
  current: TelegramMessageDocument,
  delivery: DeliverySnapshot,
  input: AcknowledgeSendRecordInput,
): TelegramMessageDocument;
export {};
