// Generated from src/events/scheduling.ts. Run npm run generate:runtime.
type Signature_assertScheduledStartWindow = (
  startAtMs: number,
  nowMs: number,
) => void;
type Signature_hasDateTimeScheduleRequest = (value: unknown) => boolean;
type Signature_parseScheduledDateParts = (value: unknown) => {
  year: number;
  month: number;
  day: number;
} | null;
type Signature_parseScheduledTimeParts = (value: unknown) => {
  hour: number;
  minute: number;
} | null;
type Signature_resolveRequestedScheduleTimezone = (
  request: Record<string, unknown>,
) => string;
type Signature_resolveScheduledDateTimeStartAtMs = (
  request: Record<string, unknown>,
  nowMs?: number,
) => number;
declare class EventSchedulingError extends Error {
  code: "invalid-argument";
  constructor(code: "invalid-argument", message: string);
}
declare const parseScheduledDateParts: Signature_parseScheduledDateParts;
declare const parseScheduledTimeParts: Signature_parseScheduledTimeParts;
declare const hasDateTimeScheduleRequest: Signature_hasDateTimeScheduleRequest;
declare const resolveRequestedScheduleTimezone: Signature_resolveRequestedScheduleTimezone;
declare const resolveScheduledDateTimeStartAtMs: Signature_resolveScheduledDateTimeStartAtMs;
declare const assertScheduledStartWindow: Signature_assertScheduledStartWindow;
export {
  EventSchedulingError,
  assertScheduledStartWindow,
  hasDateTimeScheduleRequest,
  parseScheduledDateParts,
  parseScheduledTimeParts,
  resolveRequestedScheduleTimezone,
  resolveScheduledDateTimeStartAtMs,
};
