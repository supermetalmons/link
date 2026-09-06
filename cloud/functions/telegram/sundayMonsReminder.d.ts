export type SundayMonsReminder = {
  eventId: string;
  eventUrl: string;
  text: string;
  parseMode: "HTML";
};

export const SUNDAY_MONS_REMINDER_LEAD_MS: 10800000;
export function buildSundayMonsReminder(input: unknown): SundayMonsReminder;
export function isSundayMonsReminderEvent(
  eventId: unknown,
  eventData: unknown,
): boolean;
