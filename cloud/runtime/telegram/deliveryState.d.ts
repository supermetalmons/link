// Generated from src/telegram/deliveryState.ts. Run npm run generate:runtime.
import type { TelegramExactRetryInput } from "./deliveryRetryTypes.js";
import type {
  TelegramProofInput,
  RetainedTelegramExactRetryInput,
  RetainedTelegramOwner,
} from "./retryRecords.js";
import type {
  TransactionDecision,
  TransactionResult,
} from "../transactions.js";
import type {
  TelegramRetryFailure,
  TelegramRetryResult,
  TelegramRetryState,
} from "./deliveryRetryTypes.js";
import type { TelegramDesired } from "./desiredStateCore.js";
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
import { type RetainedTelegramDeleteInput } from "./client.js";
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
  | {
      kind: "preserve";
      value?: never;
    }
  | {
      kind: "set";
      value: TelegramAppliedReceiptWrite | TelegramAppliedDocument;
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
  transition: DeliveryTransition & TelegramDeliveryMetadata,
): TelegramDeliveryDocument;
export declare function writeCleanup(
  transition: CleanupTransition & TelegramCleanupFields,
): TelegramCleanupDocument;
export type ProofInput = TelegramProofInput;
export type ExactRetryInput =
  TelegramExactRetryInput | RetainedTelegramExactRetryInput;
export declare const normalizeString: (value: unknown) => string;
export declare const hashValue: (value: unknown) => string;
declare class StoredSnapshot {
  constructor(value: unknown);
  get present(): boolean;
}
export declare function deliveryDocument(
  value: DeliverySnapshot,
): TelegramDeliveryDocument;
export declare function pendingDeleteDocument(
  value: PendingDeleteSnapshot,
): TelegramCleanupDocument;
export declare function retryDocument(
  value:
    | TelegramDeliveryDocument
    | TelegramCleanupDocument
    | DeliverySnapshot
    | PendingDeleteSnapshot,
): TelegramRetryDocument;
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
    fallback: number | undefined,
  ): number;
  retrySequenceOr(fallback: number | undefined): number;
  get apiGateOwner(): string;
  get apiGateGeneration(): string;
  get apiGateStartedAtMs(): number;
  get apiGateProofRequired(): TelegramRetryProofDocument;
  get apiGateProofOwner(): string;
}
export declare class DeliverySnapshot extends RetrySnapshot {
  get status(): DeliveryStatus | undefined;
  get kind(): DeliveryStatus | "legacy";
  get revision(): string | undefined;
  matchesRevision(revision: string): this is this & {
    revision: string;
  };
  get sendInFlight(): TelegramSendEvidence;
  get hasSendInFlight(): boolean;
  get hasAppliedStateUnknown(): boolean;
  get hasRawApiGateOwner(): boolean;
  sendInFlightMatchesRevision(revision: string): boolean;
  preservedSendInFlight(): PreservedSendEvidence;
  get pendingDelete(): PendingDeleteSnapshot;
  get orphanedDeletes(): TelegramOrphanedDeletesDocument;
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
  get chatIdText(): string;
  get numericMessageId(): number;
  deleteInput(): RetainedTelegramDeleteInput;
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
  chatId: string;
  messageId: number;
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
) => desired is TelegramDesiredDocument & {
  revision: string;
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
  ): Promise<{
    status: string;
    reason: string;
  } | null>;
  finishRetryable(input: DesiredRetryInput): Promise<TelegramRetryResult>;
  finishStatusAndSettleApiGate(
    input: FinishStatusInput,
  ): Promise<TransactionResult<TelegramMessageDocument>>;
};
export {};
