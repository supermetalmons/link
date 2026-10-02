// Generated from src/shared/events.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.THIRD_PLACE_MATCH_KEY =
  exports.SCHEDULED_TIMEZONE_LOCAL =
  exports.MONS_LINK_ADMIN_USERNAMES =
  exports.MIN_STARTS_IN_MINUTES =
  exports.MAX_STARTS_IN_MINUTES =
  exports.MAX_STARTS_IN_DAYS =
  exports.MAX_EVENT_BOOKMARK_LENGTH =
  exports.MAX_EVENT_READ_RESPONSE_BYTES =
  exports.MAX_EVENT_PARTICIPANT_TEXT_BYTES =
  exports.MAX_EVENT_PARTICIPANTS =
  exports.EVENT_SCHEMA_VERSION =
  exports.EVENT_SCHEDULE_TIMEZONE_OPTIONS =
  exports.EVENT_ETAG_HEADER =
  exports.EVENT_BOOKMARK_HEADER =
  exports.EVENT_POSTPONE_OPTIONS_MINUTES =
    void 0;
exports.eventSnapshotEtag = eventSnapshotEtag;
exports.eventBookmarkEpoch = eventBookmarkEpoch;
exports.isEventSnapshotSeed = isEventSnapshotSeed;
exports.buildEventMatchKey = buildEventMatchKey;
exports.buildEventParticipantSnapshot = buildEventParticipantSnapshot;
exports.buildEventSeedOrder = buildEventSeedOrder;
exports.getEventBracketSize = getEventBracketSize;
exports.getFirstRoundByeSeeds = getFirstRoundByeSeeds;
exports.isCreateEventRequest = isCreateEventRequest;
exports.isCreateEventResponse = isCreateEventResponse;
exports.isDisqualifyEventMatchWinnersRequest =
  isDisqualifyEventMatchWinnersRequest;
exports.isDisqualifyEventMatchWinnersResponse =
  isDisqualifyEventMatchWinnersResponse;
exports.isEventOwnedInvite = isEventOwnedInvite;
exports.isEventParticipantSnapshot = isEventParticipantSnapshot;
exports.isEventSnapshotResponse = isEventSnapshotResponse;
exports.isJoinEventRequest = isJoinEventRequest;
exports.isJoinEventResponse = isJoinEventResponse;
exports.isLeaveEventRequest = isLeaveEventRequest;
exports.isLeaveEventResponse = isLeaveEventResponse;
exports.isMonsLinkAdmin = isMonsLinkAdmin;
exports.isRemoveEventParticipantRequest = isRemoveEventParticipantRequest;
exports.isRemoveEventParticipantResponse = isRemoveEventParticipantResponse;
exports.isPostponeEventStartRequest = isPostponeEventStartRequest;
exports.isPostponeEventStartResponse = isPostponeEventStartResponse;
exports.isSyncEventStateRequest = isSyncEventStateRequest;
exports.isSyncEventStateResponse = isSyncEventStateResponse;
exports.parseEventMatchKey = parseEventMatchKey;
exports.resolveEventTelegramAnnouncements = resolveEventTelegramAnnouncements;
const ids_js_1 = require("./ids.js");
const profiles_js_1 = require("./profiles.js");
const MONS_LINK_ADMIN_USERNAMES = Object.freeze([
  "ivan",
  "meinong",
  "obi",
  "bosch",
  "monsol",
  "bosch2",
  "trinket",
]);
exports.MONS_LINK_ADMIN_USERNAMES = MONS_LINK_ADMIN_USERNAMES;
function isMonsLinkAdmin(value) {
  return MONS_LINK_ADMIN_USERNAMES.includes(value);
}
function isEventOwnedInvite(value) {
  return (
    !!value &&
    typeof value === "object" &&
    (value.eventOwned === true ||
      (typeof value.eventId === "string" && value.eventId.trim() !== ""))
  );
}
const EVENT_SCHEMA_VERSION = 2;
exports.EVENT_SCHEMA_VERSION = EVENT_SCHEMA_VERSION;
const THIRD_PLACE_MATCH_KEY = "third_place";
exports.THIRD_PLACE_MATCH_KEY = THIRD_PLACE_MATCH_KEY;
const MIN_STARTS_IN_MINUTES = 1;
exports.MIN_STARTS_IN_MINUTES = MIN_STARTS_IN_MINUTES;
const MAX_STARTS_IN_DAYS = 14;
exports.MAX_STARTS_IN_DAYS = MAX_STARTS_IN_DAYS;
const MAX_STARTS_IN_MINUTES = MAX_STARTS_IN_DAYS * 24 * 60;
exports.MAX_STARTS_IN_MINUTES = MAX_STARTS_IN_MINUTES;
const MAX_EVENT_PARTICIPANTS = 32;
exports.MAX_EVENT_PARTICIPANTS = MAX_EVENT_PARTICIPANTS;
const SCHEDULED_TIMEZONE_LOCAL = "local";
exports.SCHEDULED_TIMEZONE_LOCAL = SCHEDULED_TIMEZONE_LOCAL;
const EVENT_SCHEDULE_TIMEZONE_OPTIONS = Object.freeze([
  Object.freeze({ value: SCHEDULED_TIMEZONE_LOCAL, label: "Local" }),
  Object.freeze({ value: "ET", label: "ET" }),
  Object.freeze({ value: "PT", label: "PT" }),
  Object.freeze({ value: "CT", label: "CT" }),
]);
exports.EVENT_SCHEDULE_TIMEZONE_OPTIONS = EVENT_SCHEDULE_TIMEZONE_OPTIONS;
const EVENT_POSTPONE_OPTIONS_MINUTES = Object.freeze([5, 10, 15]);
exports.EVENT_POSTPONE_OPTIONS_MINUTES = EVENT_POSTPONE_OPTIONS_MINUTES;
const MAX_EVENT_PARTICIPANT_TEXT_BYTES = 256;
exports.MAX_EVENT_PARTICIPANT_TEXT_BYTES = MAX_EVENT_PARTICIPANT_TEXT_BYTES;
const EVENT_BOOKMARK_HEADER = "X-D1-Bookmark";
exports.EVENT_BOOKMARK_HEADER = EVENT_BOOKMARK_HEADER;
const EVENT_ETAG_HEADER = "ETag";
exports.EVENT_ETAG_HEADER = EVENT_ETAG_HEADER;
const MAX_EVENT_READ_RESPONSE_BYTES = 640 * 1024;
exports.MAX_EVENT_READ_RESPONSE_BYTES = MAX_EVENT_READ_RESPONSE_BYTES;
const MAX_EVENT_BOOKMARK_LENGTH = 2048;
exports.MAX_EVENT_BOOKMARK_LENGTH = MAX_EVENT_BOOKMARK_LENGTH;
function eventSnapshotEtag(eventId, revision) {
  return `W/"event-snapshot-${encodeURIComponent(eventId)}-${revision}"`;
}
function eventBookmarkEpoch(value) {
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
const isExactSafeRecordKey = (value) =>
  typeof value === "string" &&
  value.trim() === value &&
  (0, ids_js_1.isSafeRecordKey)(value);
function buildEventMatchKey(roundIndex, matchIndex) {
  return `${roundIndex}_${matchIndex}`;
}
function parseEventMatchKey(matchKey) {
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
function getEventBracketSize(participantCount) {
  let bracketSize = 2;
  while (
    bracketSize < participantCount &&
    bracketSize < MAX_EVENT_PARTICIPANTS
  ) {
    bracketSize *= 2;
  }
  return bracketSize;
}
function buildEventSeedOrder(bracketSize) {
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
function getFirstRoundByeSeeds(participantCount, bracketSize, seedOrder) {
  if (participantCount <= 0 || participantCount >= bracketSize) {
    return [];
  }
  const byeSeeds = [];
  const firstRoundMatchCount = bracketSize / 2;
  for (let matchIndex = 0; matchIndex < firstRoundMatchCount; matchIndex += 1) {
    const hostSeed = seedOrder[matchIndex * 2];
    const guestSeed = seedOrder[matchIndex * 2 + 1];
    const hostHasParticipant = hostSeed <= participantCount;
    const guestHasParticipant = guestSeed <= participantCount;
    if (hostHasParticipant === guestHasParticipant) {
      continue;
    }
    byeSeeds.push(hostHasParticipant ? hostSeed : guestSeed);
  }
  return byeSeeds;
}
function isExactRecord(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === keys.length &&
    actualKeys.every((key) => keys.includes(key))
  );
}
function isJoinEventRequest(value) {
  return (
    isExactRecord(value, ["eventId"]) &&
    (0, ids_js_1.isSafeRecordKey)(value.eventId)
  );
}
function isLeaveEventRequest(value) {
  return isJoinEventRequest(value);
}
function isRemoveEventParticipantRequest(value) {
  return (
    isExactRecord(value, ["eventId", "participantProfileId"]) &&
    (0, ids_js_1.isSafeRecordKey)(value.eventId) &&
    (0, ids_js_1.isSafeRecordKey)(value.participantProfileId)
  );
}
function isBoundedParticipantText(value) {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).byteLength <=
      MAX_EVENT_PARTICIPANT_TEXT_BYTES
  );
}
function isEventParticipantSnapshot(value) {
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
    (0, ids_js_1.isSafeRecordKey)(value.profileId) &&
    (0, ids_js_1.isSafeRecordKey)(value.loginUid) &&
    isBoundedParticipantText(value.username) &&
    isBoundedParticipantText(value.displayName) &&
    Number.isSafeInteger(value.emojiId) &&
    value.emojiId >= 0 &&
    isBoundedParticipantText(value.aura) &&
    Number.isSafeInteger(value.joinedAtMs) &&
    value.joinedAtMs >= 0 &&
    value.state === "active" &&
    value.eliminatedRoundIndex === null &&
    value.eliminatedByProfileId === null
  );
}
function buildEventParticipantSnapshot(profile, loginUid, joinedAtMs) {
  const parsedEmojiId = Math.floor(Number(profile.emoji));
  const participant = {
    profileId: profile.profileId,
    loginUid,
    username: profile.username.trim(),
    displayName:
      profile.username ||
      (profile.eth
        ? (0, profiles_js_1.cropAddress)(profile.eth)
        : profile.sol
          ? (0, profiles_js_1.cropAddress)(profile.sol)
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
function isJoinEventResponse(value) {
  return (
    isExactRecord(value, ["ok", "eventId", "participant"]) &&
    value.ok === true &&
    (0, ids_js_1.isSafeRecordKey)(value.eventId) &&
    isEventParticipantSnapshot(value.participant)
  );
}
function isRemoveEventParticipantResponse(value) {
  return (
    isExactRecord(value, ["ok", "eventId", "removedProfileId"]) &&
    value.ok === true &&
    (0, ids_js_1.isSafeRecordKey)(value.eventId) &&
    (0, ids_js_1.isSafeRecordKey)(value.removedProfileId)
  );
}
function isLeaveEventResponse(value) {
  return isRemoveEventParticipantResponse(value);
}
function hasExactOptionalKeys(value, requiredKeys, optionalKeys) {
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
function resolveEventTelegramAnnouncements(input) {
  const preferences = input.telegramAnnouncements;
  if (
    preferences &&
    typeof preferences === "object" &&
    !Array.isArray(preferences)
  ) {
    return {
      invite: preferences.invite === true,
      matches: preferences.matches === true,
      results: preferences.results === true,
    };
  }
  const enabled = input.announceOnTelegram === true;
  return { invite: enabled, matches: enabled, results: enabled };
}
function isEventTelegramAnnouncements(value) {
  return (
    isExactRecord(value, ["invite", "matches", "results"]) &&
    typeof value.invite === "boolean" &&
    typeof value.matches === "boolean" &&
    typeof value.results === "boolean"
  );
}
function isCreateEventRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value;
  if (
    (Object.hasOwn(value, "isSundayMons") &&
      typeof record.isSundayMons !== "boolean") ||
    (record.announceOnTelegram !== undefined &&
      typeof record.announceOnTelegram !== "boolean") ||
    (record.telegramAnnouncements !== undefined &&
      !isEventTelegramAnnouncements(record.telegramAnnouncements))
  ) {
    return false;
  }
  if (
    hasExactOptionalKeys(
      value,
      ["startsInMinutes"],
      ["isSundayMons", "announceOnTelegram", "telegramAnnouncements"],
    )
  ) {
    return (
      Number.isSafeInteger(record.startsInMinutes) &&
      record.startsInMinutes >= MIN_STARTS_IN_MINUTES &&
      record.startsInMinutes <= MAX_STARTS_IN_MINUTES
    );
  }
  if (
    !hasExactOptionalKeys(
      value,
      ["scheduledDate", "scheduledTime", "scheduledTimezone"],
      [
        "isSundayMons",
        "announceOnTelegram",
        "telegramAnnouncements",
        "localTimezoneIana",
      ],
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
function isPostponeEventStartRequest(value) {
  return (
    isExactRecord(value, ["eventId", "postponeByMinutes"]) &&
    (0, ids_js_1.isSafeRecordKey)(value.eventId) &&
    EVENT_POSTPONE_OPTIONS_MINUTES.includes(value.postponeByMinutes)
  );
}
function isDisqualifyEventMatchWinnersRequest(value) {
  return (
    isExactRecord(value, ["eventId", "matchKey"]) &&
    (0, ids_js_1.isSafeRecordKey)(value.eventId) &&
    (value.matchKey === THIRD_PLACE_MATCH_KEY ||
      parseEventMatchKey(value.matchKey) !== null)
  );
}
function isSyncEventStateRequest(value) {
  return (
    isExactRecord(value, ["eventId"]) &&
    (0, ids_js_1.isSafeRecordKey)(value.eventId)
  );
}
function isEventApiRecord(value, eventId) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.eventId === eventId &&
    typeof value.status === "string" &&
    (!Object.hasOwn(value, "isSundayMons") ||
      typeof value.isSundayMons === "boolean")
  );
}
function isCreateEventResponse(value) {
  return (
    isExactRecord(value, ["ok", "eventId", "event"]) &&
    value.ok === true &&
    (0, ids_js_1.isSafeRecordKey)(value.eventId) &&
    isEventApiRecord(value.event, value.eventId)
  );
}
function isEventSnapshotResponse(value) {
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
    value.revision < 0 ||
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
    value.revision > 0 &&
    isEventApiRecord(value.event, value.eventId) &&
    prizeSelections.every(
      ([profileId, prizeId]) =>
        isExactSafeRecordKey(profileId) && isExactSafeRecordKey(prizeId),
    )
  );
}
function isEventSnapshotSeed(value) {
  return (
    isExactRecord(value, ["snapshot", "etag", "bookmark"]) &&
    isEventSnapshotResponse(value.snapshot) &&
    value.etag ===
      eventSnapshotEtag(value.snapshot.eventId, value.snapshot.revision) &&
    eventBookmarkEpoch(value.bookmark) !== null
  );
}
function isPostponeEventStartResponse(value) {
  return (
    isExactRecord(value, [
      "ok",
      "eventId",
      "event",
      "postponeByMinutes",
      "startAtMs",
    ]) &&
    value.ok === true &&
    (0, ids_js_1.isSafeRecordKey)(value.eventId) &&
    isEventApiRecord(value.event, value.eventId) &&
    EVENT_POSTPONE_OPTIONS_MINUTES.includes(value.postponeByMinutes) &&
    Number.isSafeInteger(value.startAtMs) &&
    value.startAtMs >= 0
  );
}
const EVENT_SYNC_SKIP_REASONS = Object.freeze([
  "locked",
  "not-participant",
  "rate-limited",
]);
function isSyncEventStateResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value;
  if (record.ok !== true || !(0, ids_js_1.isSafeRecordKey)(record.eventId)) {
    return false;
  }
  if (record.skipped === true) {
    return (
      hasExactOptionalKeys(
        value,
        ["ok", "eventId", "skipped", "reason"],
        ["event"],
      ) &&
      EVENT_SYNC_SKIP_REASONS.includes(record.reason) &&
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
function isDisqualifyEventMatchWinnersResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value;
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
