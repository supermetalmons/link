import type { EventData, EventParticipants } from "./model.js";
import {
  eventState,
  eventParticipantEntries,
  eventParticipantState,
  eventParticipantProjectionState,
} from "./documents.js";

import "@mons/shared/navigation";

const NAVIGATION_PARTICIPANT_PREVIEW_LIMIT = 6;
const MAX_TIMESTAMP_MS = 253402300799999;

const normalizeString = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const normalizeFiniteNumberOrNull = (value: unknown) => {
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

const mapEventStatusToNavigationStatus = (status: unknown) => {
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

const getListSortAtMs = (eventData: EventData, status: string) => {
  const state = eventState(eventData);
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

const buildPreviewParticipants = (
  participants: EventParticipants | null | undefined,
) => {
  return eventParticipantEntries(participants)
    .map(([, value]) => value)
    .filter((participant) => participant && typeof participant === "object")
    .sort((left, right) => {
      const leftJoined = eventParticipantState(left).joinedAtMs ?? 0;
      const rightJoined = eventParticipantState(right).joinedAtMs ?? 0;
      return leftJoined - rightJoined;
    })
    .map((participant) => ({
      profileId: normalizeString(eventParticipantState(participant).profileId),
      displayName: normalizeString(
        eventParticipantState(participant).displayName,
      ),
      emojiId: normalizeFiniteNumberOrNull(
        eventParticipantProjectionState(participant).emojiId,
      ),
      aura: normalizeString(eventParticipantState(participant).aura),
    }));
};

const getOwnerProfileIds = (
  participants: EventParticipants | null | undefined,
) => {
  return Array.from(
    new Set(
      eventParticipantEntries(participants)
        .map(([, value]) => value)
        .map((participant) =>
          normalizeString(eventParticipantState(participant).profileId),
        )
        .filter((value): value is string => !!value),
    ),
  );
};

export {
  NAVIGATION_PARTICIPANT_PREVIEW_LIMIT,
  buildPreviewParticipants,
  getListSortAtMs,
  getOwnerProfileIds,
  mapEventStatusToNavigationStatus,
  normalizeFiniteNumberOrNull,
  normalizeString,
};
