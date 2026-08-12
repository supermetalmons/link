import {
  getNavigationSortBucket,
  normalizeStrictAutomatchStateHint,
} from "@mons/shared/navigation";

import type {
  EventNavigationPreviewParticipant,
  NavigationItem,
  NavigationItemStatus,
} from "./connectionModels";
import {
  normalizeFiniteNumber,
  normalizeStringOrNull,
  readTimestampMillis,
} from "./valueNormalizers";

export const normalizeNavigationStatus = (
  status: unknown,
): NavigationItemStatus => {
  if (
    status === "pending" ||
    status === "waiting" ||
    status === "active" ||
    status === "ended" ||
    status === "dismissed"
  ) {
    return status;
  }
  return "waiting";
};

export const mapFirestoreParticipantPreview = (
  value: unknown,
): EventNavigationPreviewParticipant[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.reduce<EventNavigationPreviewParticipant[]>(
    (acc, participant) => {
      if (!participant || typeof participant !== "object") {
        return acc;
      }
      const raw = participant as Record<string, unknown>;
      const emojiId = normalizeFiniteNumber(raw.emojiId, NaN);
      acc.push({
        profileId: normalizeStringOrNull(raw.profileId),
        displayName: normalizeStringOrNull(raw.displayName),
        emojiId: Number.isFinite(emojiId) ? emojiId : null,
        aura: normalizeStringOrNull(raw.aura),
      });
      return acc;
    },
    [],
  );
};

export const mapFirestoreGameDocToNavigationItem = (
  rawData: Record<string, unknown>,
  fallbackInviteId: string,
): NavigationItem | null => {
  const entityType = rawData.entityType === "event" ? "event" : "game";
  if (entityType === "event") {
    const eventId = normalizeStringOrNull(rawData.eventId);
    if (!eventId) {
      return null;
    }
    const rawStatus = normalizeNavigationStatus(rawData.status);
    if (rawStatus === "pending") {
      return null;
    }
    const status: Exclude<NavigationItemStatus, "pending"> = rawStatus;
    const participantPreview = mapFirestoreParticipantPreview(
      rawData.participantPreview,
    );
    return {
      id:
        typeof rawData.id === "string" && rawData.id !== ""
          ? rawData.id
          : `event_${eventId}`,
      entityType: "event",
      eventId,
      status,
      sortBucket: getNavigationSortBucket(status),
      listSortAtMs: readTimestampMillis(rawData.listSortAt) || Date.now(),
      startAtMs: readTimestampMillis(rawData.startAt) || null,
      updatedAtMs: readTimestampMillis(rawData.updatedAt) || null,
      endedAtMs: readTimestampMillis(rawData.endedAt) || null,
      participantCount: normalizeFiniteNumber(
        rawData.participantCount,
        participantPreview.length,
      ),
      participantPreview,
      winnerDisplayName: normalizeStringOrNull(rawData.winnerDisplayName),
    };
  }

  const inviteId =
    typeof rawData.inviteId === "string" && rawData.inviteId !== ""
      ? rawData.inviteId
      : fallbackInviteId;
  if (!inviteId) {
    return null;
  }

  const rawStatus = normalizeNavigationStatus(rawData.status);
  const status = rawStatus === "dismissed" ? "ended" : rawStatus;
  const sortBucket = getNavigationSortBucket(status);
  const listSortAtMs = readTimestampMillis(rawData.listSortAt);
  const automatchStateHint = normalizeStrictAutomatchStateHint(
    rawData.automatchStateHint,
  );
  const rawOpponentEmoji = rawData.opponentEmoji ?? rawData.opponentEmojiId;
  const rawOpponentName = rawData.opponentName ?? rawData.opponentDisplayName;
  const opponentEmoji =
    typeof rawOpponentEmoji === "number" && Number.isFinite(rawOpponentEmoji)
      ? Math.floor(rawOpponentEmoji)
      : typeof rawOpponentEmoji === "string" &&
          rawOpponentEmoji !== "" &&
          Number.isFinite(Number(rawOpponentEmoji))
        ? Math.floor(Number(rawOpponentEmoji))
        : null;

  if ((status === "active" || status === "ended") && opponentEmoji === null) {
    return null;
  }

  return {
    id: inviteId,
    entityType: "game",
    inviteId,
    kind: rawData.kind === "auto" ? "auto" : "direct",
    status,
    sortBucket,
    listSortAtMs: listSortAtMs > 0 ? listSortAtMs : Date.now(),
    hostLoginId:
      typeof rawData.hostLoginId === "string" ? rawData.hostLoginId : null,
    guestLoginId:
      typeof rawData.guestLoginId === "string" ? rawData.guestLoginId : null,
    opponentProfileId:
      typeof rawData.opponentProfileId === "string"
        ? rawData.opponentProfileId
        : null,
    opponentName: typeof rawOpponentName === "string" ? rawOpponentName : null,
    opponentEmoji,
    automatchStateHint,
    isPendingAutomatch:
      typeof rawData.isPendingAutomatch === "boolean"
        ? rawData.isPendingAutomatch
        : status === "pending",
  };
};
