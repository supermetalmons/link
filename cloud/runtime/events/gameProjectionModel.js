// Generated from src/events/gameProjectionModel.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldProjectInvite =
  exports.readTimestampMillis =
  exports.readEventTimestampMs =
  exports.pickListSortMillis =
  exports.normalizeString =
  exports.isEventOwnedInvite =
  exports.getProfileEmoji =
  exports.getProfileDisplayName =
  exports.getOwnerProfileIds =
  exports.getOwnerContext =
  exports.getNavigationSortBucket =
  exports.getEmojiId =
  exports.fingerprintForProjection =
  exports.deriveProjectionStatus =
  exports.PROJECTOR_SCHEMA_VERSION =
    void 0;
const invite_records_1 = require("@mons/shared/invite-records");
Object.defineProperty(exports, "isEventOwnedInvite", {
  enumerable: true,
  get: function () {
    return invite_records_1.inviteIsEventOwned;
  },
});
const rematches_1 = require("@mons/shared/rematches");
const navigation_1 = require("@mons/shared/navigation");
Object.defineProperty(exports, "getNavigationSortBucket", {
  enumerable: true,
  get: function () {
    return navigation_1.getNavigationSortBucket;
  },
});
const profiles_1 = require("@mons/shared/profiles");
const ids_1 = require("@mons/shared/ids");
const profileEvidence = (value) => {
  const retained = value;
  return retained;
};
const PROJECTOR_SCHEMA_VERSION = 2;
exports.PROJECTOR_SCHEMA_VERSION = PROJECTOR_SCHEMA_VERSION;
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
exports.normalizeString = normalizeString;
const readTimestampMillis = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  return null;
};
exports.readTimestampMillis = readTimestampMillis;
const truncateAddress = (address) => {
  if (typeof address !== "string" || address.length < 8) {
    return "anon";
  }
  return (0, profiles_1.cropAddress)(address);
};
const getProfileDisplayName = (source) => {
  const profileData = profileEvidence(source);
  if (!profileData || typeof profileData !== "object") {
    return "anon";
  }
  if (
    typeof profileData.username === "string" &&
    profileData.username.trim() !== ""
  ) {
    return profileData.username.trim();
  }
  if (typeof profileData.eth === "string" && profileData.eth.trim() !== "") {
    return truncateAddress(profileData.eth.trim());
  }
  if (typeof profileData.sol === "string" && profileData.sol.trim() !== "") {
    return truncateAddress(profileData.sol.trim());
  }
  return "anon";
};
exports.getProfileDisplayName = getProfileDisplayName;
const getProfileEmoji = (document) => {
  const profileData = profileEvidence(document);
  if (!profileData || typeof profileData !== "object") {
    return null;
  }
  const customEmoji =
    profileData.custom && typeof profileData.custom === "object"
      ? profileData.custom.emoji
      : undefined;
  const fallbackEmoji = profileData.emoji;
  const source = customEmoji !== undefined ? customEmoji : fallbackEmoji;
  if (typeof source === "number" && Number.isFinite(source)) {
    return Math.floor(source);
  }
  if (typeof source === "string" && source.trim() !== "") {
    const parsed = Number(source);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return null;
};
exports.getProfileEmoji = getProfileEmoji;
const getEmojiId = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return null;
};
exports.getEmojiId = getEmojiId;
const deriveProjectionStatus = ({
  inviteId,
  inviteData,
  automatchStateHint,
  latestMatchRatingCompleted,
}) => {
  if (
    (0, rematches_1.rematchSeriesEnded)(
      inviteData ? (0, invite_records_1.inviteRematchState)(inviteData) : null,
    )
  ) {
    return "ended";
  }
  if (
    (0, invite_records_1.inviteIsEventOwned)(inviteData) &&
    latestMatchRatingCompleted === true
  ) {
    return "ended";
  }
  const hasGuest = !!(0, invite_records_1.inviteTrimmedParticipants)(inviteData)
    .guestId;
  if ((0, ids_1.isAutoInviteId)(inviteId) && automatchStateHint === "pending") {
    return "pending";
  }
  if (hasGuest) {
    return "active";
  }
  return "waiting";
};
exports.deriveProjectionStatus = deriveProjectionStatus;
const shouldProjectInvite = ({ inviteId, inviteData, automatchStateHint }) => {
  if (!inviteData || typeof inviteData !== "object") {
    return false;
  }
  if (!(0, ids_1.isAutoInviteId)(inviteId)) {
    return true;
  }
  const hasGuest = !!(0, invite_records_1.inviteTrimmedParticipants)(inviteData)
    .guestId;
  if (hasGuest) {
    return true;
  }
  return automatchStateHint === "pending";
};
exports.shouldProjectInvite = shouldProjectInvite;
const fingerprintForProjection = (payload) => JSON.stringify(payload);
exports.fingerprintForProjection = fingerprintForProjection;
const pickListSortMillis = ({
  options,
  status,
  automatchData,
  nowMs,
  existingListSortMs,
}) => {
  if (
    options.preserveListSortAt === true &&
    Number.isFinite(existingListSortMs)
  ) {
    return Math.floor(existingListSortMs);
  }
  let nextSortMillis = Number.isFinite(options.listSortAtMs)
    ? Math.floor(options.listSortAtMs)
    : nowMs;
  if (!Number.isFinite(options.listSortAtMs) && status === "pending") {
    const queueTimestamp =
      automatchData && Number.isFinite(automatchData.timestamp)
        ? Math.floor(automatchData.timestamp)
        : null;
    if (queueTimestamp && queueTimestamp > 0) {
      nextSortMillis = queueTimestamp;
    }
  }
  if (
    options.preserveNewerListSortAt !== false &&
    Number.isFinite(existingListSortMs)
  ) {
    nextSortMillis = Math.max(nextSortMillis, existingListSortMs);
  }
  return nextSortMillis;
};
exports.pickListSortMillis = pickListSortMillis;
const getOwnerProfileIds = (hostProfileId, guestProfileId) => {
  const owners = [];
  if (hostProfileId) {
    owners.push(hostProfileId);
  }
  if (guestProfileId && guestProfileId !== hostProfileId) {
    owners.push(guestProfileId);
  }
  return owners;
};
exports.getOwnerProfileIds = getOwnerProfileIds;
const getOwnerContext = ({
  ownerProfileId,
  hostProfileId,
  guestProfileId,
  hostLoginId,
  guestLoginId,
}) => {
  if (ownerProfileId === hostProfileId) {
    return {
      ownerRole: "host",
      ownerLoginId: hostLoginId || null,
      opponentProfileId: guestProfileId || null,
      opponentLoginId: guestLoginId || null,
    };
  }
  return {
    ownerRole: "guest",
    ownerLoginId: guestLoginId || null,
    opponentProfileId: hostProfileId || null,
    opponentLoginId: hostLoginId || null,
  };
};
exports.getOwnerContext = getOwnerContext;
const readEventTimestampMs = (options) => {
  if (options && Number.isFinite(options.eventTimestampMs)) {
    return Math.floor(options.eventTimestampMs);
  }
  return Date.now();
};
exports.readEventTimestampMs = readEventTimestampMs;
