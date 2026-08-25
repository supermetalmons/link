"use strict";

const { isSafeFirebaseKey } = require("./ids");

const MONS_LINK_ADMIN_USERNAMES = Object.freeze([
  "ivan",
  "meinong",
  "obi",
  "bosch",
  "monsol",
  "bosch2",
  "trinket",
]);

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
const THIRD_PLACE_MATCH_KEY = "third_place";
const MIN_STARTS_IN_MINUTES = 1;
const MAX_STARTS_IN_DAYS = 14;
const MAX_STARTS_IN_MINUTES = MAX_STARTS_IN_DAYS * 24 * 60;
const MAX_EVENT_PARTICIPANTS = 32;
const SCHEDULED_TIMEZONE_LOCAL = "local";
const EVENT_SCHEDULE_TIMEZONE_OPTIONS = Object.freeze([
  Object.freeze({ value: SCHEDULED_TIMEZONE_LOCAL, label: "Local" }),
  Object.freeze({ value: "ET", label: "ET" }),
  Object.freeze({ value: "PT", label: "PT" }),
  Object.freeze({ value: "CT", label: "CT" }),
]);
const EVENT_POSTPONE_OPTIONS_MINUTES = Object.freeze([5, 10, 15]);
const MAX_EVENT_PARTICIPANT_TEXT_BYTES = 256;

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
  return isExactRecord(value, ["eventId"]) && isSafeFirebaseKey(value.eventId);
}

function isRemoveEventParticipantRequest(value) {
  return (
    isExactRecord(value, ["eventId", "participantProfileId"]) &&
    isSafeFirebaseKey(value.eventId) &&
    isSafeFirebaseKey(value.participantProfileId)
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
    isSafeFirebaseKey(value.profileId) &&
    isSafeFirebaseKey(value.loginUid) &&
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

function isJoinEventResponse(value) {
  return (
    isExactRecord(value, ["ok", "eventId", "participant"]) &&
    value.ok === true &&
    isSafeFirebaseKey(value.eventId) &&
    isEventParticipantSnapshot(value.participant)
  );
}

function isRemoveEventParticipantResponse(value) {
  return (
    isExactRecord(value, ["ok", "eventId", "removedProfileId"]) &&
    value.ok === true &&
    isSafeFirebaseKey(value.eventId) &&
    isSafeFirebaseKey(value.removedProfileId)
  );
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

function isCreateEventRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (
    hasExactOptionalKeys(value, ["startsInMinutes"], ["announceOnTelegram"])
  ) {
    return (
      Number.isSafeInteger(value.startsInMinutes) &&
      value.startsInMinutes >= MIN_STARTS_IN_MINUTES &&
      value.startsInMinutes <= MAX_STARTS_IN_MINUTES &&
      (value.announceOnTelegram === undefined ||
        typeof value.announceOnTelegram === "boolean")
    );
  }
  if (
    !hasExactOptionalKeys(
      value,
      ["scheduledDate", "scheduledTime", "scheduledTimezone"],
      ["announceOnTelegram", "localTimezoneIana"],
    )
  ) {
    return false;
  }
  return (
    typeof value.scheduledDate === "string" &&
    typeof value.scheduledTime === "string" &&
    EVENT_SCHEDULE_TIMEZONE_OPTIONS.some(
      (option) => option.value === value.scheduledTimezone,
    ) &&
    (value.localTimezoneIana === undefined ||
      typeof value.localTimezoneIana === "string") &&
    (value.announceOnTelegram === undefined ||
      typeof value.announceOnTelegram === "boolean")
  );
}

function isPostponeEventStartRequest(value) {
  return (
    isExactRecord(value, ["eventId", "postponeByMinutes"]) &&
    isSafeFirebaseKey(value.eventId) &&
    EVENT_POSTPONE_OPTIONS_MINUTES.includes(value.postponeByMinutes)
  );
}

function isDisqualifyEventMatchWinnersRequest(value) {
  return (
    isExactRecord(value, ["eventId", "matchKey"]) &&
    isSafeFirebaseKey(value.eventId) &&
    (value.matchKey === THIRD_PLACE_MATCH_KEY ||
      parseEventMatchKey(value.matchKey) !== null)
  );
}

function isSyncEventStateRequest(value) {
  return isExactRecord(value, ["eventId"]) && isSafeFirebaseKey(value.eventId);
}

function isEventApiRecord(value, eventId) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.eventId === eventId &&
    typeof value.status === "string"
  );
}

function isCreateEventResponse(value) {
  return (
    isExactRecord(value, ["ok", "eventId", "event"]) &&
    value.ok === true &&
    isSafeFirebaseKey(value.eventId) &&
    isEventApiRecord(value.event, value.eventId)
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
    isSafeFirebaseKey(value.eventId) &&
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
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.ok !== true ||
    !isSafeFirebaseKey(value.eventId)
  ) {
    return false;
  }
  if (value.skipped === true) {
    return (
      hasExactOptionalKeys(
        value,
        ["ok", "eventId", "skipped", "reason"],
        ["event"],
      ) &&
      EVENT_SYNC_SKIP_REASONS.includes(value.reason) &&
      (value.event === undefined ||
        isEventApiRecord(value.event, value.eventId))
    );
  }
  return (
    isExactRecord(value, ["ok", "eventId", "didChange", "event"]) &&
    typeof value.didChange === "boolean" &&
    isEventApiRecord(value.event, value.eventId)
  );
}

function isDisqualifyEventMatchWinnersResponse(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.didDisqualify !== "boolean" ||
    (value.matchKey !== THIRD_PLACE_MATCH_KEY &&
      parseEventMatchKey(value.matchKey) === null)
  ) {
    return false;
  }
  const syncValue = { ...value };
  delete syncValue.didDisqualify;
  delete syncValue.matchKey;
  return isSyncEventStateResponse(syncValue);
}

module.exports = {
  EVENT_POSTPONE_OPTIONS_MINUTES,
  EVENT_SCHEDULE_TIMEZONE_OPTIONS,
  EVENT_SCHEMA_VERSION,
  MAX_EVENT_PARTICIPANTS,
  MAX_EVENT_PARTICIPANT_TEXT_BYTES,
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
  isJoinEventRequest,
  isJoinEventResponse,
  isMonsLinkAdmin,
  isRemoveEventParticipantRequest,
  isRemoveEventParticipantResponse,
  isPostponeEventStartRequest,
  isPostponeEventStartResponse,
  isSyncEventStateRequest,
  isSyncEventStateResponse,
  parseEventMatchKey,
};
