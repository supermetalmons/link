"use strict";

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

module.exports = {
  EVENT_POSTPONE_OPTIONS_MINUTES,
  EVENT_SCHEDULE_TIMEZONE_OPTIONS,
  EVENT_SCHEMA_VERSION,
  MAX_EVENT_PARTICIPANTS,
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
  isEventOwnedInvite,
  isMonsLinkAdmin,
  parseEventMatchKey,
};
