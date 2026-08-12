import type {
  NavigationItem,
  NavigationEventItem,
  NavigationItemStatus,
} from "../connection/connectionModels";
import { normalizeStrictAutomatchStateHint } from "@mons/shared/navigation";

type NavigationGamesScopeKind = "profile" | "login";

export interface NavigationGamesCacheScope {
  kind: NavigationGamesScopeKind;
  scopeId: string;
  scopeKey: string;
}

interface NavigationGamesRuntimeEntry {
  topGames: NavigationItem[];
  pagedGames: NavigationItem[];
}

interface PersistedTopGamesPayload {
  version: number;
  updatedAtMs: number;
  topGames: NavigationItem[];
}

interface NavigationGamesCacheSnapshot {
  topGames: NavigationItem[];
  pagedGames: NavigationItem[];
}

const NAVIGATION_GAMES_PERSISTED_TOP_CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const NAVIGATION_GAMES_PERSISTED_TOP_CACHE_VERSION = 3;
const NAVIGATION_GAMES_PERSISTED_TOP_CACHE_KEY_PREFIX =
  "navigationGamesTopCache:v3:";
const NAVIGATION_GAMES_MAX_RUNTIME_ITEMS_PER_SECTION = 500;

const runtimeCacheByScope = new Map<string, NavigationGamesRuntimeEntry>();

const NAVIGATION_ITEM_STATUS_VALUES: NavigationItemStatus[] = [
  "pending",
  "waiting",
  "active",
  "ended",
  "dismissed",
];

const isNavigationItemStatus = (
  value: unknown,
): value is NavigationItemStatus => {
  return (
    typeof value === "string" &&
    NAVIGATION_ITEM_STATUS_VALUES.includes(value as NavigationItemStatus)
  );
};

const getNormalizedStringOrNull = (value: unknown): string | null => {
  return typeof value === "string" ? value : null;
};

const getNormalizedNumberOrNull = (value: unknown): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.floor(value) : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.floor(parsed) : null;
  }
  return null;
};

const getNormalizedBooleanOrUndefined = (
  value: unknown,
): boolean | undefined => {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
};

const sanitizeNavigationGameItem = (value: unknown): NavigationItem | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const entityType = raw.entityType === "event" ? "event" : "game";
  const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : null;

  if (entityType === "event") {
    const eventId = typeof raw.eventId === "string" ? raw.eventId : "";
    if (eventId === "") {
      return null;
    }
    const status =
      isNavigationItemStatus(raw.status) && raw.status !== "pending"
        ? raw.status
        : null;
    if (!status) {
      return null;
    }
    const sortBucket =
      typeof raw.sortBucket === "number" && Number.isFinite(raw.sortBucket)
        ? Math.floor(raw.sortBucket)
        : 0;
    const listSortAtMs =
      typeof raw.listSortAtMs === "number" && Number.isFinite(raw.listSortAtMs)
        ? Math.floor(raw.listSortAtMs)
        : 0;
    const participantPreview = Array.isArray(raw.participantPreview)
      ? raw.participantPreview
          .map((participant) => {
            if (!participant || typeof participant !== "object") {
              return null;
            }
            const preview = participant as Record<string, unknown>;
            return {
              profileId: getNormalizedStringOrNull(preview.profileId),
              displayName: getNormalizedStringOrNull(preview.displayName),
              emojiId: getNormalizedNumberOrNull(preview.emojiId),
              aura: getNormalizedStringOrNull(preview.aura),
            };
          })
          .filter(
            (
              participant,
            ): participant is NonNullable<
              NavigationEventItem["participantPreview"][number]
            > => !!participant,
          )
      : [];

    return {
      id: id ?? `event_${eventId}`,
      entityType: "event",
      eventId,
      status,
      sortBucket,
      listSortAtMs,
      startAtMs: getNormalizedNumberOrNull(raw.startAtMs),
      updatedAtMs: getNormalizedNumberOrNull(raw.updatedAtMs),
      endedAtMs: getNormalizedNumberOrNull(raw.endedAtMs),
      participantCount:
        getNormalizedNumberOrNull(raw.participantCount) ??
        participantPreview.length,
      participantPreview,
      winnerDisplayName: getNormalizedStringOrNull(raw.winnerDisplayName),
      isFallback: getNormalizedBooleanOrUndefined(raw.isFallback),
      isOptimistic: getNormalizedBooleanOrUndefined(raw.isOptimistic),
    };
  }

  const inviteId = typeof raw.inviteId === "string" ? raw.inviteId : "";
  if (inviteId === "") {
    return null;
  }

  const kind = raw.kind === "auto" || raw.kind === "direct" ? raw.kind : null;
  if (!kind) {
    return null;
  }

  const status =
    isNavigationItemStatus(raw.status) && raw.status !== "dismissed"
      ? raw.status
      : null;
  if (!status) {
    return null;
  }

  const sortBucket =
    typeof raw.sortBucket === "number" && Number.isFinite(raw.sortBucket)
      ? Math.floor(raw.sortBucket)
      : 0;
  const listSortAtMs =
    typeof raw.listSortAtMs === "number" && Number.isFinite(raw.listSortAtMs)
      ? Math.floor(raw.listSortAtMs)
      : 0;
  const opponentEmoji = getNormalizedNumberOrNull(raw.opponentEmoji);
  const automatchStateHint = normalizeStrictAutomatchStateHint(
    raw.automatchStateHint,
  );

  return {
    id: id ?? inviteId,
    entityType: "game",
    inviteId,
    kind,
    status,
    sortBucket,
    listSortAtMs,
    hostLoginId: getNormalizedStringOrNull(raw.hostLoginId),
    guestLoginId: getNormalizedStringOrNull(raw.guestLoginId),
    opponentProfileId: getNormalizedStringOrNull(raw.opponentProfileId),
    opponentName: getNormalizedStringOrNull(raw.opponentName),
    opponentEmoji,
    automatchStateHint,
    isPendingAutomatch:
      typeof raw.isPendingAutomatch === "boolean"
        ? raw.isPendingAutomatch
        : status === "pending",
    isFallback: getNormalizedBooleanOrUndefined(raw.isFallback),
    isOptimistic: getNormalizedBooleanOrUndefined(raw.isOptimistic),
  };
};

const sanitizeNavigationGames = (
  games: unknown,
  options?: { maxItems?: number; excludeOptimistic?: boolean },
): NavigationItem[] => {
  if (!Array.isArray(games)) {
    return [];
  }
  const maxItems = options?.maxItems ?? Number.MAX_SAFE_INTEGER;
  const excludeOptimistic = options?.excludeOptimistic ?? false;
  const uniqueById = new Map<string, NavigationItem>();

  for (const item of games) {
    const normalizedItem = sanitizeNavigationGameItem(item);
    if (!normalizedItem) {
      continue;
    }
    if (excludeOptimistic && normalizedItem.isOptimistic) {
      continue;
    }
    if (!uniqueById.has(normalizedItem.id)) {
      uniqueById.set(normalizedItem.id, normalizedItem);
    }
    if (uniqueById.size >= maxItems) {
      break;
    }
  }

  return Array.from(uniqueById.values());
};

const getPersistedTopCacheStorageKey = (
  scope: NavigationGamesCacheScope,
): string => {
  return `${NAVIGATION_GAMES_PERSISTED_TOP_CACHE_KEY_PREFIX}${scope.scopeKey}`;
};

export const resolveNavigationGamesCacheScope = (
  profileId: string,
  loginId: string,
): NavigationGamesCacheScope | null => {
  if (typeof profileId === "string" && profileId !== "") {
    return {
      kind: "profile",
      scopeId: profileId,
      scopeKey: `profile:${profileId}`,
    };
  }

  if (typeof loginId === "string" && loginId !== "") {
    return {
      kind: "login",
      scopeId: loginId,
      scopeKey: `login:${loginId}`,
    };
  }

  return null;
};

const readPersistedTopCache = (
  scope: NavigationGamesCacheScope,
): NavigationItem[] => {
  const storageKey = getPersistedTopCacheStorageKey(scope);
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as PersistedTopGamesPayload;
    if (!parsed || typeof parsed !== "object") {
      localStorage.removeItem(storageKey);
      return [];
    }

    if (parsed.version !== NAVIGATION_GAMES_PERSISTED_TOP_CACHE_VERSION) {
      localStorage.removeItem(storageKey);
      return [];
    }

    const updatedAtMs =
      typeof parsed.updatedAtMs === "number" &&
      Number.isFinite(parsed.updatedAtMs)
        ? Math.floor(parsed.updatedAtMs)
        : 0;
    if (
      updatedAtMs <= 0 ||
      Date.now() - updatedAtMs > NAVIGATION_GAMES_PERSISTED_TOP_CACHE_TTL_MS
    ) {
      localStorage.removeItem(storageKey);
      return [];
    }

    return sanitizeNavigationGames(parsed.topGames, {
      maxItems: Number.MAX_SAFE_INTEGER,
      excludeOptimistic: true,
    });
  } catch {
    try {
      localStorage.removeItem(storageKey);
    } catch {}
    return [];
  }
};

export const readNavigationGamesCacheSnapshot = (
  scope: NavigationGamesCacheScope | null,
): NavigationGamesCacheSnapshot => {
  if (!scope) {
    return {
      topGames: [],
      pagedGames: [],
    };
  }

  const runtimeEntry = runtimeCacheByScope.get(scope.scopeKey);
  if (runtimeEntry) {
    return {
      topGames: runtimeEntry.topGames.slice(),
      pagedGames: runtimeEntry.pagedGames.slice(),
    };
  }

  return {
    topGames: readPersistedTopCache(scope),
    pagedGames: [],
  };
};

export const writeNavigationGamesRuntimeCache = (
  scope: NavigationGamesCacheScope | null,
  topGames: NavigationItem[],
  pagedGames: NavigationItem[],
): void => {
  if (!scope) {
    return;
  }
  runtimeCacheByScope.set(scope.scopeKey, {
    topGames: sanitizeNavigationGames(topGames, {
      maxItems: NAVIGATION_GAMES_MAX_RUNTIME_ITEMS_PER_SECTION,
    }),
    pagedGames: sanitizeNavigationGames(pagedGames, {
      maxItems: NAVIGATION_GAMES_MAX_RUNTIME_ITEMS_PER_SECTION,
    }),
  });
};

export const writeNavigationGamesPersistedTopCache = (
  scope: NavigationGamesCacheScope | null,
  topGames: NavigationItem[],
  maxItems: number,
): void => {
  if (!scope) {
    return;
  }

  const boundedMaxItems =
    Number.isFinite(maxItems) && maxItems > 0 ? Math.floor(maxItems) : 80;
  const payload: PersistedTopGamesPayload = {
    version: NAVIGATION_GAMES_PERSISTED_TOP_CACHE_VERSION,
    updatedAtMs: Date.now(),
    topGames: sanitizeNavigationGames(topGames, {
      maxItems: boundedMaxItems,
      excludeOptimistic: true,
    }),
  };

  try {
    localStorage.setItem(
      getPersistedTopCacheStorageKey(scope),
      JSON.stringify(payload),
    );
  } catch {}
};

export const clearNavigationGamesRuntimeCacheScope = (
  scopeKey: string,
): void => {
  if (scopeKey === "") {
    return;
  }
  runtimeCacheByScope.delete(scopeKey);
};
