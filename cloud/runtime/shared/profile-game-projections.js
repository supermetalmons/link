// Generated from src/shared/profile-game-projections.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROJECTION_SORT_BUCKETS = void 0;
exports.isGameProjectionRecord = isGameProjectionRecord;
exports.isEventProjectionRecord = isEventProjectionRecord;
exports.isProfileGameProjectionRecord = isProfileGameProjectionRecord;
exports.parseProfileGameProjectionRecord = parseProfileGameProjectionRecord;
const appearance_js_1 = require("./appearance.js");
const ids_js_1 = require("./ids.js");
exports.PROJECTION_SORT_BUCKETS = Object.freeze({
  pending: 20,
  waiting: 30,
  active: 40,
  ended: 50,
  dismissed: 50,
});
function record(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
function exact(value, keys) {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
const key = (value) =>
  typeof value === "string" &&
  (0, ids_js_1.normalizeRecordKey)(value) === value;
const nullableKey = (value) => value === null || key(value);
const nullableText = (value) => value === null || typeof value === "string";
const time = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nullableTime = (value) => value === null || time(value);
const nullableEmoji = (value) =>
  value === null || (0, appearance_js_1.isEmojiId)(value);
function isGameProjectionRecord(value) {
  if (
    !exact(value, [
      "schemaVersion",
      "projectorVersion",
      "source",
      "entityType",
      "inviteId",
      "kind",
      "hostLoginId",
      "guestLoginId",
      "hostProfileId",
      "guestProfileId",
      "status",
      "sortBucket",
      "isPendingAutomatch",
      "automatchStateHint",
      "automatchCanceledAt",
      "latestMatchId",
      "ownerProfileId",
      "ownerRole",
      "ownerLoginId",
      "opponentProfileId",
      "opponentLoginId",
      "opponentName",
      "opponentEmoji",
      "listSortAt",
      "createdAt",
      "updatedAt",
      "endedAt",
      "lastEventFingerprint",
      "lastEventType",
      "lastEventReason",
      "lastEventAt",
    ]) ||
    value.schemaVersion !== 3 ||
    value.projectorVersion !== 3 ||
    value.source !== "game-projector" ||
    value.entityType !== "game" ||
    !key(value.inviteId) ||
    (value.kind !== "auto" && value.kind !== "direct") ||
    ![
      value.hostLoginId,
      value.guestLoginId,
      value.hostProfileId,
      value.guestProfileId,
      value.ownerLoginId,
      value.opponentProfileId,
      value.opponentLoginId,
    ].every(nullableKey) ||
    !key(value.ownerProfileId) ||
    !key(value.latestMatchId) ||
    (value.ownerRole !== "host" && value.ownerRole !== "guest") ||
    !nullableText(value.opponentName) ||
    !nullableEmoji(value.opponentEmoji) ||
    ![
      value.listSortAt,
      value.createdAt,
      value.updatedAt,
      value.lastEventAt,
    ].every(time) ||
    !nullableTime(value.endedAt) ||
    !nullableTime(value.automatchCanceledAt) ||
    typeof value.lastEventFingerprint !== "string" ||
    !nullableText(value.lastEventType) ||
    !nullableText(value.lastEventReason) ||
    ![null, "pending", "matched", "canceled"].some(
      (hint) => hint === value.automatchStateHint,
    ) ||
    !["pending", "waiting", "active", "ended"].some(
      (status) => status === value.status,
    )
  )
    return false;
  const status = value.status;
  return (
    value.sortBucket === exports.PROJECTION_SORT_BUCKETS[status] &&
    value.isPendingAutomatch === (status === "pending") &&
    ((status !== "active" && status !== "ended") ||
      value.opponentEmoji !== null)
  );
}
function isEventProjectionRecord(value) {
  if (
    !exact(value, [
      "schemaVersion",
      "source",
      "entityType",
      "id",
      "eventId",
      "status",
      "sortBucket",
      "listSortAt",
      "ownerProfileId",
      "startAt",
      "updatedAt",
      "endedAt",
      "participantCount",
      "participantPreview",
      "winnerDisplayName",
    ]) ||
    value.schemaVersion !== 2 ||
    value.source !== "event-projector" ||
    value.entityType !== "event" ||
    !key(value.eventId) ||
    value.id !== `event_${value.eventId}` ||
    !key(value.ownerProfileId) ||
    !time(value.listSortAt) ||
    !time(value.updatedAt) ||
    !nullableTime(value.startAt) ||
    !nullableTime(value.endedAt) ||
    !nullableText(value.winnerDisplayName) ||
    typeof value.participantCount !== "number" ||
    !Number.isSafeInteger(value.participantCount) ||
    value.participantCount < 0 ||
    !Array.isArray(value.participantPreview) ||
    value.participantPreview.length > 6 ||
    value.participantPreview.length > value.participantCount ||
    !value.participantPreview.every(
      (participant) =>
        exact(participant, ["profileId", "displayName", "emojiId", "aura"]) &&
        nullableKey(participant.profileId) &&
        nullableText(participant.displayName) &&
        nullableEmoji(participant.emojiId) &&
        (0, appearance_js_1.isAura)(participant.aura),
    ) ||
    !["waiting", "active", "ended", "dismissed"].some(
      (status) => status === value.status,
    )
  )
    return false;
  return value.sortBucket === exports.PROJECTION_SORT_BUCKETS[value.status];
}
function isProfileGameProjectionRecord(value) {
  return isGameProjectionRecord(value) || isEventProjectionRecord(value);
}
function parseProfileGameProjectionRecord(value) {
  if (!isProfileGameProjectionRecord(value))
    throw new TypeError("invalid-canonical-profile-game-projection");
  return value;
}
