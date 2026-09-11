export type SundayMonsReminder = {
  eventId: string;
  eventUrl: string;
  text: string;
  parseMode: "HTML";
};

export const SUNDAY_MONS_REMINDER_LEAD_MS: 14400000;
export function isSundayMonsReminderLeadMs(
  value: unknown,
): value is 10800000 | 14400000;
export function getSundayMonsReminderLeadMs(
  eventId: unknown,
  text: unknown,
): 10800000 | 14400000 | null;
export function buildSundayMonsReminder(input: {
  eventId: unknown;
  eventData?: unknown;
  leadMs?: 10800000 | 14400000;
}): SundayMonsReminder;
export function buildSundayMonsReminder(input: unknown): SundayMonsReminder;
export function isSundayMonsReminderEvent(
  eventId: unknown,
  eventData: unknown,
): boolean;
