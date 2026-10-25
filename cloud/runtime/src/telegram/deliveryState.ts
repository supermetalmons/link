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
import {
  normalizeAttempts,
  normalizeRetrySequence,
  normalizeTimestamp,
} from "./deliveryPolicy.js";
import type {
  TelegramRetryFailure,
  TelegramRetryResult,
  TelegramRetryState,
} from "./deliveryRetryTypes.js";

import type { TelegramDesired } from "./desiredStateCore.js";
import {
  TELEGRAM_DESTINATIONS,
  TELEGRAM_SCHEMA_VERSION,
} from "./desiredStateCore.js";

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
type RawRecord = Record<string, unknown>;
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
export type DeliveryLease = {
  leaseOwner: string;
  leaseExpiresAtMs: number;
};
export type SendInFlight = {
  attemptId: string;
  revision: string;
  destination: TelegramDesired["destination"];
  chatId: string;
  instanceKey?: string;
  contentHash?: string;
  startedAtMs: number;
  apiGateOwner: string;
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

const sendEvidence = Symbol("telegram-send-evidence");
export type PreservedSendEvidence = {
  readonly [sendEvidence]: { value: unknown; present: boolean };
};
export function preserveSendEvidence(
  value: unknown,
  present = true,
): PreservedSendEvidence {
  return { [sendEvidence]: { value, present } };
}

export function writeDelivery(
  transition: DeliveryTransition & TelegramDeliveryMetadata,
): TelegramDeliveryDocument {
  if (transition.status !== "uncertain") {
    const retained: unknown = transition;
    return retained as TelegramDeliveryDocument;
  }
  const evidence = transition.sendInFlight[sendEvidence];
  const output: RawRecord = { ...transition };
  if (evidence.present) output.sendInFlight = evidence.value;
  else delete output.sendInFlight;
  return output as TelegramDeliveryDocument;
}

export function writeCleanup(
  transition: CleanupTransition & TelegramCleanupFields,
): TelegramCleanupDocument {
  const retained: unknown = transition;
  return retained as TelegramCleanupDocument;
}
export type ProofInput = TelegramProofInput;
export type ExactRetryInput =
  TelegramExactRetryInput | RetainedTelegramExactRetryInput;
export const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
export const hashValue = (value: unknown): string =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
const snapshotSources = new WeakMap<StoredSnapshot, RawRecord>();
const asObject = (value: unknown): Record<string, unknown> =>
  value instanceof StoredSnapshot
    ? snapshotSources.get(value)!
    : value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

class StoredSnapshot {
  constructor(value: unknown) {
    snapshotSources.set(this, asObject(value));
  }

  get present(): boolean {
    return Object.keys(snapshotSources.get(this)!).length > 0;
  }
}

export function deliveryDocument(
  value: DeliverySnapshot,
): TelegramDeliveryDocument {
  return snapshotSources.get(value)! as TelegramDeliveryDocument;
}

export function pendingDeleteDocument(
  value: PendingDeleteSnapshot,
): TelegramCleanupDocument {
  return snapshotSources.get(value)! as TelegramCleanupDocument;
}

export function retryDocument(
  value:
    | TelegramDeliveryDocument
    | TelegramCleanupDocument
    | DeliverySnapshot
    | PendingDeleteSnapshot,
): TelegramRetryDocument {
  return asObject(value) as TelegramRetryDocument;
}

class RetrySnapshot extends StoredSnapshot {
  get attempts(): number {
    return normalizeAttempts(snapshotSources.get(this)!.attempts);
  }

  get leaseOwner(): string {
    return normalizeString(snapshotSources.get(this)!.leaseOwner);
  }

  get leaseExpiresAtMs(): number {
    return Number(snapshotSources.get(this)!.leaseExpiresAtMs) || 0;
  }

  get retryStartedAtMs(): number {
    return normalizeTimestamp(snapshotSources.get(this)!.retryStartedAtMs);
  }

  get retryDeadlineAtMs(): number {
    return normalizeTimestamp(snapshotSources.get(this)!.retryDeadlineAtMs);
  }

  get retryAtMs(): number {
    return Number(snapshotSources.get(this)!.retryAtMs);
  }

  get retrySequence(): number {
    return normalizeRetrySequence(snapshotSources.get(this)!.retrySequence);
  }

  retryTimestampOr(
    field: "retryStartedAtMs" | "retryDeadlineAtMs",
    fallback: number | undefined,
  ): number {
    return normalizeTimestamp(snapshotSources.get(this)![field] || fallback);
  }

  retrySequenceOr(fallback: number | undefined): number {
    return normalizeRetrySequence(
      snapshotSources.get(this)!.retrySequence ?? fallback,
    );
  }

  get apiGateOwner(): string {
    return normalizeString(snapshotSources.get(this)!.apiGateOwner);
  }

  get apiGateGeneration(): string {
    return normalizeString(snapshotSources.get(this)!.apiGateGeneration);
  }

  get apiGateStartedAtMs(): number {
    return normalizeTimestamp(snapshotSources.get(this)!.apiGateStartedAtMs);
  }

  get apiGateProofRequired(): TelegramRetryProofDocument {
    return snapshotSources.get(this)!
      .apiGateProofRequired as TelegramRetryProofDocument;
  }

  get apiGateProofOwner(): string {
    return normalizeString(
      readProperty(snapshotSources.get(this)!.apiGateProofRequired, "owner"),
    );
  }
}

export class DeliverySnapshot extends RetrySnapshot {
  get status(): DeliveryStatus | undefined {
    const status = snapshotSources.get(this)!.status;
    return status === "pending" ||
      status === "processing" ||
      status === "retryable" ||
      status === "delivered" ||
      status === "terminal" ||
      status === "uncertain"
      ? status
      : undefined;
  }

  get kind(): DeliveryStatus | "legacy" {
    return this.status ?? "legacy";
  }

  get revision(): string | undefined {
    return typeof snapshotSources.get(this)!.revision === "string"
      ? (snapshotSources.get(this)!.revision as string)
      : undefined;
  }

  matchesRevision(revision: string): this is this & { revision: string } {
    return (
      typeof snapshotSources.get(this)!.revision === "string" &&
      normalizeString(snapshotSources.get(this)!.revision) === revision
    );
  }

  get sendInFlight(): TelegramSendEvidence {
    return snapshotSources.get(this)!.sendInFlight as TelegramSendEvidence;
  }

  get hasSendInFlight(): boolean {
    return Boolean(snapshotSources.get(this)!.sendInFlight);
  }

  get hasAppliedStateUnknown(): boolean {
    return Boolean(snapshotSources.get(this)!.appliedStateUnknown);
  }

  get hasRawApiGateOwner(): boolean {
    return Boolean(snapshotSources.get(this)!.apiGateOwner);
  }

  sendInFlightMatchesRevision(revision: string): boolean {
    return (
      readProperty(snapshotSources.get(this)!.sendInFlight, "revision") ===
      revision
    );
  }

  preservedSendInFlight(): PreservedSendEvidence {
    return preserveSendEvidence(
      snapshotSources.get(this)!.sendInFlight,
      Object.hasOwn(snapshotSources.get(this)!, "sendInFlight"),
    );
  }

  get pendingDelete(): PendingDeleteSnapshot {
    return new PendingDeleteSnapshot(snapshotSources.get(this)!.pendingDelete);
  }

  get orphanedDeletes(): TelegramOrphanedDeletesDocument {
    return asObject(
      snapshotSources.get(this)!.orphanedDeletes,
    ) as TelegramOrphanedDeletesDocument;
  }

  get apiGateSettleOwner(): string {
    return normalizeString(snapshotSources.get(this)!.apiGateSettleOwner);
  }

  get pendingDeleteApiGateSettleOwner(): string {
    return normalizeString(
      snapshotSources.get(this)!.pendingDeleteApiGateSettleOwner,
    );
  }

  get apiGateReleaseOwner(): string {
    return normalizeString(snapshotSources.get(this)!.apiGateReleaseOwner);
  }

  get lastRecoveryRequestId(): string {
    return normalizeString(snapshotSources.get(this)!.lastRecoveryRequestId);
  }

  settlementOwner(
    field: "apiGateSettleOwner" | "pendingDeleteApiGateSettleOwner",
  ): string {
    return normalizeString(snapshotSources.get(this)![field]);
  }
}

export class PendingDeleteSnapshot extends RetrySnapshot {
  get status(): CleanupStatus | undefined {
    const status = snapshotSources.get(this)!.status;
    return status === "pending" ||
      status === "processing" ||
      status === "retryable"
      ? status
      : undefined;
  }

  get kind(): CleanupStatus | "legacy" | "missing" {
    return this.present ? (this.status ?? "legacy") : "missing";
  }

  get pendingDeleteId(): string {
    return normalizeString(snapshotSources.get(this)!.pendingDeleteId);
  }

  get chatIdText(): string {
    return normalizeString(snapshotSources.get(this)!.chatId);
  }

  get numericMessageId(): number {
    return Number(snapshotSources.get(this)!.messageId);
  }

  deleteInput(): RetainedTelegramDeleteInput {
    return retainTelegramDeleteInput({
      chatId: snapshotSources.get(this)!.chatId,
      messageId: snapshotSources.get(this)!.messageId,
    });
  }
}

export function readDelivery(value: unknown): DeliverySnapshot {
  return new DeliverySnapshot(value);
}

export function readPendingDelete(value: unknown): PendingDeleteSnapshot {
  return new PendingDeleteSnapshot(value);
}
export const omitKeys = (
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> => {
  const output = { ...asObject(value) };
  for (const key of keys) {
    delete output[key];
  }
  return output;
};
export const buildPendingDeleteId = ({
  chatId,
  messageId,
}: {
  chatId: string;
  messageId: number;
}) => hashValue(`${normalizeString(chatId)}:${Number(messageId)}`).slice(0, 32);
export const buildApiGateOwner = (...parts: unknown[]) =>
  `api_${hashValue(parts.map((part) => String(part ?? "")).join(":"))}`;
export const resolvePendingDeleteId = (pendingDelete: unknown): string => {
  const value = asObject(pendingDelete);
  return (
    normalizeString(value.pendingDeleteId) ||
    hashValue(
      JSON.stringify({
        chatId: normalizeString(value.chatId),
        messageId: value.messageId ?? null,
        instanceKey: normalizeString(value.instanceKey),
      }),
    ).slice(0, 32)
  );
};
export const promotePendingDeleteQueue = (delivery: unknown): RawRecord => {
  const value = omitKeys(delivery, ["pendingDelete"]);
  const queue = asObject(value.pendingDeleteQueue);
  const [nextPendingDeleteId] = Object.keys(queue).sort();
  if (!nextPendingDeleteId) {
    return omitKeys(value, ["pendingDeleteQueue"]);
  }
  const nextQueue = omitKeys(queue, [nextPendingDeleteId]);
  return {
    ...omitKeys(value, ["pendingDeleteQueue"]),
    pendingDelete: queue[nextPendingDeleteId],
    ...(Object.keys(nextQueue).length > 0
      ? { pendingDeleteQueue: nextQueue }
      : {}),
  };
};
export const appendPendingDelete = (
  delivery: unknown,
  pendingDelete: unknown,
): RawRecord => {
  const value = asObject(delivery);
  const currentPendingDelete = asObject(value.pendingDelete);
  if (Object.keys(currentPendingDelete).length === 0) {
    return { ...value, pendingDelete };
  }
  const pendingDeleteId = resolvePendingDeleteId(pendingDelete);
  if (resolvePendingDeleteId(currentPendingDelete) === pendingDeleteId) {
    return value;
  }
  return {
    ...value,
    pendingDeleteQueue: {
      ...asObject(value.pendingDeleteQueue),
      [pendingDeleteId]: pendingDelete,
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
): desired is TelegramDesiredDocument & { revision: string } => {
  const value = asObject(desired);
  if (
    value.schemaVersion !== TELEGRAM_SCHEMA_VERSION ||
    !normalizeString(value.revision) ||
    !normalizeString(value.sourceRevision) ||
    !Object.hasOwn(TELEGRAM_DESTINATIONS, value.destination as PropertyKey) ||
    !["send", "edit", "delete"].includes(value.operation as string)
  ) {
    return false;
  }
  if (value.operation === "delete") {
    return true;
  }
  return (
    normalizeString(value.instanceKey) !== "" &&
    typeof value.text === "string" &&
    value.text.length > 0 &&
    (value.parseMode === undefined || value.parseMode === "HTML") &&
    (value.operation !== "edit" ||
      value.ifMissing === "send" ||
      value.ifMissing === "skip")
  );
};
export type DesiredRetryInput = DesiredContext & {
  result: TelegramRetryFailure;
  safeRejectedAttemptId?: string;
  currentDelivery: TelegramDeliveryDocument | DeliverySnapshot;
  apiGateOwner?: string;
  proofTaskKind?: "desired" | "pending-delete";
  pendingDeleteId?: string;
  preserveApiGateIdentity?: boolean;
  persistBeforeSchedule?: boolean;
};
export type DesiredSendOperations = {
  finishExpiredOwnedRetryWindow(
    input: DesiredContext & {
      currentDelivery: TelegramDeliveryDocument | DeliverySnapshot;
    },
  ): Promise<{ status: string; reason: string } | null>;
  finishRetryable(input: DesiredRetryInput): Promise<TelegramRetryResult>;
  finishStatusAndSettleApiGate(
    input: FinishStatusInput,
  ): Promise<TransactionResult<TelegramMessageDocument>>;
};
