import type { TelegramExactRetryInput } from "./deliveryRetryTypes.js";
import type {
  TelegramProofInput,
  RetainedTelegramExactRetryInput,
  RetainedTelegramOwner,
} from "./retryRecords.js";
import * as crypto from "node:crypto";
import type {
  TransactionDecision,
  TransactionResult,
} from "../transactions.js";
import type {
  TelegramRetryFailure,
  TelegramRetryResult,
  TelegramRetryState,
} from "./deliveryRetryTypes.js";

import type { RetainedDesiredView } from "./desiredRecords.js";
import type {
  TelegramMessageDocument,
  TelegramDesiredDocument,
  TelegramDeliveryDocument,
  TelegramCleanupDocument,
  TelegramAppliedDocument,
  TelegramAppliedReceiptWrite,
  TelegramDeliveryMetadata,
  TelegramCleanupFields,
  TelegramRetryProofDocument,
  TelegramSendEvidence,
  TelegramOrphanedDeletesDocument,
  TelegramRetryDocument,
} from "./records.js";
import {
  retainTelegramDeleteInput,
  type RetainedTelegramDeleteInput,
} from "./client.js";
import { readProperty } from "./values.js";
import {
  readTelegramDelivery,
  readTelegramCleanup,
  readTelegramDesired,
} from "./recordCodec.js";
export type MessageMutation = (
  record: TelegramMessageDocument,
) => TransactionDecision<TelegramMessageDocument>;
export type OwnedMutation = (
  record: TelegramMessageDocument,
  delivery: DeliverySnapshot,
) => TelegramMessageDocument;
export type DesiredContext = {
  messageKey: string;
  ownerToken: string;
  desired: RetainedDesiredView;
};
export type AppliedReceiptAction =
  | { kind: "preserve"; value?: never }
  | {
      kind: "set";
      value: TelegramAppliedReceiptWrite | TelegramAppliedDocument;
    }
  | { kind: "clear"; value?: never };
export type DeliveredOptions = {
  receipt?: AppliedReceiptAction;
  clearAppliedStateUnknown?: boolean;
};
export type FinishStatusInput = DesiredContext & {
  nowMs: number;
  apiGateSettleOwner?: string | RetainedTelegramOwner;
} & (
    | ({
        status: "delivered";
        result?: never;
        receipt: AppliedReceiptAction;
      } & DeliveredOptions)
    | {
        status: "terminal" | "uncertain";
        result: TelegramRetryFailure;
        receipt?: never;
        clearAppliedStateUnknown?: never;
      }
  );
export type DeliveryStatus =
  | "pending"
  | "processing"
  | "retryable"
  | "delivered"
  | "terminal"
  | "uncertain";
export type CleanupStatus = "pending" | "processing" | "retryable";
type DeliveryLease = {
  leaseOwner: string;
  leaseExpiresAtMs: number;
};

export type DeliveryTransition =
  | { status: "pending"; revision: string; attempts?: number }
  | ({
      status: "processing";
      revision: string;
      attempts: number;
      startedAtMs: number;
    } & DeliveryLease)
  | ({
      status: "retryable";
      revision: string;
      attempts?: number;
    } & TelegramRetryState)
  | { status: "delivered"; revision: string; deliveredAtMs: number }
  | { status: "terminal"; revision: string }
  | {
      status: "uncertain";
      revision: string;
      sendInFlight: PreservedSendEvidence;
    };
export type CleanupTransition =
  | { status: "pending"; attempts: number }
  | ({ status: "processing"; attempts: number } & DeliveryLease)
  | ({ status: "retryable" } & TelegramRetryState);

export type DesiredAcquireDecision =
  | "missing"
  | "desired-api-gate-settle-pending"
  | "pending-api-gate-settle-pending"
  | "locked"
  | "rate-limit-proof-pending"
  | "pending-rate-limit-proof-pending"
  | "in-flight-uncertain"
  | "invalid"
  | "retry-exhausted"
  | "deferred"
  | "settled"
  | "acquired";

export type CleanupAcquireDecision =
  | "missing"
  | "stale"
  | "blocked-uncertain"
  | "invalid"
  | "rate-limit-proof-pending"
  | "locked"
  | "exhausted"
  | "deferred"
  | "acquired";

export type PreservedSendEvidence = TelegramSendEvidence | undefined;
export function preserveSendEvidence(
  value: TelegramSendEvidence | undefined,
  present = true,
): PreservedSendEvidence {
  return present ? value : undefined;
}
export function writeDelivery(
  transition: DeliveryTransition & TelegramDeliveryMetadata,
): TelegramDeliveryDocument {
  const output = { ...transition };
  if ("sendInFlight" in output && output.sendInFlight === undefined)
    Reflect.deleteProperty(output, "sendInFlight");
  const value = readTelegramDelivery(output);
  if (!value) throw new TypeError("invalid-telegram-delivery-transition");
  return value;
}
export function writeCleanup(
  transition: CleanupTransition & Partial<TelegramCleanupFields>,
): TelegramCleanupDocument {
  const value = readTelegramCleanup(transition);
  if (!value) throw new TypeError("invalid-telegram-cleanup-transition");
  return value;
}
export type ProofInput = TelegramProofInput;
export type ExactRetryInput =
  TelegramExactRetryInput | RetainedTelegramExactRetryInput;
export const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const hashValue = (value: unknown): string =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
class RetrySnapshot<
  T extends TelegramDeliveryDocument | TelegramCleanupDocument,
> {
  constructor(readonly document: Partial<T> = {}) {}
  get present(): boolean {
    return Object.keys(this.document).length > 0;
  }
  get attempts(): number {
    return this.document.attempts ?? 0;
  }
  get leaseOwner(): string {
    return this.document.leaseOwner ?? "";
  }
  get leaseExpiresAtMs(): number {
    return this.document.leaseExpiresAtMs ?? 0;
  }
  get retryStartedAtMs(): number {
    return this.document.retryStartedAtMs ?? 0;
  }
  get retryDeadlineAtMs(): number {
    return this.document.retryDeadlineAtMs ?? 0;
  }
  get retryAtMs(): number {
    return this.document.retryAtMs ?? 0;
  }
  get retrySequence(): number {
    return this.document.retrySequence ?? 0;
  }
  retryTimestampOr(
    field: "retryStartedAtMs" | "retryDeadlineAtMs",
    fallback: number | undefined,
  ): number {
    return this.document[field] ?? fallback ?? 0;
  }
  retrySequenceOr(fallback: number | undefined): number {
    return this.document.retrySequence ?? fallback ?? 0;
  }
  get apiGateOwner(): string {
    return this.document.apiGateOwner ?? "";
  }
  get apiGateGeneration(): string {
    return this.document.apiGateGeneration ?? "";
  }
  get apiGateStartedAtMs(): number {
    return this.document.apiGateStartedAtMs ?? 0;
  }
  get apiGateProofRequired(): TelegramRetryProofDocument | undefined {
    return this.document.apiGateProofRequired;
  }
  get apiGateProofOwner(): string {
    return this.document.apiGateProofRequired?.owner ?? "";
  }
}
export function deliveryDocument(
  value: DeliverySnapshot,
): Partial<TelegramDeliveryDocument> {
  return value.document;
}
export function pendingDeleteDocument(
  value: PendingDeleteSnapshot,
): Partial<TelegramCleanupDocument> {
  return value.document;
}
export function retryDocument(
  value:
    | Partial<TelegramDeliveryDocument>
    | Partial<TelegramCleanupDocument>
    | DeliverySnapshot
    | PendingDeleteSnapshot,
): TelegramRetryDocument {
  return value instanceof DeliverySnapshot ||
    value instanceof PendingDeleteSnapshot
    ? value.document
    : value;
}
export class DeliverySnapshot extends RetrySnapshot<TelegramDeliveryDocument> {
  get status(): DeliveryStatus | undefined {
    const status = this.document.status;
    return status === "pending" ||
      status === "processing" ||
      status === "retryable" ||
      status === "delivered" ||
      status === "terminal" ||
      status === "uncertain"
      ? status
      : undefined;
  }

  get kind(): DeliveryStatus | "missing" {
    return this.status ?? "missing";
  }

  get revision(): string | undefined {
    return typeof this.document.revision === "string"
      ? (this.document.revision as string)
      : undefined;
  }

  matchesRevision(revision: string): this is this & { revision: string } {
    return (
      typeof this.document.revision === "string" &&
      normalizeString(this.document.revision) === revision
    );
  }

  get sendInFlight(): TelegramSendEvidence | undefined {
    return this.document.sendInFlight;
  }

  get hasSendInFlight(): boolean {
    return Boolean(this.document.sendInFlight);
  }

  get hasAppliedStateUnknown(): boolean {
    return Boolean(this.document.appliedStateUnknown);
  }

  get hasRawApiGateOwner(): boolean {
    return Boolean(this.document.apiGateOwner);
  }

  sendInFlightMatchesRevision(revision: string): boolean {
    return readProperty(this.document.sendInFlight, "revision") === revision;
  }

  preservedSendInFlight(): PreservedSendEvidence {
    return preserveSendEvidence(
      this.document.sendInFlight,
      Object.hasOwn(this.document, "sendInFlight"),
    );
  }

  get pendingDelete(): PendingDeleteSnapshot {
    return new PendingDeleteSnapshot(this.document.pendingDelete);
  }

  get orphanedDeletes(): TelegramOrphanedDeletesDocument {
    return this.document.orphanedDeletes ?? {};
  }

  get apiGateSettleOwner(): string {
    return normalizeString(this.document.apiGateSettleOwner);
  }

  get pendingDeleteApiGateSettleOwner(): string {
    return normalizeString(this.document.pendingDeleteApiGateSettleOwner);
  }

  get apiGateReleaseOwner(): string {
    return normalizeString(this.document.apiGateReleaseOwner);
  }

  get lastRecoveryRequestId(): string {
    return normalizeString(this.document.lastRecoveryRequestId);
  }

  settlementOwner(
    field: "apiGateSettleOwner" | "pendingDeleteApiGateSettleOwner",
  ): string {
    return normalizeString(this.document[field]);
  }
}

export class PendingDeleteSnapshot extends RetrySnapshot<TelegramCleanupDocument> {
  get status(): CleanupStatus | undefined {
    const status = this.document.status;
    return status === "pending" ||
      status === "processing" ||
      status === "retryable"
      ? status
      : undefined;
  }

  get kind(): CleanupStatus | "missing" {
    return this.present ? (this.status ?? "missing") : "missing";
  }

  get pendingDeleteId(): string {
    return normalizeString(this.document.pendingDeleteId);
  }

  get chatIdText(): string {
    return normalizeString(this.document.chatId);
  }

  get numericMessageId(): number {
    return Number(this.document.messageId);
  }

  deleteInput(): RetainedTelegramDeleteInput {
    if (!this.document.chatId || !this.document.messageId)
      throw new TypeError("telegram-cleanup-identity-missing");
    return retainTelegramDeleteInput({
      chatId: this.document.chatId,
      messageId: this.document.messageId,
    });
  }
}

export function readDelivery(
  value:
    Partial<TelegramDeliveryDocument> | DeliverySnapshot | null | undefined,
): DeliverySnapshot {
  return value instanceof DeliverySnapshot
    ? value
    : new DeliverySnapshot(value ?? {});
}

export function readPendingDelete(
  value:
    Partial<TelegramCleanupDocument> | PendingDeleteSnapshot | null | undefined,
): PendingDeleteSnapshot {
  return value instanceof PendingDeleteSnapshot
    ? value
    : new PendingDeleteSnapshot(value ?? {});
}
export function omitKeys(
  value: DeliverySnapshot,
  keys: readonly string[],
): Partial<TelegramDeliveryDocument>;
export function omitKeys(
  value: PendingDeleteSnapshot,
  keys: readonly string[],
): Partial<TelegramCleanupDocument>;
export function omitKeys<T extends object>(
  value: T,
  keys: readonly string[],
): T;
export function omitKeys(value: object, keys: readonly string[]): object {
  const source =
    value instanceof DeliverySnapshot || value instanceof PendingDeleteSnapshot
      ? value.document
      : value;
  const output = { ...source };
  for (const key of keys) Reflect.deleteProperty(output, key);
  return output;
}
export const buildPendingDeleteId = ({
  chatId,
  messageId,
}: {
  chatId: string;
  messageId: number;
}) => hashValue(`${normalizeString(chatId)}:${Number(messageId)}`).slice(0, 32);
export const buildApiGateOwner = (...parts: unknown[]) =>
  `api_${hashValue(parts.map((part) => String(part ?? "")).join(":"))}`;
export const resolvePendingDeleteId = (
  pendingDelete: Partial<TelegramCleanupDocument> | PendingDeleteSnapshot,
): string => {
  const value =
    pendingDelete instanceof PendingDeleteSnapshot
      ? pendingDelete.document
      : pendingDelete;
  return value.pendingDeleteId ?? "";
};
export const promotePendingDeleteQueue = (
  input: Partial<TelegramDeliveryDocument> | DeliverySnapshot,
): Partial<TelegramDeliveryDocument> => {
  const delivery = input instanceof DeliverySnapshot ? input.document : input;
  const value = omitKeys(delivery, ["pendingDelete"]);
  const queue = value.pendingDeleteQueue ?? {};
  const [nextPendingDeleteId] = Object.keys(queue).sort();
  if (!nextPendingDeleteId) return omitKeys(value, ["pendingDeleteQueue"]);
  const nextQueue = omitKeys(queue, [nextPendingDeleteId]);
  return {
    ...omitKeys(value, ["pendingDeleteQueue"]),
    pendingDelete: queue[nextPendingDeleteId]!,
    ...(Object.keys(nextQueue).length > 0
      ? { pendingDeleteQueue: nextQueue }
      : {}),
  };
};
export const appendPendingDelete = (
  delivery: Partial<TelegramDeliveryDocument>,
  pendingDelete: TelegramCleanupDocument,
): Partial<TelegramDeliveryDocument> => {
  if (!delivery.pendingDelete) return { ...delivery, pendingDelete };
  if (delivery.pendingDelete.pendingDeleteId === pendingDelete.pendingDeleteId)
    return delivery;
  return {
    ...delivery,
    pendingDeleteQueue: {
      ...delivery.pendingDeleteQueue,
      [pendingDelete.pendingDeleteId]: pendingDelete,
    },
  };
};
export const ensureCommitted = <T extends { committed: boolean }>(
  result: T,
  code: string,
): T => {
  if (result?.committed) {
    return result;
  }
  const error = Object.assign(new Error(code), { code, retryable: true });
  throw error;
};
export const validateDesiredForDelivery = (
  desired: unknown,
): desired is TelegramDesiredDocument => readTelegramDesired(desired) !== null;
type DesiredRetryInput = DesiredContext & {
  result: TelegramRetryFailure;
  safeRejectedAttemptId?: string;
  currentDelivery: Partial<TelegramDeliveryDocument> | DeliverySnapshot;
  apiGateOwner?: string;
  proofTaskKind?: "desired" | "pending-delete";
  pendingDeleteId?: string;
  preserveApiGateIdentity?: boolean;
  persistBeforeSchedule?: boolean;
};
export type DesiredSendOperations = {
  finishExpiredOwnedRetryWindow(
    input: DesiredContext & {
      currentDelivery: Partial<TelegramDeliveryDocument> | DeliverySnapshot;
    },
  ): Promise<{ status: string; reason: string } | null>;
  finishRetryable(input: DesiredRetryInput): Promise<TelegramRetryResult>;
  finishStatusAndSettleApiGate(
    input: FinishStatusInput,
  ): Promise<TransactionResult<TelegramMessageDocument>>;
};

export function documentFields(
  value: DeliverySnapshot,
): Partial<TelegramDeliveryDocument>;
export function documentFields(
  value: PendingDeleteSnapshot,
): Partial<TelegramCleanupDocument>;
export function documentFields<T extends object>(value: T): T;
export function documentFields<T extends object>(
  value: T | null | undefined,
): Partial<T>;
export function documentFields(value: object | null | undefined): object {
  return value instanceof DeliverySnapshot ||
    value instanceof PendingDeleteSnapshot
    ? value.document
    : (value ?? {});
}
