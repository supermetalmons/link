export const MONS_LINK_ADMIN_USERNAMES: readonly [
  "ivan",
  "meinong",
  "obi",
  "bosch",
  "monsol",
  "bosch2",
  "trinket",
];
export type MonsLinkAdminUsername = (typeof MONS_LINK_ADMIN_USERNAMES)[number];
export function isMonsLinkAdmin(value: unknown): value is MonsLinkAdminUsername;
export function isEventOwnedInvite(value: unknown): boolean;

export const EVENT_SCHEMA_VERSION: 2;
export const THIRD_PLACE_MATCH_KEY: "third_place";
export const MIN_STARTS_IN_MINUTES: 1;
export const MAX_STARTS_IN_DAYS: 14;
export const MAX_STARTS_IN_MINUTES: 20160;
export const MAX_EVENT_PARTICIPANTS: 32;
export const MAX_EVENT_PARTICIPANT_TEXT_BYTES: 256;
export const SCHEDULED_TIMEZONE_LOCAL: "local";

export type EventScheduleTimezone = "local" | "ET" | "PT" | "CT";
export type EventCreateDateTimePayload = {
  scheduledDate: string;
  scheduledTime: string;
  scheduledTimezone: EventScheduleTimezone;
  localTimezoneIana?: string;
};
export const EVENT_SCHEDULE_TIMEZONE_OPTIONS: readonly [
  Readonly<{ value: "local"; label: "Local" }>,
  Readonly<{ value: "ET"; label: "ET" }>,
  Readonly<{ value: "PT"; label: "PT" }>,
  Readonly<{ value: "CT"; label: "CT" }>,
];

export type EventPostponeMinutes = 5 | 10 | 15;
export const EVENT_POSTPONE_OPTIONS_MINUTES: readonly [5, 10, 15];

export type EventParticipantSnapshot = {
  profileId: string;
  loginUid: string;
  username: string;
  displayName: string;
  emojiId: number;
  aura: string;
  joinedAtMs: number;
  state: "active";
  eliminatedRoundIndex: null;
  eliminatedByProfileId: null;
};

export type JoinEventRequest = { eventId: string };
export type JoinEventResponse = {
  ok: true;
  eventId: string;
  participant: EventParticipantSnapshot;
};
export type RemoveEventParticipantRequest = {
  eventId: string;
  participantProfileId: string;
};
export type RemoveEventParticipantResponse = {
  ok: true;
  eventId: string;
  removedProfileId: string;
};

export function isEventParticipantSnapshot(
  value: unknown,
): value is EventParticipantSnapshot;
export function isJoinEventRequest(value: unknown): value is JoinEventRequest;
export function isJoinEventResponse(value: unknown): value is JoinEventResponse;
export function isRemoveEventParticipantRequest(
  value: unknown,
): value is RemoveEventParticipantRequest;
export function isRemoveEventParticipantResponse(
  value: unknown,
): value is RemoveEventParticipantResponse;

export type EventMatchKeyParts = {
  roundIndex: number;
  matchIndex: number;
};

export function buildEventMatchKey(
  roundIndex: number,
  matchIndex: number,
): string;
export function parseEventMatchKey(
  matchKey: unknown,
): EventMatchKeyParts | null;
export function getEventBracketSize(participantCount: number): number;
export function buildEventSeedOrder(bracketSize: number): number[];
export function getFirstRoundByeSeeds(
  participantCount: number,
  bracketSize: number,
  seedOrder: readonly number[],
): number[];
