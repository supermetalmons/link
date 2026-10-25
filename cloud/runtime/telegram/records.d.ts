// Generated from src/telegram/records.ts. Run npm run generate:runtime.
import type { TelegramDesired } from "./desiredStateCore.js";
import type {
  TelegramDeliveryErrorState,
  TelegramRetryState,
} from "./deliveryRetryTypes.js";
declare const telegramDocument: unique symbol;
type RetainedTelegramDocument<Kind extends string> = {
  readonly [telegramDocument]: Kind;
};
export type TelegramMessageDocument = RetainedTelegramDocument<"message">;
export type TelegramControlDocument = RetainedTelegramDocument<"control">;
export type TelegramDesiredDocument = RetainedTelegramDocument<"desired">;
export type TelegramDeliveryDocument = RetainedTelegramDocument<"delivery">;
export type TelegramCleanupDocument = RetainedTelegramDocument<"cleanup">;
export type TelegramAppliedDocument = RetainedTelegramDocument<"applied">;
export type TelegramRecoveryDocument = RetainedTelegramDocument<"recovery">;
export type TelegramApiGateDocument = RetainedTelegramDocument<"api-gate">;
export type TelegramSendEvidence = RetainedTelegramDocument<"send-evidence">;
export type TelegramRetryProofDocument =
  RetainedTelegramDocument<"retry-proof">;
export type TelegramCleanupQueueDocument =
  RetainedTelegramDocument<"cleanup-queue">;
export type TelegramOrphanedDeletesDocument =
  RetainedTelegramDocument<"orphaned-deletes">;
export type TelegramRecoveryResultDocument =
  RetainedTelegramDocument<"recovery-result">;
export type TelegramRetryDocument = RetainedTelegramDocument<"retry-state">;
export type TelegramAutomatchProjectionGuardWrite = {
  schemaVersion: 1;
  lifecycle: "pending" | "matched" | "canceled";
  sourceGeneration: number;
  sourceRevision: string;
  resultDigests: Record<string, string>;
};
export type TelegramAppliedReceiptWrite = {
  destination: TelegramDesired["destination"];
  chatId: string;
  messageId: number;
  instanceKey: string;
  revision: string;
  contentHash?: string;
  appliedAtMs: number;
};
export type TelegramManualRecoveryWrite = {
  requestId: string;
} & (
  | {
      action: "confirm-send-applied";
      messageId: number;
    }
  | {
      action: "confirm-send-absent" | "abandon";
      messageId?: never;
    }
);
export type TelegramApiOperation =
  "send" | "edit" | "delete" | "pending-delete";
export type TelegramApiGateWrite = {
  owner: string;
  messageKey: string;
  revision: string;
  operation: TelegramApiOperation;
  acquiredAtMs: number;
  taskGeneration?: string;
  attemptId?: string;
  pendingDeleteId?: string;
};
export type TelegramRetryProofWrite = TelegramRetryState & {
  owner: string;
  retryNotBeforeMs: number;
  revision: string;
  safeRejectedAttemptId?: string;
  pendingDeleteId?: string;
  retryProofLeaseOwner?: string;
  proofTaskKind?: "desired" | "pending-delete";
};
export type TelegramMessageFields = {
  desired?: TelegramDesired | TelegramDesiredDocument;
  delivery?: TelegramDeliveryDocument;
  applied?: TelegramAppliedReceiptWrite | TelegramAppliedDocument;
  manualRecovery?: TelegramManualRecoveryWrite | TelegramRecoveryDocument;
  automatchProjection?: TelegramAutomatchProjectionGuardWrite;
};
export type TelegramControlFields = {
  retryNotBeforeMs?: number;
  apiGate?: TelegramApiGateWrite | TelegramApiGateDocument;
};
export type TelegramDeliveryMetadata = {
  attempts?: number;
  startedAtMs?: number;
  deliveredAtMs?: number;
  deadLetterAtMs?: number;
  uncertainAtMs?: number;
  uncertainReason?: string;
  safeRejectionAtMs?: number;
  safeRejectionRecoveredAtMs?: number;
  retryWindowRecoveredAtMs?: number;
  lastRejectedAttemptId?: string;
  lastError?: TelegramDeliveryErrorState;
  apiGateOwner?: string;
  apiGateGeneration?: string;
  apiGateStartedAtMs?: number;
  apiGateSettleOwner?: string;
  pendingDeleteApiGateSettleOwner?: string;
  apiGateReleaseOwner?: string;
  apiGateProofRequired?: TelegramRetryProofWrite | TelegramRetryProofDocument;
  lastRecoveryRequestId?: string;
  pendingDelete?: TelegramCleanupDocument;
  pendingDeleteQueue?: TelegramCleanupQueueDocument;
  orphanedDeletes?: TelegramOrphanedDeletesDocument;
  appliedStateUnknown?: {
    revision: string;
    operation: "edit" | "delete";
    apiGateOwner: string;
    markedAtMs: number;
  };
  abandonedSend?: TelegramSendEvidence;
};
export type TelegramCleanupFields = TelegramDeliveryMetadata & {
  pendingDeleteId?: string;
  chatId?: string;
  messageId?: number;
  instanceKey?: string;
};
export declare function readTelegramMessageDocument(
  value: unknown,
): TelegramMessageDocument | null;
export declare function readTelegramControlDocument(
  value: unknown,
): TelegramControlDocument | null;
export declare function messageDocument(
  value: unknown,
): TelegramMessageDocument;
export declare function controlDocument(
  value: unknown,
): TelegramControlDocument;
export declare function apiGateDocument(
  value: unknown,
): TelegramApiGateDocument;
export declare function appliedDocument(
  value: unknown,
): TelegramAppliedDocument;
export declare function desiredDocument(
  value: unknown,
): TelegramDesiredDocument;
export declare function updateTelegramApplied(
  current: TelegramAppliedDocument,
  fields: Partial<TelegramAppliedReceiptWrite>,
): TelegramAppliedDocument;
export declare function sendEvidenceDocument(
  value: unknown,
): TelegramSendEvidence;
export declare function messageDeliveryDocument(
  value: TelegramMessageDocument | null | undefined,
): TelegramDeliveryDocument;
export declare function messageDesiredDocument(
  value: TelegramMessageDocument | null | undefined,
): TelegramDesiredDocument;
export declare function messageDesiredRevision(
  value: TelegramMessageDocument | null | undefined,
): string;
export declare function messageAppliedDocument(
  value: TelegramMessageDocument | null | undefined,
): TelegramAppliedDocument;
export declare function messageRecoveryResultDocument(
  value: TelegramMessageDocument | null | undefined,
): TelegramRecoveryResultDocument;
export declare class AppliedMessageSnapshot {
  private readonly document;
  constructor(document: TelegramAppliedDocument);
  get chatId(): string;
  get messageId(): number | undefined;
  hasMessageId(): this is this & {
    messageId: number;
  };
  retainedDocument(): TelegramAppliedDocument;
}
export declare function readMessageApplied(
  value: TelegramMessageDocument,
): AppliedMessageSnapshot;
export declare function telegramApiGateOwner(
  value: TelegramApiGateDocument | null | undefined,
): string;
export declare function updateTelegramMessage(
  current: TelegramMessageDocument,
  fields: TelegramMessageFields,
): TelegramMessageDocument;
export declare function omitTelegramMessageFields(
  current: TelegramMessageDocument,
  fields: readonly (keyof TelegramMessageFields)[],
): TelegramMessageDocument;
export declare function updateTelegramControl(
  current: TelegramControlDocument,
  fields: TelegramControlFields,
): TelegramControlDocument;
export declare function clearTelegramApiGate(
  current: TelegramControlDocument,
): TelegramControlDocument;
export {};
