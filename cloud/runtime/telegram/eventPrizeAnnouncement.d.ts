export type EventPrizeAnnouncement = {
  collectionName: string;
  eventId: string;
  eventUrl: string;
  imageUrls: string[];
  parseMode: "HTML";
  text: string;
};

export const EVENT_PRIZE_ANNOUNCEMENT_PARSE_MODE: "HTML";
export const EVENT_PRIZE_ANNOUNCEMENT_LEAD_MS: 3600000;
export const EVENT_PRIZE_ANNOUNCEMENT_GRACE_MS: 60000;
export const EVENT_PRIZE_ANNOUNCEMENT_PREFIX: string;
export const EVENT_URL_ROOT: string;
export const TELEGRAM_MEDIA_CAPTION_MAX_LENGTH: number;
export function buildEventPrizeAnnouncement(
  input: unknown,
): EventPrizeAnnouncement;
export function isEventPrizeAnnouncementEvent(
  eventId: unknown,
  eventData: unknown,
): boolean;
