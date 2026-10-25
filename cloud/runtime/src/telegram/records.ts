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

type SourceRecord = Record<string, unknown>;
const record = (value: unknown): SourceRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as SourceRecord)
    : null;

export function readTelegramMessageDocument(
  value: unknown,
): TelegramMessageDocument | null {
  const source = record(value);
  return source as TelegramMessageDocument | null;
}

export function readTelegramControlDocument(
  value: unknown,
): TelegramControlDocument | null {
  const source = record(value);
  return source as TelegramControlDocument | null;
}

export function messageDocument(value: unknown): TelegramMessageDocument {
  return (record(value) || {}) as TelegramMessageDocument;
}

export function controlDocument(value: unknown): TelegramControlDocument {
  return (record(value) || {}) as TelegramControlDocument;
}

export function apiGateDocument(value: unknown): TelegramApiGateDocument {
  return (record(value) || {}) as TelegramApiGateDocument;
}

export function appliedDocument(value: unknown): TelegramAppliedDocument {
  return (record(value) || {}) as TelegramAppliedDocument;
}

export function desiredDocument(value: unknown): TelegramDesiredDocument {
  return (record(value) || {}) as TelegramDesiredDocument;
}

export function updateTelegramApplied(
  current: TelegramAppliedDocument,
  fields: Partial<TelegramAppliedReceiptWrite>,
): TelegramAppliedDocument {
  const value: unknown = { ...current, ...fields };
  return value as TelegramAppliedDocument;
}

export function sendEvidenceDocument(value: unknown): TelegramSendEvidence {
  return value as TelegramSendEvidence;
}

export function messageDeliveryDocument(
  value: TelegramMessageDocument | null | undefined,
): TelegramDeliveryDocument {
  return (record(record(value)?.delivery) || {}) as TelegramDeliveryDocument;
}

export function messageDesiredDocument(
  value: TelegramMessageDocument | null | undefined,
): TelegramDesiredDocument {
  return (record(record(value)?.desired) || {}) as TelegramDesiredDocument;
}

export function messageDesiredRevision(
  value: TelegramMessageDocument | null | undefined,
): string {
  const desired = record(value)?.desired as
    { revision?: unknown } | null | undefined;
  const revision = desired?.revision;
  return typeof revision === "string" && revision.trim() !== ""
    ? revision.trim()
    : "";
}

export function messageAppliedDocument(
  value: TelegramMessageDocument | null | undefined,
): TelegramAppliedDocument {
  return (record(record(value)?.applied) || {}) as TelegramAppliedDocument;
}

export function messageRecoveryResultDocument(
  value: TelegramMessageDocument | null | undefined,
): TelegramRecoveryResultDocument {
  return (record(record(value)?.manualRecoveryResult) ||
    {}) as TelegramRecoveryResultDocument;
}

export class AppliedMessageSnapshot {
  constructor(private readonly document: TelegramAppliedDocument) {}

  get chatId(): string {
    const value = record(this.document)?.chatId;
    return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
  }

  get messageId(): number | undefined {
    const value = record(this.document)?.messageId;
    return typeof value === "number" ? value : undefined;
  }

  hasMessageId(): this is this & { messageId: number } {
    const source = record(this.document)!;
    return (
      typeof source.messageId === "number" &&
      Number.isInteger(source.messageId) &&
      source.messageId > 0
    );
  }

  retainedDocument(): TelegramAppliedDocument {
    return this.document;
  }
}

export function readMessageApplied(
  value: TelegramMessageDocument,
): AppliedMessageSnapshot {
  return new AppliedMessageSnapshot(messageAppliedDocument(value));
}

export function telegramApiGateOwner(
  value: TelegramApiGateDocument | null | undefined,
): string {
  const retained: unknown = value;
  const evidence = retained as { owner?: unknown } | null | undefined;
  const owner = evidence?.owner;
  return typeof owner === "string" && owner.trim() !== "" ? owner.trim() : "";
}

export function updateTelegramMessage(
  current: TelegramMessageDocument,
  fields: TelegramMessageFields,
): TelegramMessageDocument {
  const value: unknown = { ...current, ...fields };
  return value as TelegramMessageDocument;
}

export function omitTelegramMessageFields(
  current: TelegramMessageDocument,
  fields: readonly (keyof TelegramMessageFields)[],
): TelegramMessageDocument {
  const output: SourceRecord = { ...current };
  for (const field of fields) delete output[field];
  return output as TelegramMessageDocument;
}

export function updateTelegramControl(
  current: TelegramControlDocument,
  fields: TelegramControlFields,
): TelegramControlDocument {
  const value: unknown = { ...current, ...fields };
  return value as TelegramControlDocument;
}

export function clearTelegramApiGate(
  current: TelegramControlDocument,
): TelegramControlDocument {
  const output: SourceRecord = { ...current };
  delete output.apiGate;
  return output as TelegramControlDocument;
}
