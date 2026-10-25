// Generated from src/events/documents.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createEventMatchesDocument =
  exports.createEventRoundsDocument =
  exports.createEventParticipantsDocument =
  exports.createEventRoundDocument =
  exports.createEventMatchDocument =
  exports.createEventParticipantDocument =
  exports.createEventDocument =
  exports.eventParticipantJoinedOrder =
  exports.eventCurrentRoundIndex =
    void 0;
exports.readEventDocument = readEventDocument;
exports.readPlainEventDocument = readPlainEventDocument;
exports.readEventParticipantDocument = readEventParticipantDocument;
exports.readPlainEventParticipantDocument = readPlainEventParticipantDocument;
exports.readEventMatchDocument = readEventMatchDocument;
exports.readEventRoundDocument = readEventRoundDocument;
exports.readEventParticipantsDocument = readEventParticipantsDocument;
exports.readEventRoundsDocument = readEventRoundsDocument;
exports.readEventMatchesDocument = readEventMatchesDocument;
exports.eventState = eventState;
exports.eventParticipantState = eventParticipantState;
exports.eventParticipantProjectionState = eventParticipantProjectionState;
exports.eventMatchState = eventMatchState;
exports.eventRoundState = eventRoundState;
exports.eventParticipants = eventParticipants;
exports.plainEventParticipants = plainEventParticipants;
exports.eventRounds = eventRounds;
exports.eventThirdPlaceMatch = eventThirdPlaceMatch;
exports.eventRoundAt = eventRoundAt;
exports.eventRoundMatches = eventRoundMatches;
exports.eventMatchAt = eventMatchAt;
exports.eventMatchEntryKind = eventMatchEntryKind;
exports.eventPlacementMatches = eventPlacementMatches;
exports.eventParticipantAt = eventParticipantAt;
exports.plainEventParticipantAt = plainEventParticipantAt;
exports.eventParticipantIsAbsent = eventParticipantIsAbsent;
exports.eventParticipantEntries = eventParticipantEntries;
exports.plainEventParticipantEntries = plainEventParticipantEntries;
exports.eventMatchEntries = eventMatchEntries;
exports.eventPrizeOwnerProfileIds = eventPrizeOwnerProfileIds;
exports.eventPrizeAssignments = eventPrizeAssignments;
exports.patchEventDocument = patchEventDocument;
exports.patchEventMatch = patchEventMatch;
exports.patchEventRound = patchEventRound;
exports.copyEventParticipant = copyEventParticipant;
exports.copyEventDocument = copyEventDocument;
exports.copyEventParticipants = copyEventParticipants;
exports.withEventParticipant = withEventParticipant;
exports.setEventRound = setEventRound;
exports.setEventMatch = setEventMatch;
exports.cloneEventDocument = cloneEventDocument;
exports.cloneEventRounds = cloneEventRounds;
exports.cloneEventParticipants = cloneEventParticipants;
exports.cloneEventMatch = cloneEventMatch;
exports.setEventMatchSlotBlocked = setEventMatchSlotBlocked;
exports.copyEventParticipantToMatchSlot = copyEventParticipantToMatchSlot;
exports.copyEventWinnerDisplayName = copyEventWinnerDisplayName;
exports.createEventMatchInvite = createEventMatchInvite;
const invite_records_js_1 = require("../shared/invite-records.js");
const eventPrizeAwards_js_1 = require("../eventPrizeAwards.js");
const object = (value) => value !== null && typeof value === "object";
const record = (value) => object(value) && !Array.isArray(value);
const source = (value) => value;
const string = (value) => (typeof value === "string" ? value : undefined);
const number = (value) => (typeof value === "number" ? value : undefined);
const nullableString = (value) => (value === null ? null : string(value));
const trimmed = (value) => string(value)?.trim() || "";
const integer = (value, fallback) => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
};
function readEventDocument(value) {
  return object(value) ? value : null;
}
function readPlainEventDocument(value) {
  return record(value) ? value : null;
}
function readEventParticipantDocument(value) {
  return object(value) ? value : null;
}
function readPlainEventParticipantDocument(value) {
  return record(value) ? value : null;
}
function readEventMatchDocument(value) {
  return object(value) ? value : null;
}
function readEventRoundDocument(value) {
  return object(value) ? value : null;
}
function readEventParticipantsDocument(value) {
  return object(value) ? value : null;
}
function readEventRoundsDocument(value) {
  return object(value) ? value : null;
}
function readEventMatchesDocument(value) {
  return object(value) ? value : null;
}
function eventState(event) {
  const value = event ? source(event) : {};
  return {
    eventId: string(value.eventId),
    status: string(value.status),
    createdAtMs: number(value.createdAtMs),
    updatedAtMs: number(value.updatedAtMs),
    startAtMs: number(value.startAtMs),
    startedAtMs: number(value.startedAtMs),
    endedAtMs: number(value.endedAtMs),
    currentRoundIndex: number(value.currentRoundIndex),
    bracketSize: number(value.bracketSize),
    roundCount: number(value.roundCount),
    createdByLoginUid: string(value.createdByLoginUid),
    createdByProfileId: string(value.createdByProfileId),
    winnerProfileId: nullableString(value.winnerProfileId),
    winnerDisplayName: nullableString(value.winnerDisplayName),
    prizeSelectionsLockedAtMs: number(value.prizeSelectionsLockedAtMs),
    hasPrizeSelectionLock:
      value.prizeSelectionsLockedAtMs !== undefined &&
      value.prizeSelectionsLockedAtMs !== null,
    supportsThirdPlaceMatch: value.supportsThirdPlaceMatch === true,
  };
}
function eventParticipantState(participant) {
  const value = participant ? source(participant) : {};
  return {
    profileId: string(value.profileId),
    loginUid: string(value.loginUid),
    username: string(value.username),
    displayName: string(value.displayName),
    emojiId: number(value.emojiId),
    aura: nullableString(value.aura),
    joinedAtMs: number(value.joinedAtMs),
    state: string(value.state),
    eliminatedRoundIndex: number(value.eliminatedRoundIndex),
    eliminatedByProfileId: nullableString(value.eliminatedByProfileId),
  };
}
function eventParticipantProjectionState(participant) {
  const value = source(participant);
  return {
    ...eventParticipantState(participant),
    emojiId:
      typeof value.emojiId === "number" || typeof value.emojiId === "string"
        ? value.emojiId
        : undefined,
  };
}
function eventMatchState(match) {
  const value = match ? source(match) : {};
  return {
    matchKey: string(value.matchKey),
    inviteId: nullableString(value.inviteId),
    status: string(value.status),
    resolvedAtMs: number(value.resolvedAtMs),
    winnerDisqualified: value.winnerDisqualified === true,
    winnerProfileId: nullableString(value.winnerProfileId),
    loserProfileId: nullableString(value.loserProfileId),
    hostSlotBlocked: value.hostSlotBlocked === true,
    hostProfileId: nullableString(value.hostProfileId),
    hostLoginUid: nullableString(value.hostLoginUid),
    hostDisplayName: nullableString(value.hostDisplayName),
    hostEmojiId: number(value.hostEmojiId),
    hostAura: nullableString(value.hostAura),
    guestSlotBlocked: value.guestSlotBlocked === true,
    guestProfileId: nullableString(value.guestProfileId),
    guestLoginUid: nullableString(value.guestLoginUid),
    guestDisplayName: nullableString(value.guestDisplayName),
    guestEmojiId: number(value.guestEmojiId),
    guestAura: nullableString(value.guestAura),
  };
}
function eventRoundState(round) {
  const value = source(round);
  return {
    roundIndex: number(value.roundIndex),
    status: string(value.status),
    createdAtMs: number(value.createdAtMs),
    completedAtMs: number(value.completedAtMs),
    completedAtIsNull: value.completedAtMs === null,
  };
}
const eventCurrentRoundIndex = (event, fallback) =>
  integer(source(event).currentRoundIndex, fallback);
exports.eventCurrentRoundIndex = eventCurrentRoundIndex;
const eventParticipantJoinedOrder = (participant, fallback = 0) =>
  integer(source(participant).joinedAtMs, fallback);
exports.eventParticipantJoinedOrder = eventParticipantJoinedOrder;
function eventParticipants(event) {
  return readEventParticipantsDocument(event && source(event).participants);
}
function plainEventParticipants(event) {
  const value = source(event).participants;
  return record(value) ? readEventParticipantsDocument(value) : null;
}
function eventRounds(event) {
  return readEventRoundsDocument(event && source(event).rounds);
}
function eventThirdPlaceMatch(event) {
  return readEventMatchDocument(event && source(event).thirdPlaceMatch);
}
function eventRoundAt(rounds, key) {
  return readEventRoundDocument(rounds && source(rounds)[key]);
}
function eventRoundMatches(round) {
  return readEventMatchesDocument(round && source(round).matches);
}
function eventMatchAt(matches, key) {
  return readEventMatchDocument(matches && source(matches)[key]);
}
function eventMatchEntryKind(matches, key) {
  const value = matches && source(matches)[key];
  return !value ? "missing" : object(value) ? "match" : "invalid";
}
function eventPlacementMatches(round) {
  const matches = round ? source(round).matches : null;
  const indexed = Object(matches || {});
  return Object.fromEntries(
    Object.keys(indexed).map((key) => [
      key,
      {
        present: Boolean(indexed[key]),
        match: readEventMatchDocument(indexed[key]),
      },
    ]),
  );
}
function eventParticipantAt(participants, key) {
  return readEventParticipantDocument(
    participants && source(participants)[key],
  );
}
function plainEventParticipantAt(participants, key) {
  return readPlainEventParticipantDocument(
    participants && source(participants)[key],
  );
}
function eventParticipantIsAbsent(participants, profileId) {
  return (participants ? source(participants)[profileId] : null) == null;
}
function eventParticipantEntries(participants) {
  return Object.entries(participants ? source(participants) : {}).flatMap(
    ([key, value]) => {
      const participant = readEventParticipantDocument(value);
      return participant ? [[key, participant]] : [];
    },
  );
}
function plainEventParticipantEntries(participants) {
  return eventParticipantEntries(participants).filter(([, value]) =>
    record(value),
  );
}
function eventMatchEntries(matches) {
  return Object.entries(matches ? source(matches) : {}).map(([key, value]) => [
    key,
    readEventMatchDocument(value),
  ]);
}
function eventPrizeOwnerProfileIds(event) {
  const value = source(event).prizeAssignments;
  return object(value)
    ? Object.values(value).map((assignment) =>
        trimmed(object(assignment) ? assignment.profileId : null),
      )
    : [];
}
function eventPrizeAssignments(event, eventId) {
  return (0, eventPrizeAwards_js_1.normalizeEventPrizeAssignments)(
    event && source(event).prizeAssignments,
    eventId,
  );
}
const createEventDocument = (value) => readEventDocument(value);
exports.createEventDocument = createEventDocument;
const createEventParticipantDocument = (value) =>
  readEventParticipantDocument(value);
exports.createEventParticipantDocument = createEventParticipantDocument;
const createEventMatchDocument = (value) => readEventMatchDocument(value);
exports.createEventMatchDocument = createEventMatchDocument;
const createEventRoundDocument = (value) => readEventRoundDocument(value);
exports.createEventRoundDocument = createEventRoundDocument;
const createEventParticipantsDocument = (value = {}) =>
  readEventParticipantsDocument(value);
exports.createEventParticipantsDocument = createEventParticipantsDocument;
const createEventRoundsDocument = (value = {}) =>
  readEventRoundsDocument(value);
exports.createEventRoundsDocument = createEventRoundsDocument;
const createEventMatchesDocument = (value = {}) =>
  readEventMatchesDocument(value);
exports.createEventMatchesDocument = createEventMatchesDocument;
function patchEventDocument(event, patch) {
  Object.assign(source(event), patch);
}
function patchEventMatch(match, patch) {
  Object.assign(source(match), patch);
}
function patchEventRound(round, patch) {
  Object.assign(source(round), patch);
}
function copyEventParticipant(participant, patch) {
  return readEventParticipantDocument({ ...source(participant), ...patch });
}
function copyEventDocument(event, patch) {
  return readEventDocument({ ...source(event), ...patch });
}
function copyEventParticipants(participants, replacements) {
  return readEventParticipantsDocument(
    Object.fromEntries(
      Object.entries(source(participants)).map(([key, value]) => [
        key,
        replacements.get(key) ?? value,
      ]),
    ),
  );
}
function withEventParticipant(participants, profileId, participant) {
  return readEventParticipantsDocument({
    ...(participants ? source(participants) : {}),
    [profileId]: participant,
  });
}
function setEventRound(rounds, key, round) {
  source(rounds)[key] = round;
}
function setEventMatch(matches, key, match) {
  source(matches)[key] = match;
}
function cloneEventDocument(event, mode = "json") {
  const value =
    mode === "structured"
      ? structuredClone(event)
      : JSON.parse(JSON.stringify(event));
  return readEventDocument(value);
}
function cloneEventRounds(rounds) {
  return readEventRoundsDocument(JSON.parse(JSON.stringify(rounds)));
}
function cloneEventParticipants(participants) {
  return readEventParticipantsDocument(
    JSON.parse(JSON.stringify(participants)),
  );
}
function cloneEventMatch(match) {
  return readEventMatchDocument(JSON.parse(JSON.stringify(match)));
}
function setEventMatchSlotBlocked(match, slot, blocked) {
  const value = source(match);
  const field = slot === "guest" ? "guestSlotBlocked" : "hostSlotBlocked";
  const next = blocked === true;
  if (value[field] === next) return false;
  value[field] = next;
  return true;
}
function copyEventParticipantToMatchSlot(match, slot, participant) {
  const target = source(match);
  const current = participant ? source(participant) : null;
  const values = {
    ProfileId: current ? current.profileId : null,
    LoginUid: current ? current.loginUid : null,
    DisplayName: current ? current.displayName : null,
    EmojiId: current ? current.emojiId : null,
    Aura: current ? current.aura || null : null,
  };
  let didChange = false;
  for (const [suffix, value] of Object.entries(values)) {
    const field = `${slot}${suffix}`;
    if (target[field] !== value) {
      target[field] = value;
      didChange = true;
    }
  }
  if (participant && setEventMatchSlotBlocked(match, slot, false))
    didChange = true;
  return didChange;
}
function copyEventWinnerDisplayName(event, participant) {
  source(event).winnerDisplayName = participant
    ? source(participant).displayName
    : null;
}
function createEventMatchInvite(
  match,
  value,
  matchKey,
  useStoredMatchKey = false,
) {
  return (0, invite_records_js_1.readInviteDocument)({
    version: value.version,
    hostId: value.hostId,
    hostColor: value.hostColor,
    guestId: value.guestId,
    eventId: value.eventId,
    eventRoundIndex: value.eventRoundIndex,
    eventMatchKey: useStoredMatchKey
      ? source(match).matchKey || matchKey
      : matchKey,
    eventOwned: true,
  });
}
