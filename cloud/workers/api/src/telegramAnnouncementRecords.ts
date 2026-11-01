import type { EventAnnouncementKind } from "./eventAnnouncementKinds.ts";
import { getSundayMonsReminderLeadMs } from "../../../runtime/telegram/sundayMonsReminder.js";

export type TelegramAnnouncementPayloadDocument = TelegramAnnouncementPayload;
export type TelegramAnnouncementOutcomeStatus =
  "sent" | "retryable" | "terminal" | "uncertain";
export type TelegramAnnouncementAttempt = {
  eventId: string;
  startAtMs: number;
  runAtMs: number;
  firstQueuedAtMs: number;
  attemptId: string;
  expectedAttemptId: string | null;
} & (
  | { kind: "prizes"; payload: TelegramAlbumPayload }
  | { kind: "reminder"; payload: TelegramReminderPayload }
);
export type RetainedTelegramAnnouncementAttempt = TelegramAnnouncementAttempt;
export function retainTelegramAnnouncementAttempt(
  value: TelegramAnnouncementAttempt,
): TelegramAnnouncementAttempt {
  return value;
}
export function readTelegramAnnouncementPayloadDocument(
  value: unknown,
): TelegramAnnouncementPayloadDocument | null {
  return (
    parseTelegramAnnouncementPayload(value, "prizes") ??
    parseTelegramAnnouncementPayload(value, "reminder")
  );
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
    Object.keys(payload).some(
      (key) =>
        !(
          kind === "prizes"
            ? [
                "chatId",
                "imageUrls",
                "text",
                "parseMode",
                "hasSpoiler",
                "silent",
              ]
            : ["chatId", "text", "parseMode", "silent"]
        ).includes(key),
    ) ||
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
  const payload = value;
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
