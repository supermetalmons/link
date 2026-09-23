import type {
  EventCreateDateTimePayload,
  EventScheduleTimezone,
} from "@mons/shared/events";

export type EventScheduleFields = {
  mode: "minutes" | "datetime";
  startsInMinutes: string;
  scheduledDate: string;
  scheduledTime: string;
  scheduledTimezone: EventScheduleTimezone;
};

type EventScheduleValidation =
  | { ok: true; schedule: number | EventCreateDateTimePayload }
  | { ok: false; error: string };

const pad2 = (value: number): string => String(value).padStart(2, "0");

export const getDefaultScheduledDateTimeInput = (
  nowMs: number = Date.now(),
): { date: string; time: string } => {
  const minimumStartMs = nowMs + 30 * 60 * 1000;
  const rounded = new Date(minimumStartMs);
  rounded.setMinutes(0, 0, 0);
  if (rounded.getTime() < minimumStartMs) {
    rounded.setHours(rounded.getHours() + 1);
  }
  return {
    date: `${rounded.getFullYear()}-${pad2(rounded.getMonth() + 1)}-${pad2(rounded.getDate())}`,
    time: `${pad2(rounded.getHours())}:${pad2(rounded.getMinutes())}`,
  };
};

export const validateEventCreateSchedule = (
  fields: EventScheduleFields,
  localTimezoneIana: string | undefined,
): EventScheduleValidation => {
  if (fields.mode === "minutes") {
    const startsInMinutes = Math.floor(Number(fields.startsInMinutes));
    if (!Number.isFinite(startsInMinutes) || startsInMinutes < 1) {
      return { ok: false, error: "Enter at least 1 minute." };
    }
    return { ok: true, schedule: startsInMinutes };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.scheduledDate)) {
    return { ok: false, error: "Enter a valid date." };
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(fields.scheduledTime)) {
    return { ok: false, error: "Enter a valid time." };
  }
  if (fields.scheduledTimezone === "local" && !localTimezoneIana) {
    return { ok: false, error: "Could not detect local timezone." };
  }
  return {
    ok: true,
    schedule: {
      scheduledDate: fields.scheduledDate,
      scheduledTime: fields.scheduledTime,
      scheduledTimezone: fields.scheduledTimezone,
      ...(fields.scheduledTimezone === "local" ? { localTimezoneIana } : {}),
    },
  };
};
