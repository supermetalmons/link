import type {
  AppliedReceiptAction,
  DesiredContext,
  FinishStatusInput,
  PreservedSendEvidence,
  writeCleanup,
  writeDelivery,
} from "../../../runtime/telegram/deliveryState.js";
import type { TelegramRetryState } from "../../../runtime/telegram/deliveryRetryTypes.js";

type Assert<T extends true> = T;
type Rejects<Value, Contract> = Value extends Contract ? false : true;
type DeliveryWrite = Parameters<typeof writeDelivery>[0];
type CleanupWrite = Parameters<typeof writeCleanup>[0];
type FinishContext = DesiredContext & { nowMs: number };

export type ProcessingRequiresLease = Assert<
  Rejects<
    {
      status: "processing";
      revision: string;
      attempts: number;
      startedAtMs: number;
    },
    DeliveryWrite
  >
>;
export type ProcessingAcceptsCompleteLease = Assert<
  {
    status: "processing";
    revision: string;
    attempts: number;
    startedAtMs: number;
    leaseOwner: string;
    leaseExpiresAtMs: number;
  } extends DeliveryWrite
    ? true
    : false
>;
export type RetryRequiresCompleteWindow = Assert<
  Rejects<
    { status: "retryable"; revision: string; retryAtMs: number },
    DeliveryWrite
  >
>;
export type RetryAcceptsCompleteWindow = Assert<
  {
    status: "retryable";
    revision: string;
  } & TelegramRetryState extends DeliveryWrite
    ? true
    : false
>;
export type UncertaintyRequiresPreservedEvidence = Assert<
  Rejects<
    {
      status: "uncertain";
      revision: string;
      sendInFlight: { attemptId: string };
    },
    DeliveryWrite
  >
>;
export type UncertaintyAcceptsOpaqueHistoricalEvidence = Assert<
  {
    status: "uncertain";
    revision: string;
    sendInFlight: PreservedSendEvidence;
  } extends DeliveryWrite
    ? true
    : false
>;
export type DeliveredRequiresTimestamp = Assert<
  Rejects<{ status: "delivered"; revision: string }, DeliveryWrite>
>;
export type CleanupProcessingRequiresLease = Assert<
  Rejects<{ status: "processing"; attempts: number }, CleanupWrite>
>;
export type CleanupRetryRequiresWindow = Assert<
  Rejects<{ status: "retryable"; retryAtMs: number }, CleanupWrite>
>;
export type CleanupRetryAcceptsCompleteWindow = Assert<
  { status: "retryable" } & TelegramRetryState extends CleanupWrite
    ? true
    : false
>;
export type UncertainFinalizationCannotAlterReceipt = Assert<
  Rejects<
    FinishContext & {
      status: "uncertain";
      result: { code: string };
      receipt: { kind: "clear" };
    },
    FinishStatusInput
  >
>;
export type ReceiptCannotClearAndSet = Assert<
  Rejects<{ kind: "clear"; value: { messageId: number } }, AppliedReceiptAction>
>;
export type ReceiptSetRequiresValue = Assert<
  Rejects<{ kind: "set" }, AppliedReceiptAction>
>;
export type TerminalFinalizationRequiresFailure = Assert<
  Rejects<FinishContext & { status: "terminal" }, FinishStatusInput>
>;
export type DeliveredFinalizationAcceptsReceiptClear = Assert<
  FinishContext & {
    status: "delivered";
    receipt: { kind: "clear" };
  } extends FinishStatusInput
    ? true
    : false
>;
