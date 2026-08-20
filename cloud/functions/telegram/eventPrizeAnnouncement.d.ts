export type EventPrizeAnnouncement = {
  eventId: string;
  eventUrl: string;
  imageUrls: string[];
  text: string;
};

export const EVENT_URL_ROOT: string;
export const TELEGRAM_MEDIA_CAPTION_MAX_LENGTH: number;
export function buildEventPrizeAnnouncement(
  input: unknown,
): EventPrizeAnnouncement;
