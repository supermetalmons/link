// Generated from src/telegram/records.ts. Run npm run generate:runtime.
import type { TelegramDesired } from "./desiredStateCore.js";
import type {
  TelegramDeliveryErrorState,
  TelegramRetryState,
} from "./deliveryRetryTypes.js";
export type TelegramDesiredDocument = TelegramDesired;
export type TelegramSendEvidence = {
  attemptId: string;
  revision: string;
  destination: TelegramDesired["destination"];
  chatId: string;
  instanceKey: string;
  contentHash: string;
  startedAtMs: number;
  apiGateOwner: string;
  abandonedAtMs?: number;
};
export type TelegramAppliedDocument = TelegramAppliedReceiptWrite & {
  recoveredAtMs?: number;
};
export type TelegramRecoveryDocument = TelegramManualRecoveryWrite;
export type TelegramApiGateDocument = TelegramApiGateWrite;
export type TelegramRetryProofDocument = TelegramRetryProofWrite;
export type TelegramRetryDocument = Partial<TelegramRetryState> & {
  apiGateStartedAtMs?: number;
};
export type TelegramCleanupDocument = TelegramCleanupFields &
  Partial<TelegramRetryState> & {
    status: "pending" | "processing" | "retryable";
    leaseOwner?: string;
    leaseExpiresAtMs?: number;
  };
export type TelegramCleanupQueueDocument = Record<
  string,
  TelegramCleanupDocument
>;
export type TelegramOrphanedDelete = Omit<TelegramCleanupDocument, "status"> & {
  terminalAtMs: number;
  lastError: TelegramDeliveryErrorState;
};
export type TelegramOrphanedDeletesDocument = Record<
  string,
  TelegramOrphanedDelete
>;
export type TelegramRecoveryResultDocument = {
  requestId: string;
  action: TelegramManualRecoveryWrite["action"];
  processedAtMs: number;
} & (
  | {
      status: "accepted";
      messageId?: number;
      code?: never;
    }
  | {
      status: "rejected";
      code:
        | "recovery-not-uncertain"
        | "invalid-manual-recovery"
        | "missing-send-in-flight";
      messageId?: never;
    }
);
export type TelegramDeliveryDocument = TelegramDeliveryMetadata &
  Partial<TelegramRetryState> & {
    status:
      | "pending"
      | "processing"
      | "retryable"
      | "delivered"
      | "terminal"
      | "uncertain";
    revision: string;
    leaseOwner?: string;
    leaseExpiresAtMs?: number;
    sendInFlight?: TelegramSendEvidence;
  };
export type TelegramMessageDocument = TelegramMessageFields & {
  schemaVersion: 1;
  manualRecoveryResult?: TelegramRecoveryResultDocument;
};
export type TelegramControlDocument = TelegramControlFields & {
  schemaVersion: 1;
};
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
  desired?: TelegramDesired;
  delivery?: TelegramDeliveryDocument;
  applied?: TelegramAppliedDocument;
  manualRecovery?: TelegramManualRecoveryWrite;
  automatchProjection?: TelegramAutomatchProjectionGuardWrite;
};
export type TelegramControlFields = {
  retryNotBeforeMs?: number;
  apiGate?: TelegramApiGateWrite;
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
  apiGateProofRequired?: TelegramRetryProofWrite;
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
  pendingDeleteId: string;
  chatId: string;
  messageId: number;
  instanceKey: string;
};
export {
  readTelegramMessageDocument,
  readTelegramControlDocument,
} from "./recordCodec.js";
export declare function messageDocument(
  value: TelegramMessageDocument | null | undefined,
): TelegramMessageDocument;
export declare function controlDocument(
  value?: TelegramControlDocument | null,
): TelegramControlDocument;
export declare function apiGateDocument(
  value: TelegramApiGateDocument,
): TelegramApiGateDocument;
export declare function appliedDocument(
  value: TelegramAppliedDocument,
): TelegramAppliedDocument;
export declare function desiredDocument(
  value: TelegramDesiredDocument,
): TelegramDesiredDocument;
export declare function sendEvidenceDocument(
  value: TelegramSendEvidence,
): TelegramSendEvidence;
export declare function updateTelegramApplied(
  current: TelegramAppliedDocument,
  fields: Partial<TelegramAppliedReceiptWrite>,
): TelegramAppliedDocument;
export declare function messageDeliveryDocument(
  value: TelegramMessageDocument | null | undefined,
): Partial<TelegramDeliveryDocument>;
export declare function messageDesiredDocument(
  value: TelegramMessageDocument | null | undefined,
): TelegramDesiredDocument | undefined;
export declare function messageDesiredRevision(
  value: TelegramMessageDocument | null | undefined,
): string;
export declare function messageAppliedDocument(
  value: TelegramMessageDocument | null | undefined,
): TelegramAppliedDocument | undefined;
export declare function messageRecoveryResultDocument(
  value: TelegramMessageDocument | null | undefined,
): TelegramRecoveryResultDocument | undefined;
export declare class AppliedMessageSnapshot {
  private readonly document;
  constructor(document: TelegramAppliedDocument | undefined);
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
