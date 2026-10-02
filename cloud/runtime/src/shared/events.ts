import { isSafeRecordKey } from "./ids.js";
import { cropAddress } from "./profiles.js";

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
  telegramAnnouncements?: EventTelegramAnnouncements;
};

export type CreateEventRequest = EventCreateOptions &
  ({ startsInMinutes: number } | EventCreateDateTimePayload);

export type PostponeEventStartRequest = {
  eventId: string;
  postponeByMinutes: EventPostponeMinutes;
};

export type DisqualifyEventMatchWinnersRequest = {
  eventId: string;
  matchKey: string;
};

export type SyncEventStateRequest = { eventId: string };

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

export type EventParticipantProfile = Readonly<{
  profileId: string;
  username: string;
  eth: string;
  sol: string;
  emoji: number | string;
  aura: string;
}>;

export type JoinEventRequest = { eventId: string };

export type JoinEventResponse = {
  ok: true;
  eventId: string;
  participant: EventParticipantSnapshot;
};

export type LeaveEventRequest = { eventId: string };

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

const MONS_LINK_ADMIN_USERNAMES = Object.freeze([
  "ivan",
  "meinong",
  "obi",
  "bosch",
  "monsol",
  "bosch2",
  "trinket",
] as const);

function isMonsLinkAdmin(value: unknown): value is MonsLinkAdminUsername {
  return (MONS_LINK_ADMIN_USERNAMES as readonly unknown[]).includes(value);
}

function isEventOwnedInvite(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    ((value as Record<string, unknown>).eventOwned === true ||
      (typeof (value as Record<string, unknown>).eventId === "string" &&
        (value as { eventId: string }).eventId.trim() !== ""))
  );
}

const EVENT_SCHEMA_VERSION = 2;
const THIRD_PLACE_MATCH_KEY = "third_place";
const MIN_STARTS_IN_MINUTES = 1;
const MAX_STARTS_IN_DAYS = 14;
const MAX_STARTS_IN_MINUTES: 20160 = (MAX_STARTS_IN_DAYS * 24 * 60) as 20160;
const MAX_EVENT_PARTICIPANTS = 32;
const SCHEDULED_TIMEZONE_LOCAL = "local";
const EVENT_SCHEDULE_TIMEZONE_OPTIONS = Object.freeze([
  Object.freeze({ value: SCHEDULED_TIMEZONE_LOCAL, label: "Local" }),
  Object.freeze({ value: "ET", label: "ET" }),
  Object.freeze({ value: "PT", label: "PT" }),
  Object.freeze({ value: "CT", label: "CT" }),
] as const);
const EVENT_POSTPONE_OPTIONS_MINUTES = Object.freeze([5, 10, 15] as const);
const MAX_EVENT_PARTICIPANT_TEXT_BYTES = 256;
const EVENT_BOOKMARK_HEADER = "X-D1-Bookmark";
const EVENT_ETAG_HEADER = "ETag";
const MAX_EVENT_READ_RESPONSE_BYTES: number = 640 * 1024;
const MAX_EVENT_BOOKMARK_LENGTH = 2048;

function eventSnapshotEtag(eventId: string, revision: number): string {
  return `W/"event-snapshot-${encodeURIComponent(eventId)}-${revision}"`;
}

function eventBookmarkEpoch(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_EVENT_BOOKMARK_LENGTH)
    return null;
  const match =
    /^mons-d1-v1:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):([A-Za-z0-9._~+/=-]+)$/i.exec(
      value,
    );
  if (
    !match ||
    match[2] === "first-primary" ||
    match[2] === "first-unconstrained"
  )
    return null;
  return match[1].toLowerCase();
}

const isExactSafeRecordKey = (value: unknown): value is string =>
  typeof value === "string" && value.trim() === value && isSafeRecordKey(value);

function buildEventMatchKey(roundIndex: number, matchIndex: number): string {
  return `${roundIndex}_${matchIndex}`;
}

function parseEventMatchKey(matchKey: unknown): EventMatchKeyParts | null {
  if (typeof matchKey !== "string") {
    return null;
  }
  const parts = /^(\d+)_(\d+)$/.exec(matchKey.trim());
  if (!parts) {
    return null;
  }
  const roundIndex = Number(parts[1]);
  const matchIndex = Number(parts[2]);
  if (!Number.isFinite(roundIndex) || !Number.isFinite(matchIndex)) {
    return null;
  }
  return {
    roundIndex,
    matchIndex,
  };
}

function getEventBracketSize(participantCount: number): number {
  let bracketSize = 2;
  while (
    bracketSize < participantCount &&
    bracketSize < MAX_EVENT_PARTICIPANTS
  ) {
    bracketSize *= 2;
  }
  return bracketSize;
}

function buildEventSeedOrder(bracketSize: number): number[] {
  if (bracketSize <= 1) {
    return [1];
  }
  const previous = buildEventSeedOrder(bracketSize / 2);
  const next = [];
  for (const seed of previous) {
    next.push(seed);
    next.push(bracketSize + 1 - seed);
  }
  return next;
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === keys.length &&
    actualKeys.every((key) => keys.includes(key))
  );
}

function isJoinEventRequest(value: unknown): value is JoinEventRequest {
  return isExactRecord(value, ["eventId"]) && isSafeRecordKey(value.eventId);
}

function isLeaveEventRequest(value: unknown): value is LeaveEventRequest {
  return isJoinEventRequest(value);
}

function isRemoveEventParticipantRequest(
  value: unknown,
): value is RemoveEventParticipantRequest {
  return (
    isExactRecord(value, ["eventId", "participantProfileId"]) &&
    isSafeRecordKey(value.eventId) &&
    isSafeRecordKey(value.participantProfileId)
  );
}

function isBoundedParticipantText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).byteLength <=
      MAX_EVENT_PARTICIPANT_TEXT_BYTES
  );
}

function isEventParticipantSnapshot(
  value: unknown,
): value is EventParticipantSnapshot {
  return (
    isExactRecord(value, [
      "profileId",
      "loginUid",
      "username",
      "displayName",
      "emojiId",
      "aura",
      "joinedAtMs",
      "state",
      "eliminatedRoundIndex",
      "eliminatedByProfileId",
    ]) &&
    isSafeRecordKey(value.profileId) &&
    isSafeRecordKey(value.loginUid) &&
    isBoundedParticipantText(value.username) &&
    isBoundedParticipantText(value.displayName) &&
    Number.isSafeInteger(value.emojiId) &&
    (value.emojiId as number) >= 0 &&
    isBoundedParticipantText(value.aura) &&
    Number.isSafeInteger(value.joinedAtMs) &&
    (value.joinedAtMs as number) >= 0 &&
    value.state === "active" &&
    value.eliminatedRoundIndex === null &&
    value.eliminatedByProfileId === null
  );
}

function buildEventParticipantSnapshot(
  profile: EventParticipantProfile,
  loginUid: string,
  joinedAtMs: number,
): EventParticipantSnapshot | null {
  const parsedEmojiId = Math.floor(Number(profile.emoji));
  const participant: EventParticipantSnapshot = {
    profileId: profile.profileId,
    loginUid,
    username: profile.username.trim(),
    displayName:
      profile.username ||
      (profile.eth
        ? cropAddress(profile.eth)
        : profile.sol
          ? cropAddress(profile.sol)
          : "anon"),
    emojiId:
      Number.isSafeInteger(parsedEmojiId) && parsedEmojiId >= 0
        ? parsedEmojiId
        : 0,
    aura: profile.aura.trim(),
    joinedAtMs,
    state: "active",
    eliminatedRoundIndex: null,
    eliminatedByProfileId: null,
  };
  return isEventParticipantSnapshot(participant) ? participant : null;
}

function isJoinEventResponse(value: unknown): value is JoinEventResponse {
  return (
    isExactRecord(value, ["ok", "eventId", "participant"]) &&
    value.ok === true &&
    isSafeRecordKey(value.eventId) &&
    isEventParticipantSnapshot(value.participant)
  );
}

function isRemoveEventParticipantResponse(
  value: unknown,
): value is RemoveEventParticipantResponse {
  return (
    isExactRecord(value, ["ok", "eventId", "removedProfileId"]) &&
    value.ok === true &&
    isSafeRecordKey(value.eventId) &&
    isSafeRecordKey(value.removedProfileId)
  );
}

function isLeaveEventResponse(value: unknown): value is LeaveEventResponse {
  return isRemoveEventParticipantResponse(value);
}

function hasExactOptionalKeys(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value);
  return (
    requiredKeys.every((key) => actualKeys.includes(key)) &&
    actualKeys.every(
      (key) => requiredKeys.includes(key) || optionalKeys.includes(key),
    )
  );
}

function resolveEventTelegramAnnouncements(input: {
  announceOnTelegram?: unknown;
  telegramAnnouncements?: unknown;
}): EventTelegramAnnouncements {
  const preferences = input.telegramAnnouncements;
  if (
    preferences &&
    typeof preferences === "object" &&
    !Array.isArray(preferences)
  ) {
    return {
      invite: (preferences as Record<string, unknown>).invite === true,
      matches: (preferences as Record<string, unknown>).matches === true,
      results: (preferences as Record<string, unknown>).results === true,
    };
  }
  const enabled = input.announceOnTelegram === true;
  return { invite: enabled, matches: enabled, results: enabled };
}

function isEventTelegramAnnouncements(
  value: unknown,
): value is EventTelegramAnnouncements {
  return (
    isExactRecord(value, ["invite", "matches", "results"]) &&
    typeof value.invite === "boolean" &&
    typeof value.matches === "boolean" &&
    typeof value.results === "boolean"
  );
}

function isCreateEventRequest(value: unknown): value is CreateEventRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    (Object.hasOwn(value, "isSundayMons") &&
      typeof record.isSundayMons !== "boolean") ||
    (record.telegramAnnouncements !== undefined &&
      !isEventTelegramAnnouncements(record.telegramAnnouncements))
  ) {
    return false;
  }
  if (
    hasExactOptionalKeys(
      value,
      ["startsInMinutes"],
      ["isSundayMons", "telegramAnnouncements"],
    )
  ) {
    return (
      Number.isSafeInteger(record.startsInMinutes) &&
      (record.startsInMinutes as number) >= MIN_STARTS_IN_MINUTES &&
      (record.startsInMinutes as number) <= MAX_STARTS_IN_MINUTES
    );
  }
  if (
    !hasExactOptionalKeys(
      value,
      ["scheduledDate", "scheduledTime", "scheduledTimezone"],
      ["isSundayMons", "telegramAnnouncements", "localTimezoneIana"],
    )
  ) {
    return false;
  }
  return (
    typeof record.scheduledDate === "string" &&
    typeof record.scheduledTime === "string" &&
    EVENT_SCHEDULE_TIMEZONE_OPTIONS.some(
      (option) => option.value === record.scheduledTimezone,
    ) &&
    (record.localTimezoneIana === undefined ||
      typeof record.localTimezoneIana === "string")
  );
}

function isPostponeEventStartRequest(
  value: unknown,
): value is PostponeEventStartRequest {
  return (
    isExactRecord(value, ["eventId", "postponeByMinutes"]) &&
    isSafeRecordKey(value.eventId) &&
    (EVENT_POSTPONE_OPTIONS_MINUTES as readonly unknown[]).includes(
      value.postponeByMinutes,
    )
  );
}

function isDisqualifyEventMatchWinnersRequest(
  value: unknown,
): value is DisqualifyEventMatchWinnersRequest {
  return (
    isExactRecord(value, ["eventId", "matchKey"]) &&
    isSafeRecordKey(value.eventId) &&
    (value.matchKey === THIRD_PLACE_MATCH_KEY ||
      parseEventMatchKey(value.matchKey) !== null)
  );
}

function isSyncEventStateRequest(
  value: unknown,
): value is SyncEventStateRequest {
  return isExactRecord(value, ["eventId"]) && isSafeRecordKey(value.eventId);
}

function isEventApiRecord(
  value: unknown,
  eventId: string,
): value is EventApiRecord {
  return (value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).eventId === eventId &&
    typeof (value as Record<string, unknown>).status === "string" &&
    (!Object.hasOwn(value, "isSundayMons") ||
      typeof (value as Record<string, unknown>).isSundayMons ===
        "boolean")) as boolean;
}

function isCreateEventResponse(value: unknown): value is CreateEventResponse {
  return (
    isExactRecord(value, ["ok", "eventId", "event"]) &&
    value.ok === true &&
    isSafeRecordKey(value.eventId) &&
    isEventApiRecord(value.event, value.eventId)
  );
}

function isEventSnapshotResponse(
  value: unknown,
): value is EventSnapshotResponse {
  if (
    !isExactRecord(value, [
      "ok",
      "eventId",
      "revision",
      "event",
      "prizeSelections",
    ]) ||
    value.ok !== true ||
    !isExactSafeRecordKey(value.eventId) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !value.prizeSelections ||
    typeof value.prizeSelections !== "object" ||
    Array.isArray(value.prizeSelections)
  ) {
    return false;
  }
  const prizeSelections = Object.entries(value.prizeSelections);
  if (value.event === null) {
    return value.revision === 0 && prizeSelections.length === 0;
  }
  return (
    (value.revision as number) > 0 &&
    isEventApiRecord(value.event, value.eventId) &&
    prizeSelections.every(
      ([profileId, prizeId]) =>
        isExactSafeRecordKey(profileId) && isExactSafeRecordKey(prizeId),
    )
  );
}

function isEventSnapshotSeed(value: unknown): value is EventSnapshotSeed {
  return (
    isExactRecord(value, ["snapshot", "etag", "bookmark"]) &&
    isEventSnapshotResponse(value.snapshot) &&
    value.etag ===
      eventSnapshotEtag(value.snapshot.eventId, value.snapshot.revision) &&
    eventBookmarkEpoch(value.bookmark) !== null
  );
}

function isPostponeEventStartResponse(
  value: unknown,
): value is PostponeEventStartResponse {
  return (
    isExactRecord(value, [
      "ok",
      "eventId",
      "event",
      "postponeByMinutes",
      "startAtMs",
    ]) &&
    value.ok === true &&
    isSafeRecordKey(value.eventId) &&
    isEventApiRecord(value.event, value.eventId) &&
    (EVENT_POSTPONE_OPTIONS_MINUTES as readonly unknown[]).includes(
      value.postponeByMinutes,
    ) &&
    Number.isSafeInteger(value.startAtMs) &&
    (value.startAtMs as number) >= 0
  );
}

const EVENT_SYNC_SKIP_REASONS = Object.freeze([
  "locked",
  "not-participant",
  "rate-limited",
]);

function isSyncEventStateResponse(
  value: unknown,
): value is SyncEventStateResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || !isSafeRecordKey(record.eventId)) {
    return false;
  }
  if (record.skipped === true) {
    return (
      hasExactOptionalKeys(
        value,
        ["ok", "eventId", "skipped", "reason"],
        ["event"],
      ) &&
      (EVENT_SYNC_SKIP_REASONS as readonly unknown[]).includes(record.reason) &&
      (record.event === undefined ||
        isEventApiRecord(record.event, record.eventId))
    );
  }
  return (
    isExactRecord(value, ["ok", "eventId", "didChange", "event"]) &&
    typeof record.didChange === "boolean" &&
    isEventApiRecord(record.event, record.eventId)
  );
}

function isDisqualifyEventMatchWinnersResponse(
  value: unknown,
): value is DisqualifyEventMatchWinnersResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.didDisqualify !== "boolean" ||
    (record.matchKey !== THIRD_PLACE_MATCH_KEY &&
      parseEventMatchKey(record.matchKey) === null)
  ) {
    return false;
  }
  const syncValue = { ...record };
  delete syncValue.didDisqualify;
  delete syncValue.matchKey;
  return isSyncEventStateResponse(syncValue);
}

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
  buildEventParticipantSnapshot,
  buildEventSeedOrder,
  getEventBracketSize,
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
