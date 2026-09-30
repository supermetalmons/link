// Generated from src/shared/events.ts. Run npm run generate:runtime.
export type MonsLinkAdminUsername = (typeof MONS_LINK_ADMIN_USERNAMES)[number];
export type EventScheduleTimezone = "local" | "ET" | "PT" | "CT";
export type EventCreateDateTimePayload = {
  scheduledDate: string;
  scheduledTime: string;
  scheduledTimezone: EventScheduleTimezone;
  localTimezoneIana?: string;
};
export type EventPostponeMinutes = 5 | 10 | 15;
export type EventTelegramAnnouncements = {
  invite: boolean;
  matches: boolean;
  results: boolean;
};
export type EventCreateOptions = {
  isSundayMons?: boolean;
  announceOnTelegram?: boolean;
  telegramAnnouncements?: EventTelegramAnnouncements;
};
export type CreateEventRequest = EventCreateOptions &
  (
    | {
        startsInMinutes: number;
      }
    | EventCreateDateTimePayload
  );
export type PostponeEventStartRequest = {
  eventId: string;
  postponeByMinutes: EventPostponeMinutes;
};
export type DisqualifyEventMatchWinnersRequest = {
  eventId: string;
  matchKey: string;
};
export type SyncEventStateRequest = {
  eventId: string;
};
export type EventApiRecord = Record<string, unknown> & {
  eventId: string;
  status: string;
  isSundayMons?: boolean;
};
export type CreateEventResponse = {
  ok: true;
  eventId: string;
  event: EventApiRecord;
};
export type EventSnapshotResponse = {
  ok: true;
  eventId: string;
  revision: number;
  event: EventApiRecord | null;
  prizeSelections: Record<string, string>;
};
export type EventSnapshotSeed = {
  snapshot: EventSnapshotResponse;
  etag: string;
  bookmark: string;
};
export type PostponeEventStartResponse = CreateEventResponse & {
  postponeByMinutes: EventPostponeMinutes;
  startAtMs: number;
};
export type EventSyncSkipReason = "locked" | "not-participant" | "rate-limited";
export type SyncEventStateResponse =
  | {
      ok: true;
      eventId: string;
      didChange: boolean;
      event: EventApiRecord;
    }
  | {
      ok: true;
      eventId: string;
      skipped: true;
      reason: EventSyncSkipReason;
      event?: EventApiRecord;
    };
export type DisqualifyEventMatchWinnersResponse = SyncEventStateResponse & {
  didDisqualify: boolean;
  matchKey: string;
};
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
export type JoinEventRequest = {
  eventId: string;
};
export type JoinEventResponse = {
  ok: true;
  eventId: string;
  participant: EventParticipantSnapshot;
};
export type LeaveEventRequest = {
  eventId: string;
};
export type LeaveEventResponse = {
  ok: true;
  eventId: string;
  removedProfileId: string;
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
export type EventMatchKeyParts = {
  roundIndex: number;
  matchIndex: number;
};
declare const MONS_LINK_ADMIN_USERNAMES: readonly [
  "ivan",
  "meinong",
  "obi",
  "bosch",
  "monsol",
  "bosch2",
  "trinket",
];
declare function isMonsLinkAdmin(
  value: unknown,
): value is MonsLinkAdminUsername;
declare function isEventOwnedInvite(value: unknown): boolean;
declare const EVENT_SCHEMA_VERSION = 2;
declare const THIRD_PLACE_MATCH_KEY = "third_place";
declare const MIN_STARTS_IN_MINUTES = 1;
declare const MAX_STARTS_IN_DAYS = 14;
declare const MAX_STARTS_IN_MINUTES: 20160;
declare const MAX_EVENT_PARTICIPANTS = 32;
declare const SCHEDULED_TIMEZONE_LOCAL = "local";
declare const EVENT_SCHEDULE_TIMEZONE_OPTIONS: readonly [
  Readonly<{
    value: "local";
    label: "Local";
  }>,
  Readonly<{
    value: "ET";
    label: "ET";
  }>,
  Readonly<{
    value: "PT";
    label: "PT";
  }>,
  Readonly<{
    value: "CT";
    label: "CT";
  }>,
];
declare const EVENT_POSTPONE_OPTIONS_MINUTES: readonly [5, 10, 15];
declare const MAX_EVENT_PARTICIPANT_TEXT_BYTES = 256;
declare const EVENT_BOOKMARK_HEADER = "X-D1-Bookmark";
declare const EVENT_ETAG_HEADER = "ETag";
declare const MAX_EVENT_READ_RESPONSE_BYTES: number;
declare const MAX_EVENT_BOOKMARK_LENGTH = 2048;
declare function eventSnapshotEtag(eventId: string, revision: number): string;
declare function eventBookmarkEpoch(value: unknown): string | null;
declare function buildEventMatchKey(
  roundIndex: number,
  matchIndex: number,
): string;
declare function parseEventMatchKey(
  matchKey: unknown,
): EventMatchKeyParts | null;
declare function getEventBracketSize(participantCount: number): number;
declare function buildEventSeedOrder(bracketSize: number): number[];
declare function getFirstRoundByeSeeds(
  participantCount: number,
  bracketSize: number,
  seedOrder: readonly number[],
): number[];
declare function isJoinEventRequest(value: unknown): value is JoinEventRequest;
declare function isLeaveEventRequest(
  value: unknown,
): value is LeaveEventRequest;
declare function isRemoveEventParticipantRequest(
  value: unknown,
): value is RemoveEventParticipantRequest;
declare function isEventParticipantSnapshot(
  value: unknown,
): value is EventParticipantSnapshot;
declare function isJoinEventResponse(
  value: unknown,
): value is JoinEventResponse;
declare function isRemoveEventParticipantResponse(
  value: unknown,
): value is RemoveEventParticipantResponse;
declare function isLeaveEventResponse(
  value: unknown,
): value is LeaveEventResponse;
declare function resolveEventTelegramAnnouncements(input: {
  announceOnTelegram?: unknown;
  telegramAnnouncements?: unknown;
}): EventTelegramAnnouncements;
declare function isCreateEventRequest(
  value: unknown,
): value is CreateEventRequest;
declare function isPostponeEventStartRequest(
  value: unknown,
): value is PostponeEventStartRequest;
declare function isDisqualifyEventMatchWinnersRequest(
  value: unknown,
): value is DisqualifyEventMatchWinnersRequest;
declare function isSyncEventStateRequest(
  value: unknown,
): value is SyncEventStateRequest;
declare function isCreateEventResponse(
  value: unknown,
): value is CreateEventResponse;
declare function isEventSnapshotResponse(
  value: unknown,
): value is EventSnapshotResponse;
declare function isEventSnapshotSeed(
  value: unknown,
): value is EventSnapshotSeed;
declare function isPostponeEventStartResponse(
  value: unknown,
): value is PostponeEventStartResponse;
declare function isSyncEventStateResponse(
  value: unknown,
): value is SyncEventStateResponse;
declare function isDisqualifyEventMatchWinnersResponse(
  value: unknown,
): value is DisqualifyEventMatchWinnersResponse;
export {
  EVENT_POSTPONE_OPTIONS_MINUTES,
  EVENT_BOOKMARK_HEADER,
  EVENT_ETAG_HEADER,
  EVENT_SCHEDULE_TIMEZONE_OPTIONS,
  EVENT_SCHEMA_VERSION,
  MAX_EVENT_PARTICIPANTS,
  MAX_EVENT_PARTICIPANT_TEXT_BYTES,
  MAX_EVENT_READ_RESPONSE_BYTES,
  MAX_EVENT_BOOKMARK_LENGTH,
  eventSnapshotEtag,
  eventBookmarkEpoch,
  isEventSnapshotSeed,
  MAX_STARTS_IN_DAYS,
  MAX_STARTS_IN_MINUTES,
  MIN_STARTS_IN_MINUTES,
  MONS_LINK_ADMIN_USERNAMES,
  SCHEDULED_TIMEZONE_LOCAL,
  THIRD_PLACE_MATCH_KEY,
  buildEventMatchKey,
  buildEventSeedOrder,
  getEventBracketSize,
  getFirstRoundByeSeeds,
  isCreateEventRequest,
  isCreateEventResponse,
  isDisqualifyEventMatchWinnersRequest,
  isDisqualifyEventMatchWinnersResponse,
  isEventOwnedInvite,
  isEventParticipantSnapshot,
  isEventSnapshotResponse,
  isJoinEventRequest,
  isJoinEventResponse,
  isLeaveEventRequest,
  isLeaveEventResponse,
  isMonsLinkAdmin,
  isRemoveEventParticipantRequest,
  isRemoveEventParticipantResponse,
  isPostponeEventStartRequest,
  isPostponeEventStartResponse,
  isSyncEventStateRequest,
  isSyncEventStateResponse,
  parseEventMatchKey,
  resolveEventTelegramAnnouncements,
};
