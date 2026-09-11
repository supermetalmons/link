"use strict";

const { rematchSeriesEnded } = require("@mons/shared/rematches");
const { getNavigationSortBucket } = require("@mons/shared/navigation");
const { cropAddress } = require("@mons/shared/profiles");
const { isAutoInviteId } = require("@mons/shared/ids");
const { isEventOwnedInvite } = require("@mons/shared/events");

const PROJECTOR_SCHEMA_VERSION = 2;

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const readTimestampMillis = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  return null;
};

const truncateAddress = (address) => {
  if (typeof address !== "string" || address.length < 8) {
    return "anon";
  }
  return cropAddress(address);
};

const getProfileDisplayName = (profileData) => {
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

const getProfileEmoji = (profileData) => {
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

const deriveProjectionStatus = ({
  inviteId,
  inviteData,
  automatchStateHint,
  latestMatchRatingCompleted,
}) => {
  if (rematchSeriesEnded(inviteData)) {
    return "ended";
  }
  if (isEventOwnedInvite(inviteData) && latestMatchRatingCompleted === true) {
    return "ended";
  }
  const hasGuest = !!normalizeString(inviteData ? inviteData.guestId : null);
  if (isAutoInviteId(inviteId) && automatchStateHint === "pending") {
    return "pending";
  }
  if (hasGuest) {
    return "active";
  }
  return "waiting";
};

const shouldProjectInvite = ({ inviteId, inviteData, automatchStateHint }) => {
  if (!inviteData || typeof inviteData !== "object") {
    return false;
  }
  if (!isAutoInviteId(inviteId)) {
    return true;
  }
  const hasGuest = !!normalizeString(inviteData.guestId);
  if (hasGuest) {
    return true;
  }
  return automatchStateHint === "pending";
};

const fingerprintForProjection = (payload) => JSON.stringify(payload);

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

const readEventTimestampMs = (options) => {
  if (options && Number.isFinite(options.eventTimestampMs)) {
    return Math.floor(options.eventTimestampMs);
  }
  return Date.now();
};

module.exports = {
  PROJECTOR_SCHEMA_VERSION,
  deriveProjectionStatus,
  fingerprintForProjection,
  getEmojiId,
  getNavigationSortBucket,
  getOwnerContext,
  getOwnerProfileIds,
  getProfileDisplayName,
  getProfileEmoji,
  isEventOwnedInvite,
  normalizeString,
  pickListSortMillis,
  readEventTimestampMs,
  readTimestampMillis,
  shouldProjectInvite,
};
