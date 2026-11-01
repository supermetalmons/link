import type { TransactionDecision } from "../transactions.js";
import {
  buildTelegramEditDesired,
  type TelegramDesired,
  type TelegramEditDesired,
} from "./desiredStateCore.js";
import {
  buildAutomatchProjectionGuard,
  evaluateAutomatchProjectionUpdate,
  type AutomatchTelegramProjection,
} from "./projectionCore.js";
import type { EventTelegramDesiredChange } from "./eventProjectionCore.js";
import { writeDelivery } from "./deliveryState.js";
import {
  messageDocument,
  updateTelegramMessage,
  type TelegramAppliedDocument,
  type TelegramMessageDocument,
} from "./records.js";

const generation = (value: TelegramDesired | undefined): number =>
  value?.eventTelegramProjectionGuard?.generation ?? 0;

export function replaceTelegramDesired(
  current: TelegramMessageDocument | null,
  desired: TelegramDesired,
): TelegramMessageDocument {
  return updateTelegramMessage(messageDocument(current), { desired });
}

export function projectAutomatchMessage(
  current: TelegramMessageDocument | null,
  projection: AutomatchTelegramProjection,
  desired: TelegramDesired,
): TransactionDecision<TelegramMessageDocument> {
  const decision = evaluateAutomatchProjectionUpdate(current, projection);
  if (!decision.allowed) return { commit: false, decision: decision.reason };
  return {
    value: updateTelegramMessage(messageDocument(current), {
      desired,
      automatchProjection: buildAutomatchProjectionGuard(projection),
    }),
    decision: decision.reason,
  };
}

export function adoptTelegramReminder(
  current: TelegramMessageDocument | null,
  desired: TelegramEditDesired,
  chatId: string,
  confirmed: { messageId: number; appliedAtMs: number },
): TransactionDecision<TelegramMessageDocument> {
  if (current !== null && current !== undefined) {
    return { commit: false, decision: "existing-reminder" };
  }
  return {
    value: updateTelegramMessage(messageDocument(null), {
      desired,
      applied: {
        destination: "community",
        chatId: chatId.trim(),
        messageId: confirmed.messageId,
        instanceKey: desired.instanceKey,
        revision: desired.revision,
        contentHash: desired.contentHash,
        appliedAtMs: confirmed.appliedAtMs,
      },
      delivery: writeDelivery({
        status: "delivered",
        revision: desired.revision,
        deliveredAtMs: confirmed.appliedAtMs,
      }),
    }),
    decision: "reminder-adopted",
  };
}

export function projectEventMessage(
  current: TelegramMessageDocument | null,
  value: EventTelegramDesiredChange["value"],
  expectedGeneration: number,
  expectedApplied?: TelegramAppliedDocument | null,
): TransactionDecision<TelegramMessageDocument> {
  const record = messageDocument(current);
  if (generation(record.desired) > expectedGeneration)
    return { commit: false, decision: "newer-projection" };
  if (expectedApplied !== undefined) {
    const desired = value;
    const delivery = record.delivery;
    const abandoned = delivery?.abandonedSend;
    if (
      delivery?.status === "terminal" &&
      delivery.lastError?.code === "manually-abandoned" &&
      abandoned?.destination === desired.destination &&
      desired.operation !== "delete" &&
      abandoned.instanceKey === desired.instanceKey
    )
      return { commit: false, decision: "abandoned" };
    const applied = record.applied;
    if (
      delivery?.sendInFlight ||
      (
        [
          "destination",
          "instanceKey",
          "messageId",
          "contentHash",
          "revision",
        ] as const
      ).some((key) => applied?.[key] !== expectedApplied?.[key])
    ) {
      const previousDesired = record.desired;
      if (
        desired.operation === "edit" &&
        desired.ifMissing === "skip" &&
        previousDesired &&
        previousDesired.operation !== "delete" &&
        previousDesired.destination === desired.destination &&
        previousDesired.instanceKey === desired.instanceKey
      ) {
        const next: TelegramEditDesired = {
          ...buildTelegramEditDesired({
            ...previousDesired,
            ifMissing: "skip",
            sourceRevision: desired.sourceRevision,
          }),
          ...(desired.eventTelegramProjectionGuard
            ? {
                eventTelegramProjectionGuard:
                  desired.eventTelegramProjectionGuard,
              }
            : {}),
        };
        return {
          value: updateTelegramMessage(record, { desired: next }),
          decision: "delivery-changed",
        };
      }
      return { commit: false, decision: "delivery-changed" };
    }
  }
  return {
    value: updateTelegramMessage(record, { desired: value }),
    decision: "projection-committed",
  };
}
