// Generated from src/events/documents.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cloneEventMatch =
  exports.cloneEventParticipants =
  exports.cloneEventRounds =
  exports.eventPrizeOwnerProfileIds =
  exports.eventMatchEntries =
  exports.plainEventParticipantEntries =
  exports.eventParticipantEntries =
  exports.eventParticipantIsAbsent =
  exports.plainEventParticipantAt =
  exports.eventParticipantAt =
  exports.eventMatchEntryKind =
  exports.eventMatchAt =
  exports.eventRoundMatches =
  exports.eventRoundAt =
  exports.eventThirdPlaceMatch =
  exports.eventRounds =
  exports.plainEventParticipants =
  exports.eventParticipantJoinedOrder =
  exports.eventCurrentRoundIndex =
  exports.eventParticipantProjectionState =
  exports.readEventMatchesDocument =
  exports.readEventRoundsDocument =
  exports.readEventParticipantsDocument =
  exports.readEventRoundDocument =
  exports.readEventMatchDocument =
  exports.readPlainEventParticipantDocument =
  exports.readEventParticipantDocument =
  exports.readPlainEventDocument =
  exports.readEventDocument =
    void 0;
exports.eventState = eventState;
exports.eventParticipantState = eventParticipantState;
exports.eventMatchState = eventMatchState;
exports.eventRoundState = eventRoundState;
exports.eventParticipants = eventParticipants;
exports.eventPlacementMatches = eventPlacementMatches;
exports.eventPrizeAssignments = eventPrizeAssignments;
exports.createEventDocument = createEventDocument;
exports.createEventParticipantDocument = createEventParticipantDocument;
exports.createEventMatchDocument = createEventMatchDocument;
exports.createEventRoundDocument = createEventRoundDocument;
exports.createEventParticipantsDocument = createEventParticipantsDocument;
exports.createEventRoundsDocument = createEventRoundsDocument;
exports.createEventMatchesDocument = createEventMatchesDocument;
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
exports.setEventMatchSlotBlocked = setEventMatchSlotBlocked;
exports.copyEventParticipantToMatchSlot = copyEventParticipantToMatchSlot;
exports.copyEventWinnerDisplayName = copyEventWinnerDisplayName;
exports.createEventMatchInvite = createEventMatchInvite;
const invite_records_js_1 = require("../shared/invite-records.js");
const event_views_js_1 = require("../shared/event-views.js");
const readEventDocument = (value) =>
  (0, event_views_js_1.isEventRecord)(value) ? value : null;
exports.readEventDocument = readEventDocument;
exports.readPlainEventDocument = exports.readEventDocument;
const readEventParticipantDocument = (value) =>
  (0, event_views_js_1.isEventParticipantRecord)(value) ? value : null;
exports.readEventParticipantDocument = readEventParticipantDocument;
exports.readPlainEventParticipantDocument =
  exports.readEventParticipantDocument;
const readEventMatchDocument = (value) =>
  (0, event_views_js_1.isEventMatchRecord)(value) ? value : null;
exports.readEventMatchDocument = readEventMatchDocument;
const readEventRoundDocument = (value) =>
  (0, event_views_js_1.isEventRoundRecord)(value) ? value : null;
exports.readEventRoundDocument = readEventRoundDocument;
const readEventParticipantsDocument = (value) =>
  (0, event_views_js_1.isEventParticipants)(value) ? value : null;
exports.readEventParticipantsDocument = readEventParticipantsDocument;
const readEventRoundsDocument = (value) =>
  (0, event_views_js_1.isEventRounds)(value) ? value : null;
exports.readEventRoundsDocument = readEventRoundsDocument;
const readEventMatchesDocument = (value) =>
  (0, event_views_js_1.isEventMatches)(value) ? value : null;
exports.readEventMatchesDocument = readEventMatchesDocument;
function eventState(event) {
  return {
    eventId: event?.eventId,
    status: event?.status,
    createdAtMs: event?.createdAtMs,
    updatedAtMs: event?.updatedAtMs,
    startAtMs: event?.startAtMs,
    startedAtMs: event?.startedAtMs,
    endedAtMs: event?.endedAtMs,
    currentRoundIndex: event?.currentRoundIndex,
    bracketSize: event?.bracketSize,
    roundCount: event?.roundCount,
    createdByLoginUid: event?.createdByLoginUid,
    createdByProfileId: event?.createdByProfileId,
    winnerProfileId: event?.winnerProfileId,
    winnerDisplayName: event?.winnerDisplayName,
    prizeSelectionsLockedAtMs: event?.prizeSelectionsLockedAtMs,
    hasPrizeSelectionLock:
      event != null && event.prizeSelectionsLockedAtMs !== null,
    supportsThirdPlaceMatch: event?.supportsThirdPlaceMatch ?? false,
  };
}
function eventParticipantState(participant) {
  return {
    profileId: participant?.profileId,
    loginUid: participant?.loginUid,
    username: participant?.username,
    displayName: participant?.displayName,
    emojiId: participant?.emojiId,
    aura: participant?.aura,
    joinedAtMs: participant?.joinedAtMs,
    state: participant?.state,
    eliminatedRoundIndex: participant?.eliminatedRoundIndex,
    eliminatedByProfileId: participant?.eliminatedByProfileId,
  };
}
exports.eventParticipantProjectionState = eventParticipantState;
function eventMatchState(match) {
  return {
    matchKey: match?.matchKey,
    inviteId: match?.inviteId,
    status: match?.status,
    resolvedAtMs: match?.resolvedAtMs,
    winnerDisqualified: match?.winnerDisqualified ?? false,
    winnerProfileId: match?.winnerProfileId,
    loserProfileId: match?.loserProfileId,
    hostSlotBlocked: match?.hostSlotBlocked ?? false,
    hostProfileId: match?.hostProfileId,
    hostLoginUid: match?.hostLoginUid,
    hostDisplayName: match?.hostDisplayName,
    hostEmojiId: match?.hostEmojiId,
    hostAura: match?.hostAura,
    guestSlotBlocked: match?.guestSlotBlocked ?? false,
    guestProfileId: match?.guestProfileId,
    guestLoginUid: match?.guestLoginUid,
    guestDisplayName: match?.guestDisplayName,
    guestEmojiId: match?.guestEmojiId,
    guestAura: match?.guestAura,
  };
}
function eventRoundState(round) {
  return {
    roundIndex: round.roundIndex,
    status: round.status,
    createdAtMs: round.createdAtMs,
    completedAtMs: round.completedAtMs,
    completedAtIsNull: round.completedAtMs === null,
  };
}
const eventCurrentRoundIndex = (event, fallback) =>
  event.currentRoundIndex ?? fallback;
exports.eventCurrentRoundIndex = eventCurrentRoundIndex;
const eventParticipantJoinedOrder = (participant) => participant.joinedAtMs;
exports.eventParticipantJoinedOrder = eventParticipantJoinedOrder;
function eventParticipants(event) {
  return event?.participants ?? null;
}
exports.plainEventParticipants = eventParticipants;
const eventRounds = (event) => event?.rounds ?? null;
exports.eventRounds = eventRounds;
const eventThirdPlaceMatch = (event) => event?.thirdPlaceMatch ?? null;
exports.eventThirdPlaceMatch = eventThirdPlaceMatch;
const eventRoundAt = (rounds, key) => rounds?.[key] ?? null;
exports.eventRoundAt = eventRoundAt;
const eventRoundMatches = (round) => round?.matches ?? null;
exports.eventRoundMatches = eventRoundMatches;
const eventMatchAt = (matches, key) => matches?.[key] ?? null;
exports.eventMatchAt = eventMatchAt;
const eventMatchEntryKind = (matches, key) =>
  matches?.[key] === undefined ? "missing" : "match";
exports.eventMatchEntryKind = eventMatchEntryKind;
function eventPlacementMatches(round) {
  return Object.fromEntries(
    Object.entries(round?.matches ?? {}).map(([key, match]) => [
      key,
      { present: true, match },
    ]),
  );
}
const eventParticipantAt = (participants, key) => participants?.[key] ?? null;
exports.eventParticipantAt = eventParticipantAt;
exports.plainEventParticipantAt = exports.eventParticipantAt;
const eventParticipantIsAbsent = (participants, profileId) =>
  participants?.[profileId] === undefined;
exports.eventParticipantIsAbsent = eventParticipantIsAbsent;
const eventParticipantEntries = (participants) =>
  Object.entries(participants ?? {});
exports.eventParticipantEntries = eventParticipantEntries;
exports.plainEventParticipantEntries = exports.eventParticipantEntries;
const eventMatchEntries = (matches) => Object.entries(matches ?? {});
exports.eventMatchEntries = eventMatchEntries;
const eventPrizeOwnerProfileIds = (event) =>
  Object.values(event?.prizeAssignments ?? {}).map(
    (assignment) => assignment.profileId,
  );
exports.eventPrizeOwnerProfileIds = eventPrizeOwnerProfileIds;
function eventPrizeAssignments(event, eventId) {
  if (event && event.eventId !== eventId)
    throw new TypeError("event-identity-mismatch");
  return { ...event?.prizeAssignments };
}
function createEventDocument(value) {
  const event = (0, exports.readEventDocument)(value);
  if (!event) throw new TypeError("invalid-canonical-event");
  return event;
}
function createEventParticipantDocument(value) {
  const participant = (0, exports.readEventParticipantDocument)(value);
  if (!participant) throw new TypeError("invalid-canonical-event-participant");
  return participant;
}
function createEventMatchDocument(value) {
  const match = (0, exports.readEventMatchDocument)(value);
  if (!match) throw new TypeError("invalid-canonical-event-match");
  return match;
}
function createEventRoundDocument(value) {
  const round = (0, exports.readEventRoundDocument)(value);
  if (!round) throw new TypeError("invalid-canonical-event-round");
  return round;
}
function createEventParticipantsDocument(value = {}) {
  if (!(0, event_views_js_1.isEventParticipants)(value))
    throw new TypeError("invalid-canonical-event-participants");
  return value;
}
function createEventRoundsDocument(value = {}) {
  if (!(0, event_views_js_1.isEventRounds)(value))
    throw new TypeError("invalid-canonical-event-rounds");
  return value;
}
function createEventMatchesDocument(value = {}) {
  if (!(0, event_views_js_1.isEventMatches)(value))
    throw new TypeError("invalid-canonical-event-matches");
  return value;
}
function patchEventDocument(event, patch) {
  Object.assign(event, patch);
}
function patchEventMatch(match, patch) {
  Object.assign(match, patch);
}
function patchEventRound(round, patch) {
  Object.assign(round, patch);
}
function copyEventParticipant(participant, patch) {
  return createEventParticipantDocument({ ...participant, ...patch });
}
function copyEventDocument(event, patch) {
  return createEventDocument({ ...event, ...patch });
}
function copyEventParticipants(participants, replacements) {
  return createEventParticipantsDocument(
    Object.fromEntries(
      Object.entries(participants).map(([key, value]) => [
        key,
        replacements.get(key) ?? value,
      ]),
    ),
  );
}
function withEventParticipant(participants, profileId, participant) {
  return createEventParticipantsDocument({
    ...participants,
    [profileId]: participant,
  });
}
function setEventRound(rounds, key, round) {
  if (key !== String(round.roundIndex))
    throw new TypeError("event-round-identity-mismatch");
  rounds[key] = round;
}
function setEventMatch(matches, key, match) {
  if (key !== match.matchKey)
    throw new TypeError("event-match-identity-mismatch");
  matches[key] = match;
}
function cloneEventDocument(event, _mode = "json") {
  return structuredClone(event);
}
const cloneEventRounds = (rounds) => structuredClone(rounds);
exports.cloneEventRounds = cloneEventRounds;
const cloneEventParticipants = (participants) => structuredClone(participants);
exports.cloneEventParticipants = cloneEventParticipants;
const cloneEventMatch = (match) => structuredClone(match);
exports.cloneEventMatch = cloneEventMatch;
function setEventMatchSlotBlocked(match, slot, blocked) {
  const field = slot === "guest" ? "guestSlotBlocked" : "hostSlotBlocked";
  if (match[field] === blocked) return false;
  match[field] = blocked;
  return true;
}
function copyEventParticipantToMatchSlot(match, slot, participant) {
  const profileId = participant?.profileId ?? null;
  const loginUid = participant?.loginUid ?? null;
  const displayName = participant?.displayName ?? null;
  const emojiId = participant?.emojiId ?? null;
  const aura = participant?.aura ?? null;
  let didChange;
  if (slot === "host") {
    didChange =
      match.hostProfileId !== profileId ||
      match.hostLoginUid !== loginUid ||
      match.hostDisplayName !== displayName ||
      match.hostEmojiId !== emojiId ||
      match.hostAura !== aura;
    Object.assign(match, {
      hostProfileId: profileId,
      hostLoginUid: loginUid,
      hostDisplayName: displayName,
      hostEmojiId: emojiId,
      hostAura: aura,
    });
  } else {
    didChange =
      match.guestProfileId !== profileId ||
      match.guestLoginUid !== loginUid ||
      match.guestDisplayName !== displayName ||
      match.guestEmojiId !== emojiId ||
      match.guestAura !== aura;
    Object.assign(match, {
      guestProfileId: profileId,
      guestLoginUid: loginUid,
      guestDisplayName: displayName,
      guestEmojiId: emojiId,
      guestAura: aura,
    });
  }
  if (participant && setEventMatchSlotBlocked(match, slot, false))
    didChange = true;
  return didChange;
}
function copyEventWinnerDisplayName(event, participant) {
  event.winnerDisplayName = participant?.displayName ?? null;
}
function createEventMatchInvite(
  match,
  value,
  matchKey,
  useStoredMatchKey = false,
) {
  const invite = (0, invite_records_js_1.createEventInviteDocument)({
    version: value.version,
    hostId: value.hostId,
    hostColor: value.hostColor,
    guestId: value.guestId,
    eventId: value.eventId,
    eventRoundIndex: value.eventRoundIndex,
    eventMatchKey: useStoredMatchKey ? match.matchKey : matchKey,
    eventOwned: true,
  });
  if (!invite) throw new TypeError("invalid-event-match-invite");
  return invite;
}
