import type { TransactionDecision } from "../../../runtime/transactions.js";
import {
  messageDocument,
  updateTelegramMessage,
  type TelegramManualRecoveryWrite,
  type TelegramMessageDocument,
} from "../../../runtime/telegram/records.js";

type WithoutRequestId<Value> = Value extends unknown
  ? Omit<Value, "requestId">
  : never;
type RecoveryChoice = WithoutRequestId<TelegramManualRecoveryWrite>;
type SourceRecord = Record<string, unknown>;
const record = (value: unknown): SourceRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as SourceRecord)
    : {};
const nonEmptyString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function sameRecovery(request: SourceRecord, command: RecoveryChoice): boolean {
  return (
    nonEmptyString(request.action) === command.action &&
    (command.messageId === undefined
      ? request.messageId === undefined
      : Number(request.messageId) === command.messageId)
  );
}

function recoveryEligibility(
  value: TelegramMessageDocument | null,
): SourceRecord | null {
  const message = record(value);
  const delivery = record(message.delivery);
  const sendInFlight = record(delivery.sendInFlight);
  const attemptId = nonEmptyString(sendInFlight.attemptId);
  return delivery.status === "uncertain" && attemptId ? message : null;
}

export function previewTelegramRecovery(
  value: TelegramMessageDocument | null,
  command: RecoveryChoice,
):
  | { eligible: false }
  | {
      eligible: true;
      conflict: boolean;
      pendingRequestId: string;
      processedRequestId: string;
    } {
  const message = recoveryEligibility(value);
  if (!message) return { eligible: false };
  const pending = record(message.manualRecovery);
  const delivery = record(message.delivery);
  const pendingRequestId = nonEmptyString(pending.requestId);
  const processedRequestId = nonEmptyString(delivery.lastRecoveryRequestId);
  const conflict = Boolean(
    pendingRequestId &&
    pendingRequestId !== processedRequestId &&
    !sameRecovery(pending, command),
  );
  return { eligible: true, conflict, pendingRequestId, processedRequestId };
}

export function requestTelegramRecovery(
  current: TelegramMessageDocument | null,
  command: TelegramManualRecoveryWrite,
  observeConflict: (reason: string) => void,
  currentConflict: () => string,
): TransactionDecision<TelegramMessageDocument> {
  const message = recoveryEligibility(current);
  if (!message) {
    observeConflict("recovery-not-required");
    return { commit: false, decision: "recovery-not-required" };
  }
  const delivery = record(message.delivery);
  const pending = record(message.manualRecovery);
  const pendingRequestId = nonEmptyString(pending.requestId);
  const processedRequestId = nonEmptyString(delivery.lastRecoveryRequestId);
  if (pendingRequestId && pendingRequestId !== processedRequestId) {
    if (!sameRecovery(pending, command)) observeConflict("recovery-conflict");
    return { commit: false, decision: currentConflict() || "recovery-resumed" };
  }
  const manualRecovery: TelegramManualRecoveryWrite =
    command.action === "confirm-send-applied"
      ? {
          requestId: command.requestId,
          action: command.action,
          messageId: command.messageId,
        }
      : { requestId: command.requestId, action: command.action };
  return {
    value: updateTelegramMessage(messageDocument(message), { manualRecovery }),
    decision: "recovery-requested",
  };
}

export function persistedTelegramRecovery(
  value: TelegramMessageDocument | null,
  command: RecoveryChoice,
): { requestId: string; matches: boolean } {
  const request = record(record(value).manualRecovery);
  const requestId = nonEmptyString(request.requestId);
  return {
    requestId,
    matches: Boolean(requestId && sameRecovery(request, command)),
  };
}

export type TelegramRecoveryStatus = {
  status: string;
  action?: string;
  deliveryStatus: string | null;
  code?: string;
};

export function readTelegramRecoveryStatus(
  value: TelegramMessageDocument | null,
  requestId: string,
): TelegramRecoveryStatus | null {
  const message = record(value);
  const delivery = record(message.delivery);
  const result = record(message.manualRecoveryResult);
  if (nonEmptyString(result.requestId) === requestId) {
    return {
      status: nonEmptyString(result.status) || "rejected",
      action: nonEmptyString(result.action),
      deliveryStatus: nonEmptyString(delivery.status) || null,
      ...(nonEmptyString(result.code)
        ? { code: nonEmptyString(result.code) }
        : {}),
    };
  }
  const pending = record(message.manualRecovery);
  return nonEmptyString(pending.requestId) === requestId
    ? {
        status: "pending",
        deliveryStatus: nonEmptyString(delivery.status) || null,
      }
    : null;
}
