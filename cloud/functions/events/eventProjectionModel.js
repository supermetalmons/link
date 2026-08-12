"use strict";

const {
  NAVIGATION_SORT_BUCKETS: SORT_BUCKETS,
} = require("@mons/shared/navigation");

const NAVIGATION_PARTICIPANT_PREVIEW_LIMIT = 6;
const MAX_TIMESTAMP_MS = 253402300799999;

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const normalizeFiniteNumberOrNull = (value) => {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const normalized = Math.floor(numeric);
  return normalized > 0 ? normalized : null;
};

const mapEventStatusToNavigationStatus = (status) => {
  if (status === "active") {
    return "active";
  }
  if (status === "ended") {
    return "ended";
  }
  if (status === "dismissed") {
    return "dismissed";
  }
  return "waiting";
};

const getListSortAtMs = (eventData, status) => {
  if (status === "active") {
    const startedAtMs =
      typeof eventData.startedAtMs === "number"
        ? Math.floor(eventData.startedAtMs)
        : typeof eventData.startAtMs === "number"
          ? Math.floor(eventData.startAtMs)
          : typeof eventData.createdAtMs === "number"
            ? Math.floor(eventData.createdAtMs)
            : null;
    if (startedAtMs && Number.isFinite(startedAtMs) && startedAtMs > 0) {
      return startedAtMs;
    }
    return 1;
  }
  if (status === "ended") {
    return typeof eventData.endedAtMs === "number"
      ? Math.floor(eventData.endedAtMs)
      : typeof eventData.startAtMs === "number"
        ? Math.floor(eventData.startAtMs)
        : typeof eventData.createdAtMs === "number"
          ? Math.floor(eventData.createdAtMs)
          : 1;
  }
  if (status === "dismissed") {
    return typeof eventData.endedAtMs === "number"
      ? Math.floor(eventData.endedAtMs)
      : typeof eventData.startAtMs === "number"
        ? Math.floor(eventData.startAtMs)
        : typeof eventData.createdAtMs === "number"
          ? Math.floor(eventData.createdAtMs)
          : 1;
  }
  const startAtMs =
    typeof eventData.startAtMs === "number"
      ? Math.floor(eventData.startAtMs)
      : null;
  if (startAtMs === null || !Number.isFinite(startAtMs) || startAtMs <= 0) {
    return typeof eventData.createdAtMs === "number"
      ? Math.floor(eventData.createdAtMs)
      : 1;
  }
  return Math.min(MAX_TIMESTAMP_MS, Math.max(1, MAX_TIMESTAMP_MS - startAtMs));
};

const buildPreviewParticipants = (participants) => {
  return Object.values(participants || {})
    .filter((participant) => participant && typeof participant === "object")
    .sort((left, right) => {
      const leftJoined =
        typeof left.joinedAtMs === "number" ? left.joinedAtMs : 0;
      const rightJoined =
        typeof right.joinedAtMs === "number" ? right.joinedAtMs : 0;
      return leftJoined - rightJoined;
    })
    .map((participant) => ({
      profileId: normalizeString(participant.profileId),
      displayName: normalizeString(participant.displayName),
      emojiId: normalizeFiniteNumberOrNull(participant.emojiId),
      aura: normalizeString(participant.aura),
    }));
};

const getOwnerProfileIds = (participants) => {
  return Array.from(
    new Set(
      Object.values(participants || {})
        .map((participant) =>
          normalizeString(participant && participant.profileId),
        )
        .filter((value) => !!value),
    ),
  );
};

const buildProjectionFingerprint = (eventData) => {
  if (!eventData || typeof eventData !== "object") {
    return "null";
  }
  const participants =
    eventData.participants && typeof eventData.participants === "object"
      ? eventData.participants
      : {};
  const status = mapEventStatusToNavigationStatus(
    normalizeString(eventData.status),
  );
  const fullPreviewParticipants = buildPreviewParticipants(participants);
  const participantPreview = fullPreviewParticipants.slice(
    0,
    NAVIGATION_PARTICIPANT_PREVIEW_LIMIT,
  );
  const ownerProfileIds = getOwnerProfileIds(participants).sort();
  return JSON.stringify({
    status,
    sortBucket: SORT_BUCKETS[status],
    listSortAtMs: getListSortAtMs(eventData, status),
    startAtMs: normalizeFiniteNumberOrNull(eventData.startAtMs),
    endedAtMs: normalizeFiniteNumberOrNull(eventData.endedAtMs),
    winnerDisplayName: normalizeString(eventData.winnerDisplayName),
    participantCount: fullPreviewParticipants.length,
    participantPreview,
    ownerProfileIds,
  });
};

module.exports = {
  NAVIGATION_PARTICIPANT_PREVIEW_LIMIT,
  buildPreviewParticipants,
  buildProjectionFingerprint,
  getListSortAtMs,
  getOwnerProfileIds,
  mapEventStatusToNavigationStatus,
  normalizeFiniteNumberOrNull,
  normalizeString,
};
