"use strict";

class EventSchedulingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const {
  MAX_STARTS_IN_DAYS,
  MAX_STARTS_IN_MINUTES,
  MIN_STARTS_IN_MINUTES,
  SCHEDULED_TIMEZONE_LOCAL,
} = require("@mons/shared/events");

const MIN_START_AHEAD_MS = MIN_STARTS_IN_MINUTES * 60 * 1000;
const MAX_START_AHEAD_MS = MAX_STARTS_IN_MINUTES * 60 * 1000;
const SCHEDULED_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SCHEDULED_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const PRESET_EVENT_TIMEZONE_BY_KEY = {
  ET: "America/New_York",
  PT: "America/Los_Angeles",
  CT: "America/Chicago",
};
const ZONED_WALL_TIME_SEARCH_WINDOW_MS = 18 * 60 * 60 * 1000;
const ZONED_WALL_TIME_SEARCH_STEP_MS = 60 * 1000;
const zonedDateTimeFormatterByTimezone = new Map();

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const toFiniteInteger = (value, fallback = 0) => {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.floor(numeric);
};

const getZonedDateTimeFormatter = (timeZone) => {
  const normalizedTimeZone = normalizeString(timeZone);
  if (!normalizedTimeZone) {
    throw new Error("timeZone is required");
  }
  if (zonedDateTimeFormatterByTimezone.has(normalizedTimeZone)) {
    return zonedDateTimeFormatterByTimezone.get(normalizedTimeZone);
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizedTimeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  zonedDateTimeFormatterByTimezone.set(normalizedTimeZone, formatter);
  return formatter;
};

const getZonedDateTimeParts = (timestampMs, timeZone) => {
  const formatter = getZonedDateTimeFormatter(timeZone);
  const parts = formatter.formatToParts(new Date(timestampMs));
  let year = NaN;
  let month = NaN;
  let day = NaN;
  let hour = NaN;
  let minute = NaN;
  for (const part of parts) {
    if (part.type === "year") {
      year = toFiniteInteger(part.value, NaN);
    } else if (part.type === "month") {
      month = toFiniteInteger(part.value, NaN);
    } else if (part.type === "day") {
      day = toFiniteInteger(part.value, NaN);
    } else if (part.type === "hour") {
      hour = toFiniteInteger(part.value, NaN);
    } else if (part.type === "minute") {
      minute = toFiniteInteger(part.value, NaN);
    }
  }
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return null;
  }
  return { year, month, day, hour, minute };
};

const parseScheduledDateParts = (value) => {
  const normalizedValue = normalizeString(value);
  const match = normalizedValue.match(SCHEDULED_DATE_PATTERN);
  if (!match) {
    return null;
  }
  const year = toFiniteInteger(match[1], NaN);
  const month = toFiniteInteger(match[2], NaN);
  const day = toFiniteInteger(match[3], NaN);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  const candidate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
};

const parseScheduledTimeParts = (value) => {
  const normalizedValue = normalizeString(value);
  const match = normalizedValue.match(SCHEDULED_TIME_PATTERN);
  if (!match) {
    return null;
  }
  const hour = toFiniteInteger(match[1], NaN);
  const minute = toFiniteInteger(match[2], NaN);
  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  return { hour, minute };
};

const isValidIanaTimezone = (value) => {
  const normalizedValue = normalizeString(value);
  if (!normalizedValue) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalizedValue }).format(
      new Date(0),
    );
    return true;
  } catch {
    return false;
  }
};

const hasDateTimeScheduleRequest = (data) => {
  if (!data || typeof data !== "object") {
    return false;
  }
  return (
    normalizeString(data.scheduledDate) !== "" ||
    normalizeString(data.scheduledTime) !== "" ||
    normalizeString(data.scheduledTimezone) !== ""
  );
};

const resolveRequestedScheduleTimezone = (data) => {
  const scheduledTimezoneRaw = normalizeString(data && data.scheduledTimezone);
  if (!scheduledTimezoneRaw) {
    throw new EventSchedulingError(
      "invalid-argument",
      "scheduledTimezone is required for date/time scheduling.",
    );
  }
  if (scheduledTimezoneRaw.toLowerCase() === SCHEDULED_TIMEZONE_LOCAL) {
    const localTimezoneIana = normalizeString(data && data.localTimezoneIana);
    if (!localTimezoneIana) {
      throw new EventSchedulingError(
        "invalid-argument",
        "localTimezoneIana is required when scheduledTimezone is local.",
      );
    }
    if (!isValidIanaTimezone(localTimezoneIana)) {
      throw new EventSchedulingError(
        "invalid-argument",
        "localTimezoneIana must be a valid IANA timezone.",
      );
    }
    return localTimezoneIana;
  }
  const timezoneKey = scheduledTimezoneRaw.toUpperCase();
  const resolvedTimezone = PRESET_EVENT_TIMEZONE_BY_KEY[timezoneKey];
  if (!resolvedTimezone) {
    throw new EventSchedulingError(
      "invalid-argument",
      "scheduledTimezone must be one of: local, ET, PT, CT.",
    );
  }
  return resolvedTimezone;
};

const resolveScheduledDateTimeStartAtMs = (data, nowMs = Date.now()) => {
  const scheduledDate = normalizeString(data && data.scheduledDate);
  if (!scheduledDate) {
    throw new EventSchedulingError(
      "invalid-argument",
      "scheduledDate is required for date/time scheduling.",
    );
  }
  const scheduledTime = normalizeString(data && data.scheduledTime);
  if (!scheduledTime) {
    throw new EventSchedulingError(
      "invalid-argument",
      "scheduledTime is required for date/time scheduling.",
    );
  }

  const dateParts = parseScheduledDateParts(scheduledDate);
  if (!dateParts) {
    throw new EventSchedulingError(
      "invalid-argument",
      "scheduledDate must be in YYYY-MM-DD format.",
    );
  }
  const timeParts = parseScheduledTimeParts(scheduledTime);
  if (!timeParts) {
    throw new EventSchedulingError(
      "invalid-argument",
      "scheduledTime must be in HH:mm 24-hour format.",
    );
  }

  const timeZone = resolveRequestedScheduleTimezone(data);
  const targetUtcApproxMs = Date.UTC(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    timeParts.hour,
    timeParts.minute,
    0,
    0,
  );
  const candidateStartMs = targetUtcApproxMs - ZONED_WALL_TIME_SEARCH_WINDOW_MS;
  const candidateEndMs = targetUtcApproxMs + ZONED_WALL_TIME_SEARCH_WINDOW_MS;
  const matchingInstants = [];

  for (
    let candidateMs = candidateStartMs;
    candidateMs <= candidateEndMs;
    candidateMs += ZONED_WALL_TIME_SEARCH_STEP_MS
  ) {
    const parts = getZonedDateTimeParts(candidateMs, timeZone);
    if (!parts) {
      continue;
    }
    if (
      parts.year === dateParts.year &&
      parts.month === dateParts.month &&
      parts.day === dateParts.day &&
      parts.hour === timeParts.hour &&
      parts.minute === timeParts.minute
    ) {
      matchingInstants.push(candidateMs);
    }
  }

  if (matchingInstants.length <= 0) {
    throw new EventSchedulingError(
      "invalid-argument",
      "Selected date/time does not exist in the selected timezone.",
    );
  }

  const normalizedNowMs = toFiniteInteger(nowMs, NaN);
  if (Number.isFinite(normalizedNowMs)) {
    const nextFutureInstantMs = matchingInstants.find(
      (candidateMs) => candidateMs > normalizedNowMs,
    );
    if (typeof nextFutureInstantMs === "number") {
      return nextFutureInstantMs;
    }
  }

  return matchingInstants[0];
};

const assertScheduledStartWindow = (startAtMs, nowMs) => {
  const deltaMs = toFiniteInteger(startAtMs, 0) - toFiniteInteger(nowMs, 0);
  if (deltaMs < MIN_START_AHEAD_MS) {
    throw new EventSchedulingError(
      "invalid-argument",
      `Event must start at least ${MIN_STARTS_IN_MINUTES} minute from now.`,
    );
  }
  if (deltaMs > MAX_START_AHEAD_MS) {
    throw new EventSchedulingError(
      "invalid-argument",
      `Event must start within ${MAX_STARTS_IN_DAYS} days from now.`,
    );
  }
};

module.exports = {
  EventSchedulingError,
  assertScheduledStartWindow,
  hasDateTimeScheduleRequest,
  parseScheduledDateParts,
  parseScheduledTimeParts,
  resolveRequestedScheduleTimezone,
  resolveScheduledDateTimeStartAtMs,
};
