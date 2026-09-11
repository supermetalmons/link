export class EventSchedulingError extends Error {
  code: "invalid-argument";
}

export function assertScheduledStartWindow(
  startAtMs: number,
  nowMs: number,
): void;
export function hasDateTimeScheduleRequest(value: unknown): boolean;
export function parseScheduledDateParts(value: unknown): {
  year: number;
  month: number;
  day: number;
} | null;
export function parseScheduledTimeParts(value: unknown): {
  hour: number;
  minute: number;
} | null;
export function resolveRequestedScheduleTimezone(
  request: Record<string, unknown>,
): string;
export function resolveScheduledDateTimeStartAtMs(
  request: Record<string, unknown>,
  nowMs?: number,
): number;
