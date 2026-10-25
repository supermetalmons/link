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
  desiredDocument,
  messageDocument,
  updateTelegramMessage,
  type TelegramAppliedDocument,
  type TelegramMessageDocument,
} from "./records.js";

type SourceRecord = Record<string, unknown>;
const asObject = (value: unknown): SourceRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as SourceRecord)
    : {};
const guardField = "eventTelegramProjectionGuard";
const generation = (value: unknown): number => {
  const stored = asObject(asObject(value)[guardField]).generation;
  return typeof stored === "number" &&
    Number.isSafeInteger(stored) &&
    stored >= 0
    ? stored
    : 0;
};

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
  expectedApplied?: TelegramAppliedDocument,
): TransactionDecision<TelegramMessageDocument> {
  const record = asObject(current);
  if (generation(record.desired) > expectedGeneration) {
    return { commit: false, decision: "newer-projection" };
  }
  if (expectedApplied) {
    const desired = asObject(value);
    const delivery = asObject(record.delivery);
    const abandoned = asObject(delivery.abandonedSend);
    if (
      delivery.status === "terminal" &&
      asObject(delivery.lastError).code === "manually-abandoned" &&
      abandoned.destination === desired.destination &&
      abandoned.instanceKey === desired.instanceKey
    )
      return { commit: false, decision: "abandoned" };
    const applied = asObject(record.applied);
    const expected = asObject(expectedApplied);
    if (
      delivery.sendInFlight ||
      [
        "destination",
        "instanceKey",
        "messageId",
        "contentHash",
        "revision",
      ].some((key) => applied[key] !== expected[key])
    ) {
      const previousDesired = asObject(record.desired);
      if (
        desired.operation === "edit" &&
        desired.ifMissing === "skip" &&
        previousDesired.destination === desired.destination &&
        previousDesired.instanceKey === desired.instanceKey
      ) {
        const next: unknown = {
          ...Reflect.apply(buildTelegramEditDesired, undefined, [
            {
              ...previousDesired,
              ifMissing: "skip",
              sourceRevision: desired.sourceRevision,
            },
          ]),
          [guardField]: desired[guardField],
        };
        return {
          value: updateTelegramMessage(messageDocument(record), {
            desired: desiredDocument(next),
          }),
          decision: "delivery-changed",
        };
      }
      return { commit: false, decision: "delivery-changed" };
    }
  }
  return {
    value: updateTelegramMessage(messageDocument(record), { desired: value }),
    decision: "projection-committed",
  };
}
