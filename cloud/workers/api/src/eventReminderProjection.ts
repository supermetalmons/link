import { buildTelegramEditDesired } from "../../../runtime/telegram/desiredStateCore.js";
import type { TelegramRepository } from "../../../runtime/telegram/deliveryEngine.js";
import { isV2TelegramEvent } from "../../../runtime/telegram/eventProjectionCore.js";
import {
  getSundayMonsReminderLeadMs,
  isSundayMonsReminderEvent,
} from "../../../runtime/telegram/sundayMonsReminder.js";
import { readEventRuntimeControl } from "./eventD1.ts";
import { createEventGameplayRepository } from "./eventRepository.ts";
import {
  buildEventTelegramProjectionOutbox,
  getEventTelegramProjectionGenerationPath,
  getEventTelegramProjectionOutboxPath,
} from "./eventTelegramProjectionProducer.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import { stateIncrement } from "./stateRepositoryTypes.ts";
import type { GameplayRepository } from "./gameplayRepository.ts";
import { profileBackgroundMutationsEnabled } from "./profileCanonicalActivation.ts";
import {
  createD1TelegramAnnouncementRepository,
  readTelegramStorageMode,
  type TelegramAnnouncementRecord,
  type TelegramAnnouncementRepository,
} from "./telegramD1.ts";
import type { EventTelegramProjectionTask } from "./telegramProjectionTasks.ts";

export type SundayMonsReminderRefreshResult = {
  status: "queued" | "skipped";
  reason?: string;
  requestId?: string;
  messageKey?: string;
};

export type SundayMonsReminderRefreshDependencies = {
  controlsEnabled?: (env: Env) => Promise<boolean>;
  eventRepository?: Pick<GameplayRepository, "getStatePath" | "patchStateRoot">;
  announcementRepository?: Pick<TelegramAnnouncementRepository, "get">;
  enqueue?: (task: EventTelegramProjectionTask) => Promise<unknown>;
  now?: () => number;
  createRequestId?: () => string;
  logger?: Pick<Console, "error">;
};

function confirmedReminder(
  eventId: string,
  receipt: TelegramAnnouncementRecord | null,
  chatId: string,
): { text: string; messageId: number; appliedAtMs: number } | null {
  if (
    !isSafeRecordKey(eventId) ||
    !chatId.trim() ||
    receipt?.kind !== "reminder" ||
    receipt.eventId !== eventId ||
    receipt.status !== "sent" ||
    !Array.isArray(receipt.messageIds) ||
    receipt.messageIds.length !== 1 ||
    !Number.isSafeInteger(receipt.messageIds[0]) ||
    receipt.messageIds[0] <= 0 ||
    !Number.isSafeInteger(receipt.updatedAtMs) ||
    receipt.updatedAtMs <= 0
  ) {
    return null;
  }
  const payload = receipt.payload;
  if (
    !payload ||
    payload.chatId !== chatId.trim() ||
    payload.parseMode !== "HTML" ||
    payload.silent !== false ||
    typeof payload.text !== "string" ||
    Object.hasOwn(payload, "imageUrls") ||
    Object.hasOwn(payload, "hasSpoiler")
  ) {
    return null;
  }
  if (!getSundayMonsReminderLeadMs(eventId, payload.text)) {
    return null;
  }
  return {
    text: payload.text,
    messageId: receipt.messageIds[0],
    appliedAtMs: receipt.updatedAtMs,
  };
}

export async function adoptSundayMonsReminderMessage({
  eventId,
  receipt,
  telegram,
  chatId,
}: {
  eventId: string;
  receipt: TelegramAnnouncementRecord | null;
  telegram: Pick<TelegramRepository, "getMessage" | "transactMessage">;
  chatId: string;
}): Promise<unknown> {
  const confirmed = confirmedReminder(eventId, receipt, chatId);
  if (!confirmed) return null;
  const messageKey = `event:${eventId}:reminder`;
  const desired = buildTelegramEditDesired({
    destination: "community",
    instanceKey: `${messageKey}:v2`,
    text: confirmed.text,
    parseMode: "HTML",
    silent: false,
    ifMissing: "skip",
    sourceRevision: `event:${eventId}:reminder:v1`,
  });
  const result = await telegram.transactMessage(messageKey, (current) => {
    if (current !== null && current !== undefined) {
      return { commit: false, decision: "existing-reminder" };
    }
    return {
      value: {
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
        delivery: {
          status: "delivered",
          revision: desired.revision,
          deliveredAtMs: confirmed.appliedAtMs,
        },
      },
      decision: "reminder-adopted",
    };
  });
  return result.value;
}

async function controlsEnabled(env: Env): Promise<boolean> {
  const [profileEnabled, telegramMode, eventControl] = await Promise.all([
    profileBackgroundMutationsEnabled(env),
    readTelegramStorageMode(env.TELEGRAM_DB),
    readEventRuntimeControl(env.EVENT_DB),
  ]);
  return (
    profileEnabled && telegramMode === "d1" && eventControl.storageMode === "d1"
  );
}

export async function refreshSundayMonsReminder(
  env: Env,
  eventId: string,
  dependencies: SundayMonsReminderRefreshDependencies = {},
): Promise<SundayMonsReminderRefreshResult> {
  if (!isSafeRecordKey(eventId)) {
    return { status: "skipped", reason: "invalid-event-id" };
  }
  if (!(await (dependencies.controlsEnabled || controlsEnabled)(env))) {
    throw new Error("event-reminder-writes-disabled");
  }
  const repository =
    dependencies.eventRepository || createEventGameplayRepository(env);
  const announcements =
    dependencies.announcementRepository ||
    createD1TelegramAnnouncementRepository(env.TELEGRAM_DB);
  const [event, receipt] = await Promise.all([
    repository.getStatePath(`events/${eventId}`),
    announcements.get(`event:${eventId}:reminder:v1`),
  ]);
  if (!isSundayMonsReminderEvent(eventId, event) || !isV2TelegramEvent(event)) {
    return { status: "skipped", reason: "reminder-not-eligible" };
  }
  if (!confirmedReminder(eventId, receipt, env.TELEGRAM_EXTRA_CHAT_ID)) {
    return { status: "skipped", reason: "reminder-not-confirmed" };
  }
  const nowMs = (dependencies.now || Date.now)();
  const requestId = (
    dependencies.createRequestId || (() => crypto.randomUUID())
  )();
  const task: EventTelegramProjectionTask = {
    kind: "event-telegram-projection",
    eventId,
    requestId,
  };
  await repository.patchStateRoot({
    [getEventTelegramProjectionOutboxPath(eventId)]:
      buildEventTelegramProjectionOutbox(requestId, nowMs),
    [getEventTelegramProjectionGenerationPath(eventId)]: stateIncrement(1),
  });
  let reason: string | undefined;
  try {
    await (
      dependencies.enqueue ||
      ((value) => env.TELEGRAM_PROJECTION_QUEUE.send(value))
    )(task);
  } catch {
    reason = "dispatch-deferred";
    (dependencies.logger || console).error(
      JSON.stringify({
        event: "event_reminder_projection_enqueue_failed",
        eventId,
      }),
    );
  }
  return {
    status: "queued",
    requestId,
    messageKey: `event:${eventId}:reminder`,
    ...(reason ? { reason } : {}),
  };
}
