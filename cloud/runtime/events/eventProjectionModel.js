// Generated from src/events/eventProjectionModel.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeString =
  exports.normalizeFiniteNumberOrNull =
  exports.mapEventStatusToNavigationStatus =
  exports.getOwnerProfileIds =
  exports.getListSortAtMs =
  exports.buildPreviewParticipants =
  exports.NAVIGATION_PARTICIPANT_PREVIEW_LIMIT =
    void 0;
const documents_js_1 = require("./documents.js");
require("@mons/shared/navigation");
const NAVIGATION_PARTICIPANT_PREVIEW_LIMIT = 6;
exports.NAVIGATION_PARTICIPANT_PREVIEW_LIMIT =
  NAVIGATION_PARTICIPANT_PREVIEW_LIMIT;
const MAX_TIMESTAMP_MS = 253402300799999;
const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
exports.normalizeString = normalizeString;
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
exports.normalizeFiniteNumberOrNull = normalizeFiniteNumberOrNull;
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
exports.mapEventStatusToNavigationStatus = mapEventStatusToNavigationStatus;
const getListSortAtMs = (eventData, status) => {
  const state = (0, documents_js_1.eventState)(eventData);
  if (status === "active") {
    const startedAtMs =
      typeof state.startedAtMs === "number"
        ? Math.floor(state.startedAtMs)
        : typeof state.startAtMs === "number"
          ? Math.floor(state.startAtMs)
          : typeof state.createdAtMs === "number"
            ? Math.floor(state.createdAtMs)
            : null;
    if (startedAtMs && Number.isFinite(startedAtMs) && startedAtMs > 0) {
      return startedAtMs;
    }
    return 1;
  }
  if (status === "ended") {
    return typeof state.endedAtMs === "number"
      ? Math.floor(state.endedAtMs)
      : typeof state.startAtMs === "number"
        ? Math.floor(state.startAtMs)
        : typeof state.createdAtMs === "number"
          ? Math.floor(state.createdAtMs)
          : 1;
  }
  if (status === "dismissed") {
    return typeof state.endedAtMs === "number"
      ? Math.floor(state.endedAtMs)
      : typeof state.startAtMs === "number"
        ? Math.floor(state.startAtMs)
        : typeof state.createdAtMs === "number"
          ? Math.floor(state.createdAtMs)
          : 1;
  }
  const startAtMs =
    typeof state.startAtMs === "number" ? Math.floor(state.startAtMs) : null;
  if (startAtMs === null || !Number.isFinite(startAtMs) || startAtMs <= 0) {
    return typeof state.createdAtMs === "number"
      ? Math.floor(state.createdAtMs)
      : 1;
  }
  return Math.min(MAX_TIMESTAMP_MS, Math.max(1, MAX_TIMESTAMP_MS - startAtMs));
};
exports.getListSortAtMs = getListSortAtMs;
const buildPreviewParticipants = (participants) => {
  return (0, documents_js_1.eventParticipantEntries)(participants)
    .map(([, value]) => value)
    .filter((participant) => participant && typeof participant === "object")
    .sort((left, right) => {
      const leftJoined =
        (0, documents_js_1.eventParticipantState)(left).joinedAtMs ?? 0;
      const rightJoined =
        (0, documents_js_1.eventParticipantState)(right).joinedAtMs ?? 0;
      return leftJoined - rightJoined;
    })
    .map((participant) => ({
      profileId: normalizeString(
        (0, documents_js_1.eventParticipantState)(participant).profileId,
      ),
      displayName: normalizeString(
        (0, documents_js_1.eventParticipantState)(participant).displayName,
      ),
      emojiId: normalizeFiniteNumberOrNull(
        (0, documents_js_1.eventParticipantProjectionState)(participant)
          .emojiId,
      ),
      aura: normalizeString(
        (0, documents_js_1.eventParticipantState)(participant).aura,
      ),
    }));
};
exports.buildPreviewParticipants = buildPreviewParticipants;
const getOwnerProfileIds = (participants) => {
  return Array.from(
    new Set(
      (0, documents_js_1.eventParticipantEntries)(participants)
        .map(([, value]) => value)
        .map((participant) =>
          normalizeString(
            (0, documents_js_1.eventParticipantState)(participant).profileId,
          ),
        )
        .filter((value) => !!value),
    ),
  );
};
exports.getOwnerProfileIds = getOwnerProfileIds;
