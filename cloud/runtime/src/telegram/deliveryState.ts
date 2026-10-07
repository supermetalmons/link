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
import type { TelegramReconcileInput } from "./deliveryTypes.js";
import type { TelegramDesired } from "./desiredStateCore.js";
import {
  TELEGRAM_DESTINATIONS,
  TELEGRAM_SCHEMA_VERSION,
} from "./desiredStateCore.js";
import type { TelegramTaskKind } from "./taskIdentity.js";
export type RawRecord = Record<string, unknown>;
export type MessageMutation = (
  record: RawRecord,
) => TransactionDecision<RawRecord>;
export type OwnedMutation = (
  record: RawRecord,
  delivery: DeliverySnapshot,
) => RawRecord;
export type DesiredContext = {
  messageKey: string;
  ownerToken: string;
  desired: TelegramDesired;
};
export type AppliedReceiptAction =
  | { kind: "preserve"; value?: never }
  | { kind: "set"; value: RawRecord }
  | { kind: "clear"; value?: never };
export type DeliveredOptions = {
  receipt?: AppliedReceiptAction;
  clearAppliedStateUnknown?: boolean;
};
export type FinishStatusInput = DesiredContext & {
  nowMs: number;
  apiGateSettleOwner?: unknown;
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
  transition: DeliveryTransition & RawRecord,
): RawRecord {
  if (transition.status !== "uncertain") return transition;
  const evidence = transition.sendInFlight[sendEvidence];
  const output: RawRecord = { ...transition };
  if (evidence.present) output.sendInFlight = evidence.value;
  else delete output.sendInFlight;
  return output;
}

export function writeCleanup(
  transition: CleanupTransition & RawRecord,
): RawRecord {
  return transition;
}
export type ProofInput = Partial<
  Record<keyof TelegramReconcileInput | "requestedPendingDeleteId", unknown>
>;
export type ExactRetryInput = {
  messageKey: string;
  revision: string;
  taskKind: TelegramTaskKind;
  retryState: Partial<Record<keyof TelegramRetryState, unknown>>;
  safeRejectedAttemptId?: unknown;
  pendingDeleteId?: unknown;
  retryProofLeaseOwner?: unknown;
  sourceGeneration?: unknown;
  proofTaskKind?: unknown;
  barrierProofOwner?: unknown;
  barrierRetryNotBeforeMs?: unknown;
  scheduleTimeMs?: unknown;
  apiGateReclaimOwner?: unknown;
  apiGateSettleOwner?: unknown;
};
export const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
export const hashValue = (value: unknown): string =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
export const asObject = (value: unknown): Record<string, unknown> =>
  value instanceof StoredSnapshot
    ? value.source
    : value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

class StoredSnapshot {
  readonly source: RawRecord;

  constructor(value: unknown) {
    this.source = asObject(value);
  }

  get present(): boolean {
    return Object.keys(this.source).length > 0;
  }
}

class RetrySnapshot extends StoredSnapshot {
  get attempts(): number {
    return normalizeAttempts(this.source.attempts);
  }

  get leaseOwner(): string {
    return normalizeString(this.source.leaseOwner);
  }

  get leaseExpiresAtMs(): number {
    return Number(this.source.leaseExpiresAtMs) || 0;
  }

  get retryStartedAtMs(): number {
    return normalizeTimestamp(this.source.retryStartedAtMs);
  }

  get retryDeadlineAtMs(): number {
    return normalizeTimestamp(this.source.retryDeadlineAtMs);
  }

  get retryAtMs(): number {
    return Number(this.source.retryAtMs);
  }

  get retrySequence(): number {
    return normalizeRetrySequence(this.source.retrySequence);
  }

  retryTimestampOr(
    field: "retryStartedAtMs" | "retryDeadlineAtMs",
    fallback: unknown,
  ): number {
    return normalizeTimestamp(this.source[field] || fallback);
  }

  retrySequenceOr(fallback: unknown): number {
    return normalizeRetrySequence(this.source.retrySequence ?? fallback);
  }

  get apiGateOwner(): string {
    return normalizeString(this.source.apiGateOwner);
  }

  get apiGateGeneration(): string {
    return normalizeString(this.source.apiGateGeneration);
  }

  get apiGateStartedAtMs(): number {
    return normalizeTimestamp(this.source.apiGateStartedAtMs);
  }

  get apiGateProofRequired(): unknown {
    return this.source.apiGateProofRequired;
  }
}

export class DeliverySnapshot extends RetrySnapshot {
  get status(): DeliveryStatus | undefined {
    const status = this.source.status;
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
    return typeof this.source.revision === "string"
      ? this.source.revision
      : undefined;
  }

  matchesRevision(revision: string): this is this & { revision: string } {
    return (
      typeof this.source.revision === "string" &&
      normalizeString(this.source.revision) === revision
    );
  }

  get sendInFlight(): unknown {
    return this.source.sendInFlight;
  }

  get pendingDelete(): PendingDeleteSnapshot {
    return new PendingDeleteSnapshot(this.source.pendingDelete);
  }

  get orphanedDeletes(): RawRecord {
    return asObject(this.source.orphanedDeletes);
  }

  get apiGateSettleOwner(): string {
    return normalizeString(this.source.apiGateSettleOwner);
  }

  get pendingDeleteApiGateSettleOwner(): string {
    return normalizeString(this.source.pendingDeleteApiGateSettleOwner);
  }

  get apiGateReleaseOwner(): string {
    return normalizeString(this.source.apiGateReleaseOwner);
  }

  get lastRecoveryRequestId(): string {
    return normalizeString(this.source.lastRecoveryRequestId);
  }

  settlementOwner(
    field: "apiGateSettleOwner" | "pendingDeleteApiGateSettleOwner",
  ): string {
    return normalizeString(this.source[field]);
  }
}

export class PendingDeleteSnapshot extends RetrySnapshot {
  get status(): CleanupStatus | undefined {
    const status = this.source.status;
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
    return normalizeString(this.source.pendingDeleteId);
  }

  get chatId(): unknown {
    return this.source.chatId;
  }

  get messageId(): unknown {
    return this.source.messageId;
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
  chatId: unknown;
  messageId: unknown;
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
): desired is TelegramDesired => {
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
  currentDelivery: unknown;
  apiGateOwner?: string;
  proofTaskKind?: "desired" | "pending-delete";
  pendingDeleteId?: string;
  preserveApiGateIdentity?: boolean;
  persistBeforeSchedule?: boolean;
};
export type DesiredSendOperations = {
  finishExpiredOwnedRetryWindow(
    input: DesiredContext & { currentDelivery: unknown },
  ): Promise<{ status: string; reason: string } | null>;
  finishRetryable(input: DesiredRetryInput): Promise<TelegramRetryResult>;
  finishStatusAndSettleApiGate(
    input: FinishStatusInput,
  ): Promise<TransactionResult<RawRecord>>;
};
