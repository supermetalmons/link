// Generated from src/telegram/desiredRecords.ts. Run npm run generate:runtime.
import type { TelegramEditInput, TelegramSendInput } from "./client.js";
import {
  type TelegramAppliedDocument,
  type TelegramMessageDocument,
  type TelegramSendEvidence,
} from "./records.js";
type DesiredIdentity = {
  readonly revision: string;
  readonly destinationDescription: string;
  resolveDestination(resolve: (destination: string) => string): string;
  matchesAppliedContent(applied: TelegramAppliedDocument): boolean;
  appliedTargetMismatch(
    applied: TelegramAppliedDocument,
    chatId: string,
  ): string | boolean;
  createSendMarker(
    attemptId: string,
    chatId: string,
    nowMs: number,
  ): TelegramSendAttemptDocument;
  createAppliedReceipt(
    chatId: string,
    messageId: number,
    nowMs: number,
  ): TelegramAppliedDocument;
  refreshAppliedReceipt(
    applied: TelegramAppliedDocument,
    chatId: string,
    nowMs: number,
  ): TelegramAppliedDocument;
};
type TextDesiredFields = DesiredIdentity & {
  readonly instanceKey: string;
  readonly text: string;
  sendInput(chatId: string): TelegramSendInput;
  editInput(chatId: string, messageId: number): TelegramEditInput;
};
export type TextDesiredView = TextDesiredFields &
  (
    | {
        readonly operation: "send";
        readonly ifMissing?: never;
      }
    | {
        readonly operation: "edit";
        readonly ifMissing: "send" | "skip";
      }
  );
export type RetainedDesiredView =
  | TextDesiredView
  | (DesiredIdentity & {
      readonly operation: "delete";
      readonly ifMissing?: never;
    });
export type TelegramSendAttemptDocument = TelegramSendEvidence & {
  readonly attemptId: string;
  readonly apiGateOwner: string;
};
export declare function acquiredDesiredView(
  message: TelegramMessageDocument,
): RetainedDesiredView;
export {};
