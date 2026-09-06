import {
  EVENT_PRIZE_ANNOUNCEMENT_LEAD_MS,
  isEventPrizeAnnouncementEvent,
} from "../../../functions/telegram/eventPrizeAnnouncement.js";
import {
  SUNDAY_MONS_REMINDER_LEAD_MS,
  isSundayMonsReminderEvent,
} from "../../../functions/telegram/sundayMonsReminder.js";

export const EVENT_ANNOUNCEMENT_KINDS = ["prizes", "reminder"] as const;
export type EventAnnouncementKind = (typeof EVENT_ANNOUNCEMENT_KINDS)[number];

export const EVENT_ANNOUNCEMENT_SPECS = {
  prizes: {
    reason: "event-prize-announcement",
    leadMs: EVENT_PRIZE_ANNOUNCEMENT_LEAD_MS,
    stepName: "prize announcement",
    isEligible: isEventPrizeAnnouncementEvent,
  },
  reminder: {
    reason: "sunday-mons-reminder",
    leadMs: SUNDAY_MONS_REMINDER_LEAD_MS,
    stepName: "sunday mons reminder",
    isEligible: isSundayMonsReminderEvent,
  },
} as const;

export function getEventAnnouncementKind(
  reason: unknown,
): EventAnnouncementKind | null {
  return (
    EVENT_ANNOUNCEMENT_KINDS.find(
      (kind) => EVENT_ANNOUNCEMENT_SPECS[kind].reason === reason,
    ) || null
  );
}
