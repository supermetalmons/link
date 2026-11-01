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
  | { status: "accepted"; messageId?: number; code?: never }
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

export type TelegramManualRecoveryWrite = { requestId: string } & (
  | { action: "confirm-send-applied"; messageId: number }
  | { action: "confirm-send-absent" | "abandon"; messageId?: never }
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

export function messageDocument(
  value: TelegramMessageDocument | null | undefined,
): TelegramMessageDocument {
  return value ?? { schemaVersion: 1 };
}
export function controlDocument(
  value?: TelegramControlDocument | null,
): TelegramControlDocument {
  return value ?? { schemaVersion: 1 };
}
export function apiGateDocument(
  value: TelegramApiGateDocument,
): TelegramApiGateDocument {
  return value;
}
export function appliedDocument(
  value: TelegramAppliedDocument,
): TelegramAppliedDocument {
  return value;
}
export function desiredDocument(
  value: TelegramDesiredDocument,
): TelegramDesiredDocument {
  return value;
}
export function sendEvidenceDocument(
  value: TelegramSendEvidence,
): TelegramSendEvidence {
  return value;
}
export function updateTelegramApplied(
  current: TelegramAppliedDocument,
  fields: Partial<TelegramAppliedReceiptWrite>,
): TelegramAppliedDocument {
  return { ...current, ...fields };
}
export function messageDeliveryDocument(
  value: TelegramMessageDocument | null | undefined,
): Partial<TelegramDeliveryDocument> {
  return value?.delivery ?? {};
}
export function messageDesiredDocument(
  value: TelegramMessageDocument | null | undefined,
): TelegramDesiredDocument | undefined {
  return value?.desired;
}
export function messageDesiredRevision(
  value: TelegramMessageDocument | null | undefined,
): string {
  return value?.desired?.revision ?? "";
}
export function messageAppliedDocument(
  value: TelegramMessageDocument | null | undefined,
): TelegramAppliedDocument | undefined {
  return value?.applied;
}
export function messageRecoveryResultDocument(
  value: TelegramMessageDocument | null | undefined,
): TelegramRecoveryResultDocument | undefined {
  return value?.manualRecoveryResult;
}
export class AppliedMessageSnapshot {
  constructor(private readonly document: TelegramAppliedDocument | undefined) {}
  get chatId(): string {
    return this.document?.chatId ?? "";
  }
  get messageId(): number | undefined {
    return this.document?.messageId;
  }
  hasMessageId(): this is this & { messageId: number } {
    return this.document !== undefined;
  }
  retainedDocument(): TelegramAppliedDocument {
    if (!this.document) throw new TypeError("telegram-applied-message-missing");
    return this.document;
  }
}
export function readMessageApplied(
  value: TelegramMessageDocument,
): AppliedMessageSnapshot {
  return new AppliedMessageSnapshot(value.applied);
}
export function telegramApiGateOwner(
  value: TelegramApiGateDocument | null | undefined,
): string {
  return value?.owner ?? "";
}
export function updateTelegramMessage(
  current: TelegramMessageDocument,
  fields: TelegramMessageFields,
): TelegramMessageDocument {
  return { ...current, ...fields };
}
export function omitTelegramMessageFields(
  current: TelegramMessageDocument,
  fields: readonly (keyof TelegramMessageFields)[],
): TelegramMessageDocument {
  const output = { ...current };
  for (const field of fields) delete output[field];
  return output;
}
export function updateTelegramControl(
  current: TelegramControlDocument,
  fields: TelegramControlFields,
): TelegramControlDocument {
  return { ...current, ...fields };
}
export function clearTelegramApiGate(
  current: TelegramControlDocument,
): TelegramControlDocument {
  const output = { ...current };
  delete output.apiGate;
  return output;
}
