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
type DeliveryLease = {
  leaseOwner: string;
  leaseExpiresAtMs: number;
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
export type PreservedSendEvidence = TelegramSendEvidence | undefined;
export declare function preserveSendEvidence(
  value: TelegramSendEvidence | undefined,
  present?: boolean,
): PreservedSendEvidence;
export declare function writeDelivery(
  transition: DeliveryTransition & TelegramDeliveryMetadata,
): TelegramDeliveryDocument;
export declare function writeCleanup(
  transition: CleanupTransition & Partial<TelegramCleanupFields>,
): TelegramCleanupDocument;
export type ProofInput = TelegramProofInput;
export type ExactRetryInput =
  TelegramExactRetryInput | RetainedTelegramExactRetryInput;
export declare const normalizeString: (value: unknown) => string;
declare class RetrySnapshot<
  T extends TelegramDeliveryDocument | TelegramCleanupDocument,
> {
  readonly document: Partial<T>;
  constructor(document?: Partial<T>);
  get present(): boolean;
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
  get apiGateProofRequired(): TelegramRetryProofDocument | undefined;
  get apiGateProofOwner(): string;
}
export declare function deliveryDocument(
  value: DeliverySnapshot,
): Partial<TelegramDeliveryDocument>;
export declare function pendingDeleteDocument(
  value: PendingDeleteSnapshot,
): Partial<TelegramCleanupDocument>;
export declare function retryDocument(
  value:
    | Partial<TelegramDeliveryDocument>
    | Partial<TelegramCleanupDocument>
    | DeliverySnapshot
    | PendingDeleteSnapshot,
): TelegramRetryDocument;
export declare class DeliverySnapshot extends RetrySnapshot<TelegramDeliveryDocument> {
  get status(): DeliveryStatus | undefined;
  get kind(): DeliveryStatus | "missing";
  get revision(): string | undefined;
  matchesRevision(revision: string): this is this & {
    revision: string;
  };
  get sendInFlight(): TelegramSendEvidence | undefined;
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
export declare class PendingDeleteSnapshot extends RetrySnapshot<TelegramCleanupDocument> {
  get status(): CleanupStatus | undefined;
  get kind(): CleanupStatus | "missing";
  get pendingDeleteId(): string;
  get chatIdText(): string;
  get numericMessageId(): number;
  deleteInput(): RetainedTelegramDeleteInput;
}
export declare function readDelivery(
  value:
    Partial<TelegramDeliveryDocument> | DeliverySnapshot | null | undefined,
): DeliverySnapshot;
export declare function readPendingDelete(
  value:
    Partial<TelegramCleanupDocument> | PendingDeleteSnapshot | null | undefined,
): PendingDeleteSnapshot;
export declare function omitKeys(
  value: DeliverySnapshot,
  keys: readonly string[],
): Partial<TelegramDeliveryDocument>;
export declare function omitKeys(
  value: PendingDeleteSnapshot,
  keys: readonly string[],
): Partial<TelegramCleanupDocument>;
export declare function omitKeys<T extends object>(
  value: T,
  keys: readonly string[],
): T;
export declare const buildPendingDeleteId: ({
  chatId,
  messageId,
}: {
  chatId: string;
  messageId: number;
}) => string;
export declare const buildApiGateOwner: (...parts: unknown[]) => string;
export declare const resolvePendingDeleteId: (
  pendingDelete: Partial<TelegramCleanupDocument> | PendingDeleteSnapshot,
) => string;
export declare const promotePendingDeleteQueue: (
  input: Partial<TelegramDeliveryDocument> | DeliverySnapshot,
) => Partial<TelegramDeliveryDocument>;
export declare const appendPendingDelete: (
  delivery: Partial<TelegramDeliveryDocument>,
  pendingDelete: TelegramCleanupDocument,
) => Partial<TelegramDeliveryDocument>;
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
) => desired is TelegramDesiredDocument;
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
  ): Promise<{
    status: string;
    reason: string;
  } | null>;
  finishRetryable(input: DesiredRetryInput): Promise<TelegramRetryResult>;
  finishStatusAndSettleApiGate(
    input: FinishStatusInput,
  ): Promise<TransactionResult<TelegramMessageDocument>>;
};
export declare function documentFields(
  value: DeliverySnapshot,
): Partial<TelegramDeliveryDocument>;
export declare function documentFields(
  value: PendingDeleteSnapshot,
): Partial<TelegramCleanupDocument>;
export declare function documentFields<T extends object>(value: T): T;
export declare function documentFields<T extends object>(
  value: T | null | undefined,
): Partial<T>;
export {};
