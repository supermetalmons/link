// Generated from src/events/requests.ts. Run npm run generate:runtime.
export declare function eventRequestId(value: unknown): string;
export declare function eventRequestMatchKey(value: unknown): string;
export declare function eventRequestPostponeMinutes(value: unknown): number;
export declare function eventRequestStartsInMinutes(value: unknown): number;
export declare function eventCreateOptions(value: unknown): {
  validSundayMons: boolean;
  isSundayMons: boolean;
  telegramAnnouncements: import("../shared/events.js").EventTelegramAnnouncements;
};
