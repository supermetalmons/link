// Generated from src/telegram/eventPrizeAnnouncement.ts. Run npm run generate:runtime.
export type EventPrizeAnnouncement = {
  collectionName: string;
  eventId: string;
  eventUrl: string;
  imageUrls: string[];
  parseMode: "HTML";
  text: string;
};
declare const EVENT_URL_ROOT = "https://mons.link/event/";
declare const EVENT_PRIZE_ANNOUNCEMENT_PREFIX = "sunday mons treats \u2014 ";
declare const EVENT_PRIZE_ANNOUNCEMENT_PARSE_MODE = "HTML";
declare const EVENT_PRIZE_ANNOUNCEMENT_LEAD_MS = 3600000;
declare const EVENT_PRIZE_ANNOUNCEMENT_GRACE_MS = 60000;
declare const TELEGRAM_MEDIA_CAPTION_MAX_LENGTH = 1024;
declare const isEventPrizeAnnouncementEvent: (
  eventId: unknown,
  eventData: unknown,
) => boolean;
declare const buildEventPrizeAnnouncement: (
  input: unknown,
) => EventPrizeAnnouncement;
export {
  EVENT_PRIZE_ANNOUNCEMENT_GRACE_MS,
  EVENT_PRIZE_ANNOUNCEMENT_LEAD_MS,
  EVENT_PRIZE_ANNOUNCEMENT_PARSE_MODE,
  EVENT_PRIZE_ANNOUNCEMENT_PREFIX,
  EVENT_URL_ROOT,
  TELEGRAM_MEDIA_CAPTION_MAX_LENGTH,
  buildEventPrizeAnnouncement,
  isEventPrizeAnnouncementEvent,
};
