import type { EventAnnouncementKind } from "./eventAnnouncementKinds.ts";
import { getSundayMonsReminderLeadMs } from "../../../runtime/telegram/sundayMonsReminder.js";

declare const announcementPayload: unique symbol;
declare const announcementAttempt: unique symbol;
export type TelegramAnnouncementPayloadDocument = {
  readonly [announcementPayload]: true;
};
export type RetainedTelegramAnnouncementAttempt = {
  readonly [announcementAttempt]: true;
};
export type TelegramAnnouncementOutcomeStatus =
  "sent" | "retryable" | "terminal" | "uncertain";

export function readTelegramAnnouncementPayloadDocument(
  value: unknown,
): TelegramAnnouncementPayloadDocument | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as TelegramAnnouncementPayloadDocument)
    : null;
}

export function retainTelegramAnnouncementAttempt(
  value: unknown,
): RetainedTelegramAnnouncementAttempt {
  return value as RetainedTelegramAnnouncementAttempt;
}

export type TelegramAlbumPayload = {
  chatId: string;
  imageUrls: string[];
  text: string;
  parseMode: "HTML";
  hasSpoiler: true;
  silent: false;
};

export type TelegramReminderPayload = {
  chatId: string;
  text: string;
  parseMode: "HTML";
  silent: false;
  imageUrls?: never;
  hasSpoiler?: never;
};

export type TelegramAnnouncementPayload =
  TelegramAlbumPayload | TelegramReminderPayload;

export function parseTelegramAnnouncementPayload(
  value: unknown,
  kind: EventAnnouncementKind,
): TelegramAnnouncementPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.chatId !== "string" ||
    !payload.chatId.trim() ||
    typeof payload.text !== "string" ||
    !payload.text ||
    payload.parseMode !== "HTML" ||
    payload.silent !== false
  ) {
    return null;
  }
  if (kind === "reminder") {
    if (
      Object.hasOwn(payload, "imageUrls") ||
      Object.hasOwn(payload, "hasSpoiler")
    ) {
      return null;
    }
    return {
      chatId: payload.chatId,
      text: payload.text,
      parseMode: "HTML",
      silent: false,
    };
  }
  if (
    payload.hasSpoiler !== true ||
    !Array.isArray(payload.imageUrls) ||
    payload.imageUrls.length < 2 ||
    payload.imageUrls.length > 10 ||
    !payload.imageUrls.every((url) => typeof url === "string" && url.trim())
  ) {
    return null;
  }
  return {
    chatId: payload.chatId,
    imageUrls: payload.imageUrls,
    text: payload.text,
    parseMode: "HTML",
    hasSpoiler: true,
    silent: false,
  };
}

export function isTelegramAlbumPayload(
  value: TelegramAnnouncementPayload,
): value is TelegramAlbumPayload {
  return "imageUrls" in value;
}

export function confirmedTelegramReminderText(
  value: TelegramAnnouncementPayloadDocument | null | undefined,
  chatId: string,
  eventId: string,
): { text: string } | null {
  const retained: unknown = value;
  const payload = retained as
    | {
        chatId?: unknown;
        parseMode?: unknown;
        silent?: unknown;
        text?: unknown;
      }
    | null
    | undefined;
  if (
    !payload ||
    payload.chatId !== chatId.trim() ||
    payload.parseMode !== "HTML" ||
    payload.silent !== false ||
    typeof payload.text !== "string" ||
    Object.hasOwn(payload, "imageUrls") ||
    Object.hasOwn(payload, "hasSpoiler")
  )
    return null;
  if (!getSundayMonsReminderLeadMs(eventId, payload.text)) return null;
  return { text: payload.text };
}
