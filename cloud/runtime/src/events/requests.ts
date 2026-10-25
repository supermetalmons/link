import { resolveEventTelegramAnnouncements } from "../shared/events.js";

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

const trimmed = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function integer(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : 0;
}

export function eventRequestId(value: unknown): string {
  return trimmed(fields(value).eventId);
}

export function eventRequestMatchKey(value: unknown): string {
  return trimmed(fields(value).matchKey);
}

export function eventRequestPostponeMinutes(value: unknown): number {
  return integer(fields(value).postponeByMinutes);
}

export function eventRequestStartsInMinutes(value: unknown): number {
  return integer(fields(value).startsInMinutes);
}

export function eventCreateOptions(value: unknown) {
  const data = fields(value);
  return {
    validSundayMons:
      !Object.hasOwn(data, "isSundayMons") ||
      typeof data.isSundayMons === "boolean",
    isSundayMons: data.isSundayMons === true,
    telegramAnnouncements: resolveEventTelegramAnnouncements(data),
  };
}
