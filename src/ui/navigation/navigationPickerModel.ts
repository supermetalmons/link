import type {
  NavigationEventItem,
  NavigationGameItem,
  NavigationItem,
} from "../../connection/connectionModels";

const MIN_REASONABLE_EPOCH_MS = Date.UTC(2000, 0, 1);

export function partitionNavigationItems(
  topGames: NavigationItem[],
  pagedGames: NavigationItem[],
): {
  waitingGames: NavigationGameItem[];
  topItems: NavigationItem[];
  pagedItems: NavigationItem[];
} {
  const visibleTopGames = topGames.filter(
    (item) => !(item.entityType === "event" && item.status === "dismissed"),
  );
  const visiblePagedGames = pagedGames.filter(
    (item) => !(item.entityType === "event" && item.status === "dismissed"),
  );
  const isWaitingForOpponentGame = (
    item: NavigationItem,
  ): item is NavigationGameItem =>
    item.entityType === "game" && item.status === "waiting";
  return {
    waitingGames: [
      ...visibleTopGames.filter(isWaitingForOpponentGame),
      ...visiblePagedGames.filter(isWaitingForOpponentGame),
    ],
    topItems: visibleTopGames.filter((item) => !isWaitingForOpponentGame(item)),
    pagedItems: visiblePagedGames.filter(
      (item) => !isWaitingForOpponentGame(item),
    ),
  };
}

export const getGameStatusLabel = (
  game: NavigationGameItem,
  now = new Date(),
): string => {
  if (game.status === "pending") {
    return "pending";
  }
  if (game.status === "active") {
    return "active";
  }
  if (game.status === "ended") {
    const lastUpdateMs = Number.isFinite(game.listSortAtMs)
      ? Math.floor(game.listSortAtMs)
      : 0;
    if (lastUpdateMs < MIN_REASONABLE_EPOCH_MS) {
      return "long ago";
    }
    const date = new Date(lastUpdateMs);
    if (Number.isNaN(date.getTime())) {
      return "long ago";
    }
    const includeYear = date.getFullYear() !== now.getFullYear();
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(includeYear ? { year: "numeric" } : {}),
    });
  }
  return "waiting";
};

export const getEventStatusLabel = (
  event: NavigationEventItem,
  now = new Date(),
): string => {
  if (event.status === "ended" || event.status === "dismissed") {
    const sourceMs = event.endedAtMs ?? event.updatedAtMs ?? event.listSortAtMs;
    if (!Number.isFinite(sourceMs) || sourceMs < MIN_REASONABLE_EPOCH_MS) {
      return "long ago";
    }

    const date = new Date(sourceMs);
    if (Number.isNaN(date.getTime())) {
      return "long ago";
    }

    const includeYear = date.getFullYear() !== now.getFullYear();
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(includeYear ? { year: "numeric" } : {}),
    });
  }
  if (event.status === "waiting") {
    return "SOON";
  }

  return event.status;
};

export function deriveEventPreview(event: NavigationEventItem): {
  emojiIds: number[];
  showUnknownOpponent: boolean;
  overflowCount: number | null;
} {
  const normalizedParticipantCount = event.participantCount;
  const showBadge = normalizedParticipantCount > 6;
  const maxVisible = showBadge ? 5 : 6;
  const previewEmojiIds = event.participantPreview.reduce<number[]>(
    (result, participant) => {
      if (result.length >= maxVisible) {
        return result;
      }
      if (participant.emojiId !== null) result.push(participant.emojiId);
      return result;
    },
    [],
  );
  const shouldShowUnknownOpponentSlot =
    event.status === "waiting" && normalizedParticipantCount === 1;
  const overflow = Math.max(
    0,
    normalizedParticipantCount - previewEmojiIds.length,
  );
  const hasBadge = showBadge && overflow > 0;
  return {
    emojiIds: previewEmojiIds,
    showUnknownOpponent: shouldShowUnknownOpponentSlot,
    overflowCount: hasBadge ? overflow : null,
  };
}
