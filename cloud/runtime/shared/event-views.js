// Generated from src/shared/event-views.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isEventAnnouncements = isEventAnnouncements;
exports.isEventParticipantRecord = isEventParticipantRecord;
exports.isEventParticipants = isEventParticipants;
exports.isEventMatchRecord = isEventMatchRecord;
exports.isEventMatches = isEventMatches;
exports.isEventRoundRecord = isEventRoundRecord;
exports.isEventRounds = isEventRounds;
exports.isEventPrizeAssignments = isEventPrizeAssignments;
exports.isEventRecord = isEventRecord;
exports.parseEventRecord = parseEventRecord;
exports.decodeEventParticipantView = decodeEventParticipantView;
exports.decodeEventMatchView = decodeEventMatchView;
exports.decodeEventRoundView = decodeEventRoundView;
exports.normalizeEventPrizeId = normalizeEventPrizeId;
exports.decodeEventPrizeAssignmentView = decodeEventPrizeAssignmentView;
exports.decodeEventPrizeAssignmentsView = decodeEventPrizeAssignmentsView;
exports.decodeEventView = decodeEventView;
const event_prizes_js_1 = require("./event-prizes.js");
const ids_js_1 = require("./ids.js");
const appearance_js_1 = require("./appearance.js");
const event_types_js_1 = require("./event-types.js");
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactRecord = (value, keys) =>
  isRecord(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const key = (value) =>
  typeof value === "string" &&
  value.trim() === value &&
  (0, ids_js_1.isSafeRecordKey)(value);
const integer = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nullableInteger = (value) => value === null || integer(value);
const nullableKey = (value) => value === null || key(value);
const text = (value) =>
  typeof value === "string" &&
  new TextEncoder().encode(value).byteLength <= 256;
const nullableText = (value) => value === null || text(value);
function isEventAnnouncements(value) {
  return (
    exactRecord(value, ["invite", "matches", "results"]) &&
    typeof value.invite === "boolean" &&
    typeof value.matches === "boolean" &&
    typeof value.results === "boolean"
  );
}
function isEventParticipantRecord(value) {
  if (
    !exactRecord(value, [
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
    ]) ||
    !key(value.profileId) ||
    !nullableKey(value.loginUid) ||
    !text(value.username) ||
    !text(value.displayName) ||
    !(0, appearance_js_1.isEmojiId)(value.emojiId) ||
    !(0, appearance_js_1.isAura)(value.aura) ||
    !integer(value.joinedAtMs)
  )
    return false;
  if (value.state === "active" || value.state === "winner") {
    return (
      value.eliminatedRoundIndex === null &&
      value.eliminatedByProfileId === null
    );
  }
  return (
    value.state === "eliminated" &&
    integer(value.eliminatedRoundIndex) &&
    value.eliminatedRoundIndex < 5 &&
    nullableKey(value.eliminatedByProfileId)
  );
}
function isEventParticipants(value) {
  return (
    isRecord(value) &&
    Object.keys(value).length <= 32 &&
    Object.entries(value).every(
      ([profileId, participant]) =>
        key(profileId) &&
        isEventParticipantRecord(participant) &&
        participant.profileId === profileId,
    )
  );
}
function matchSlot(value, slot) {
  const profileId = value[`${slot}ProfileId`];
  const loginUid = value[`${slot}LoginUid`];
  const displayName = value[`${slot}DisplayName`];
  const emojiId = value[`${slot}EmojiId`];
  const aura = value[`${slot}Aura`];
  if (profileId === null) {
    return (
      loginUid === null &&
      displayName === null &&
      emojiId === null &&
      aura === null
    );
  }
  return (
    key(profileId) &&
    key(loginUid) &&
    text(displayName) &&
    (0, appearance_js_1.isEmojiId)(emojiId) &&
    (0, appearance_js_1.isAura)(aura)
  );
}
function isEventMatchRecord(value) {
  if (
    !exactRecord(value, [
      "matchKey",
      "inviteId",
      "status",
      "resolvedAtMs",
      "winnerDisqualified",
      "winnerProfileId",
      "loserProfileId",
      "hostSlotBlocked",
      "hostProfileId",
      "hostLoginUid",
      "hostDisplayName",
      "hostEmojiId",
      "hostAura",
      "guestSlotBlocked",
      "guestProfileId",
      "guestLoginUid",
      "guestDisplayName",
      "guestEmojiId",
      "guestAura",
    ]) ||
    !(
      typeof value.matchKey === "string" &&
      (value.matchKey === event_types_js_1.THIRD_PLACE_MATCH_KEY ||
        /^(0|[1-4])_(0|[1-9]|1[0-5])$/.test(value.matchKey))
    ) ||
    !nullableKey(value.inviteId) ||
    !nullableInteger(value.resolvedAtMs) ||
    typeof value.winnerDisqualified !== "boolean" ||
    !nullableKey(value.winnerProfileId) ||
    !nullableKey(value.loserProfileId) ||
    typeof value.hostSlotBlocked !== "boolean" ||
    typeof value.guestSlotBlocked !== "boolean" ||
    !matchSlot(value, "host") ||
    !matchSlot(value, "guest")
  )
    return false;
  if (
    value.hostProfileId !== null &&
    value.hostProfileId === value.guestProfileId
  )
    return false;
  if (value.hostLoginUid !== null && value.hostLoginUid === value.guestLoginUid)
    return false;
  if (value.status === "upcoming" || value.status === "pending") {
    return (
      value.resolvedAtMs === null &&
      value.winnerProfileId === null &&
      value.loserProfileId === null &&
      (value.status === "upcoming"
        ? value.inviteId === null
        : value.winnerDisqualified ||
          (key(value.inviteId) &&
            key(value.hostProfileId) &&
            key(value.guestProfileId)))
    );
  }
  if (!integer(value.resolvedAtMs)) return false;
  if (value.status === "host" || value.status === "guest") {
    return (
      key(value.winnerProfileId) &&
      value.winnerProfileId ===
        (value.status === "host"
          ? value.hostProfileId
          : value.guestProfileId) &&
      value.loserProfileId ===
        (value.status === "host" ? value.guestProfileId : value.hostProfileId)
    );
  }
  return (
    value.status === "bye" &&
    value.loserProfileId === null &&
    (value.winnerProfileId === null ||
      value.winnerProfileId === value.hostProfileId ||
      value.winnerProfileId === value.guestProfileId)
  );
}
function isEventMatches(value) {
  return (
    isRecord(value) &&
    Object.keys(value).length <= 16 &&
    Object.entries(value).every(
      ([matchKey, match]) =>
        isEventMatchRecord(match) &&
        match.matchKey === matchKey &&
        matchKey !== event_types_js_1.THIRD_PLACE_MATCH_KEY,
    )
  );
}
function isEventRoundRecord(value) {
  if (
    !exactRecord(value, [
      "roundIndex",
      "status",
      "createdAtMs",
      "completedAtMs",
      "matches",
    ]) ||
    !integer(value.roundIndex) ||
    value.roundIndex >= 5 ||
    !integer(value.createdAtMs) ||
    !nullableInteger(value.completedAtMs) ||
    !isEventMatches(value.matches) ||
    !Object.keys(value.matches).every((matchKey) =>
      matchKey.startsWith(`${value.roundIndex}_`),
    )
  )
    return false;
  if (value.status === "upcoming" || value.status === "active")
    return value.completedAtMs === null;
  return (
    value.status === "completed" &&
    integer(value.completedAtMs) &&
    Object.keys(value.matches).length > 0 &&
    Object.values(value.matches).every(
      (match) =>
        match.status === "host" ||
        match.status === "guest" ||
        match.status === "bye" ||
        match.winnerDisqualified,
    )
  );
}
function isEventRounds(value) {
  return (
    isRecord(value) &&
    Object.keys(value).length <= 5 &&
    Object.entries(value).every(
      ([roundKey, round]) =>
        isEventRoundRecord(round) && String(round.roundIndex) === roundKey,
    )
  );
}
function isEventPrizeAssignments(value, eventId) {
  if (!isRecord(value)) return false;
  const profileIds = new Set();
  const prizeIds = new Set();
  for (const [place, assignment] of Object.entries(value)) {
    if (
      !["1", "2", "3"].includes(place) ||
      !(0, event_prizes_js_1.isEventPrizeAssignmentWireRecord)(assignment) ||
      assignment.eventId !== eventId ||
      String(assignment.place) !== place ||
      profileIds.has(assignment.profileId) ||
      prizeIds.has(assignment.prizeId)
    )
      return false;
    profileIds.add(assignment.profileId);
    prizeIds.add(assignment.prizeId);
  }
  return true;
}
function isRoundByes(value) {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([round, bye]) =>
        /^[0-4]$/.test(round) &&
        exactRecord(bye, ["profileId", "reason"]) &&
        key(bye.profileId) &&
        (bye.reason === "preferred" || bye.reason === "random"),
    )
  );
}
function isEventRecord(value) {
  if (
    !exactRecord(value, [
      "schemaVersion",
      "eventId",
      "isSundayMons",
      "status",
      "createdAtMs",
      "updatedAtMs",
      "startAtMs",
      "startedAtMs",
      "endedAtMs",
      "createdByProfileId",
      "createdByLoginUid",
      "createdByUsername",
      "winnerProfileId",
      "winnerDisplayName",
      "currentRoundIndex",
      "bracketFormat",
      "bracketSize",
      "roundCount",
      "roundByes",
      "telegramAnnouncements",
      "telegramDeliveryVersion",
      "supportsThirdPlaceMatch",
      "thirdPlaceMatch",
      "prizeSelectionsLockedAtMs",
      "prizeAssignments",
      "participants",
      "rounds",
    ]) ||
    value.schemaVersion !== 3 ||
    !key(value.eventId) ||
    typeof value.isSundayMons !== "boolean" ||
    !integer(value.createdAtMs) ||
    !integer(value.updatedAtMs) ||
    !integer(value.startAtMs) ||
    !nullableInteger(value.startedAtMs) ||
    !nullableInteger(value.endedAtMs) ||
    !key(value.createdByProfileId) ||
    !key(value.createdByLoginUid) ||
    !text(value.createdByUsername) ||
    !nullableKey(value.winnerProfileId) ||
    !nullableText(value.winnerDisplayName) ||
    !nullableInteger(value.currentRoundIndex) ||
    (value.bracketFormat !== "fixed" &&
      value.bracketFormat !== "archived-rolling") ||
    !integer(value.bracketSize) ||
    !integer(value.roundCount) ||
    !isRoundByes(value.roundByes) ||
    !isEventAnnouncements(value.telegramAnnouncements) ||
    value.telegramDeliveryVersion !== 2 ||
    typeof value.supportsThirdPlaceMatch !== "boolean" ||
    !(
      value.thirdPlaceMatch === null ||
      (isEventMatchRecord(value.thirdPlaceMatch) &&
        value.thirdPlaceMatch.matchKey ===
          event_types_js_1.THIRD_PLACE_MATCH_KEY)
    ) ||
    !nullableInteger(value.prizeSelectionsLockedAtMs) ||
    !isEventPrizeAssignments(value.prizeAssignments, value.eventId) ||
    !isEventParticipants(value.participants) ||
    !isEventRounds(value.rounds)
  )
    return false;
  if (!value.supportsThirdPlaceMatch && value.thirdPlaceMatch !== null)
    return false;
  if (value.winnerProfileId === null && value.winnerDisplayName !== null)
    return false;
  if (value.bracketFormat === "archived-rolling") {
    const roundCount = value.roundCount;
    if (
      value.status !== "ended" ||
      value.bracketSize !== 0 ||
      value.roundCount < 1 ||
      value.roundCount > 5 ||
      !integer(value.startedAtMs) ||
      !integer(value.endedAtMs) ||
      value.currentRoundIndex !== value.roundCount - 1 ||
      value.winnerProfileId === null ||
      Object.keys(value.rounds).length !== value.roundCount ||
      Object.keys(value.roundByes).some((round) => Number(round) >= roundCount)
    )
      return false;
    let advancing = new Set(Object.keys(value.participants));
    if (advancing.size < 2 || advancing.size > 32) return false;
    for (let index = 0; index < value.roundCount; index++) {
      const round = value.rounds[String(index)],
        bye = value.roundByes[String(index)];
      if (
        !round ||
        round.status !== "completed" ||
        Object.keys(round.matches).length !== Math.floor(advancing.size / 2) ||
        Boolean(bye) !== (advancing.size % 2 === 1)
      )
        return false;
      const competing = new Set(),
        next = new Set();
      for (const match of Object.values(round.matches)) {
        if (
          (match.status !== "host" && match.status !== "guest") ||
          match.winnerDisqualified ||
          match.hostProfileId === null ||
          match.guestProfileId === null ||
          match.winnerProfileId === null ||
          !advancing.has(match.hostProfileId) ||
          !advancing.has(match.guestProfileId) ||
          competing.has(match.hostProfileId) ||
          competing.has(match.guestProfileId)
        )
          return false;
        competing.add(match.hostProfileId);
        competing.add(match.guestProfileId);
        next.add(match.winnerProfileId);
      }
      if (bye) {
        if (!advancing.has(bye.profileId) || competing.has(bye.profileId))
          return false;
        competing.add(bye.profileId);
        next.add(bye.profileId);
      }
      if (competing.size !== advancing.size) return false;
      advancing = next;
    }
    return advancing.size === 1 && advancing.has(value.winnerProfileId);
  }
  if (Object.keys(value.roundByes).length !== 0) return false;
  if (value.status === "scheduled" || value.status === "dismissed") {
    return (
      value.startedAtMs === null &&
      (value.status === "scheduled"
        ? value.endedAtMs === null
        : integer(value.endedAtMs)) &&
      value.currentRoundIndex === null &&
      value.bracketSize === 0 &&
      value.roundCount === 0 &&
      value.winnerProfileId === null &&
      value.winnerDisplayName === null &&
      value.thirdPlaceMatch === null &&
      Object.keys(value.rounds).length === 0 &&
      Object.values(value.participants).every(
        (participant) => participant.state === "active",
      )
    );
  }
  if (
    (value.status !== "active" && value.status !== "ended") ||
    !integer(value.startedAtMs) ||
    !integer(value.currentRoundIndex) ||
    ![2, 4, 8, 16, 32].includes(value.bracketSize) ||
    value.roundCount !== Math.log2(value.bracketSize) ||
    value.currentRoundIndex >= value.roundCount ||
    Object.keys(value.rounds).length !== value.roundCount
  )
    return false;
  for (let index = 0; index < value.roundCount; index += 1) {
    const round = value.rounds[String(index)];
    if (
      !round ||
      Object.keys(round.matches).length !== value.bracketSize / 2 ** (index + 1)
    )
      return false;
  }
  if (value.status === "active") {
    return (
      value.endedAtMs === null &&
      value.winnerProfileId === null &&
      value.winnerDisplayName === null
    );
  }
  return integer(value.endedAtMs);
}
function parseEventRecord(value) {
  if (!isEventRecord(value)) throw new TypeError("invalid-canonical-event");
  return value;
}
function decodeEventParticipantView(value, profileId) {
  if (!isEventParticipantRecord(value) || value.profileId !== profileId) {
    throw new TypeError("invalid-canonical-event-participant");
  }
  return value;
}
function decodeEventMatchView(value, matchKey) {
  if (!isEventMatchRecord(value) || value.matchKey !== matchKey) {
    throw new TypeError("invalid-canonical-event-match");
  }
  return value;
}
function decodeEventRoundView(value, roundIndex) {
  if (!isEventRoundRecord(value) || value.roundIndex !== roundIndex) {
    throw new TypeError("invalid-canonical-event-round");
  }
  return value;
}
function normalizeEventPrizeId(value, eventId) {
  return typeof value === "string" &&
    (0, event_prizes_js_1.isEventPrizeId)(eventId, value)
    ? value
    : null;
}
function decodeEventPrizeAssignmentView(value, eventId) {
  return (0, event_prizes_js_1.isEventPrizeAssignmentWireRecord)(value) &&
    value.eventId === eventId
    ? value
    : null;
}
function decodeEventPrizeAssignmentsView(value, eventId) {
  if (!isEventPrizeAssignments(value, eventId))
    throw new TypeError("invalid-canonical-event-prizes");
  return value;
}
function decodeEventView(value, eventId) {
  return isEventRecord(value) && value.eventId === eventId ? value : null;
}
