// Generated from src/telegram/sundayMonsReminder.ts. Run npm run generate:runtime.
export type SundayMonsReminder = {
  eventId: string;
  eventUrl: string;
  text: string;
  parseMode: "HTML";
};
declare const SUNDAY_MONS_REMINDER_LEAD_MS = 14400000;
declare const isSundayMonsReminderLeadMs: (
  value: unknown,
) => value is 10800000 | 14400000;
declare const isSundayMonsReminderEvent: (
  eventId: unknown,
  eventData: unknown,
) => boolean;
declare const buildSundayMonsReminder: {
  (input: {
    eventId: unknown;
    eventData?: unknown;
    leadMs?: 10800000 | 14400000;
  }): SundayMonsReminder;
  (input: unknown): SundayMonsReminder;
};
declare const getSundayMonsReminderLeadMs: (
  eventId: unknown,
  text: unknown,
) => 10800000 | 14400000 | null;
export {
  SUNDAY_MONS_REMINDER_LEAD_MS,
  buildSundayMonsReminder,
  getSundayMonsReminderLeadMs,
  isSundayMonsReminderLeadMs,
  isSundayMonsReminderEvent,
};
