// Generated from src/telegram/deliveryState.ts. Run npm run generate:runtime.
import type {
  TransactionDecision,
  TransactionResult,
} from "../transactions.js";
import type {
  TelegramRetryFailure,
  TelegramRetryResult,
  TelegramRetryState,
} from "./deliveryRetryTypes.js";
import type { TelegramReconcileInput } from "./deliveryTypes.js";
import type { TelegramDesired } from "./desiredStateCore.js";
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
  | {
      kind: "preserve";
      value?: never;
    }
  | {
      kind: "set";
      value: RawRecord;
    }
  | {
      kind: "clear";
      value?: never;
    };
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
  | {
      status: "pending";
      revision: string;
      attempts?: number;
    }
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
  | {
      status: "delivered";
      revision: string;
      deliveredAtMs: number;
    }
  | {
      status: "terminal";
      revision: string;
    }
  | {
      status: "uncertain";
      revision: string;
      sendInFlight: PreservedSendEvidence;
    };
export type CleanupTransition =
  | {
      status: "pending";
      attempts: number;
    }
  | ({
      status: "processing";
      attempts: number;
    } & DeliveryLease)
  | ({
      status: "retryable";
    } & TelegramRetryState);
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
declare const sendEvidence: unique symbol;
export type PreservedSendEvidence = {
  readonly [sendEvidence]: {
    value: unknown;
    present: boolean;
  };
};
export declare function preserveSendEvidence(
  value: unknown,
  present?: boolean,
): PreservedSendEvidence;
export declare function writeDelivery(
  transition: DeliveryTransition & RawRecord,
): RawRecord;
export declare function writeCleanup(
  transition: CleanupTransition & RawRecord,
): RawRecord;
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
export declare const normalizeString: (value: unknown) => string;
export declare const hashValue: (value: unknown) => string;
export declare const asObject: (value: unknown) => Record<string, unknown>;
declare class StoredSnapshot {
  readonly source: RawRecord;
  constructor(value: unknown);
  get present(): boolean;
}
declare class RetrySnapshot extends StoredSnapshot {
  get attempts(): number;
  get leaseOwner(): string;
  get leaseExpiresAtMs(): number;
  get retryStartedAtMs(): number;
  get retryDeadlineAtMs(): number;
  get retryAtMs(): number;
  get retrySequence(): number;
  retryTimestampOr(
    field: "retryStartedAtMs" | "retryDeadlineAtMs",
    fallback: unknown,
  ): number;
  retrySequenceOr(fallback: unknown): number;
  get apiGateOwner(): string;
  get apiGateGeneration(): string;
  get apiGateStartedAtMs(): number;
  get apiGateProofRequired(): unknown;
}
export declare class DeliverySnapshot extends RetrySnapshot {
  get status(): DeliveryStatus | undefined;
  get kind(): DeliveryStatus | "legacy";
  get revision(): string | undefined;
  matchesRevision(revision: string): this is this & {
    revision: string;
  };
  get sendInFlight(): unknown;
  get pendingDelete(): PendingDeleteSnapshot;
  get orphanedDeletes(): RawRecord;
  get apiGateSettleOwner(): string;
  get pendingDeleteApiGateSettleOwner(): string;
  get apiGateReleaseOwner(): string;
  get lastRecoveryRequestId(): string;
  settlementOwner(
    field: "apiGateSettleOwner" | "pendingDeleteApiGateSettleOwner",
  ): string;
}
export declare class PendingDeleteSnapshot extends RetrySnapshot {
  get status(): CleanupStatus | undefined;
  get kind(): CleanupStatus | "legacy" | "missing";
  get pendingDeleteId(): string;
  get chatId(): unknown;
  get messageId(): unknown;
}
export declare function readDelivery(value: unknown): DeliverySnapshot;
export declare function readPendingDelete(
  value: unknown,
): PendingDeleteSnapshot;
export declare const omitKeys: (
  value: unknown,
  keys: readonly string[],
) => Record<string, unknown>;
export declare const buildPendingDeleteId: ({
  chatId,
  messageId,
}: {
  chatId: unknown;
  messageId: unknown;
}) => string;
export declare const buildApiGateOwner: (...parts: unknown[]) => string;
export declare const resolvePendingDeleteId: (pendingDelete: unknown) => string;
export declare const promotePendingDeleteQueue: (
  delivery: unknown,
) => RawRecord;
export declare const appendPendingDelete: (
  delivery: unknown,
  pendingDelete: unknown,
) => RawRecord;
export declare const ensureCommitted: <
  T extends {
    committed: boolean;
  },
>(
  result: T,
  code: string,
) => T;
export declare const validateDesiredForDelivery: (
  desired: unknown,
) => desired is TelegramDesired;
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
    input: DesiredContext & {
      currentDelivery: unknown;
    },
  ): Promise<{
    status: string;
    reason: string;
  } | null>;
  finishRetryable(input: DesiredRetryInput): Promise<TelegramRetryResult>;
  finishStatusAndSettleApiGate(
    input: FinishStatusInput,
  ): Promise<TransactionResult<RawRecord>>;
};
export {};
