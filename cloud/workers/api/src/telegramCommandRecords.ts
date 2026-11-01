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
function sameRecovery(
  request: TelegramManualRecoveryWrite | undefined,
  command: RecoveryChoice,
): boolean {
  return (
    request?.action === command.action &&
    (command.messageId === undefined
      ? request.messageId === undefined
      : request.messageId === command.messageId)
  );
}
function recoveryEligibility(
  value: TelegramMessageDocument | null,
): TelegramMessageDocument | null {
  return value?.delivery?.status === "uncertain" && value.delivery.sendInFlight
    ? value
    : null;
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
  const pending = message.manualRecovery;
  const delivery = message.delivery;
  const pendingRequestId = pending?.requestId ?? "";
  const processedRequestId = delivery?.lastRecoveryRequestId ?? "";
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
  const delivery = message.delivery;
  const pending = message.manualRecovery;
  const pendingRequestId = pending?.requestId ?? "";
  const processedRequestId = delivery?.lastRecoveryRequestId ?? "";
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
  const request = value?.manualRecovery;
  const requestId = request?.requestId ?? "";
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
  const delivery = value?.delivery;
  const result = value?.manualRecoveryResult;
  if (result?.requestId === requestId)
    return {
      status: result.status,
      action: result.action,
      deliveryStatus: delivery?.status ?? null,
      ...(result.code ? { code: result.code } : {}),
    };
  return value?.manualRecovery?.requestId === requestId
    ? { status: "pending", deliveryStatus: delivery?.status ?? null }
    : null;
}
