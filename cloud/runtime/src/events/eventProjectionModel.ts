import type { EventData, EventParticipants } from "./model.js";
import {
  eventState,
  eventParticipantEntries,
  eventParticipantState,
} from "./documents.js";

import "@mons/shared/navigation";

const NAVIGATION_PARTICIPANT_PREVIEW_LIMIT = 6;
const MAX_TIMESTAMP_MS = 253402300799999;

const normalizeString = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

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
) =>
  eventParticipantEntries(participants)
    .map(([, participant]) => participant)
    .sort((left, right) => left.joinedAtMs - right.joinedAtMs)
    .map((participant) => ({
      profileId: participant.profileId,
      displayName: participant.displayName,
      emojiId: participant.emojiId,
      aura: participant.aura,
    }));

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
  normalizeString,
};
