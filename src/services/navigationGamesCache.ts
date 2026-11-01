import { applicationStorageKey } from "../session/applicationDataStorage.ts";
import type { NavigationItem } from "../connection/connectionModels";
import { isNavigationItem } from "@mons/shared/navigation";

export interface NavigationGamesCacheScope {
  kind: "profile";
  scopeId: string;
  scopeKey: string;
}

interface NavigationGamesRuntimeEntry {
  topGames: NavigationItem[];
  pagedGames: NavigationItem[];
}

interface PersistedTopGamesPayload {
  version: 3;
  updatedAtMs: number;
  topGames: NavigationItem[];
}

interface NavigationGamesCacheSnapshot {
  topGames: NavigationItem[];
  pagedGames: NavigationItem[];
}

const NAVIGATION_GAMES_PERSISTED_TOP_CACHE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const NAVIGATION_GAMES_PERSISTED_TOP_CACHE_VERSION = 3;
const NAVIGATION_GAMES_PERSISTED_TOP_CACHE_KEY_PREFIX = applicationStorageKey(
  "navigationGamesTopCache:",
);
const NAVIGATION_GAMES_MAX_RUNTIME_ITEMS_PER_SECTION = 500;

const runtimeCacheByScope = new Map<string, NavigationGamesRuntimeEntry>();

const readCanonicalNavigationItem = (value: unknown): NavigationItem | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const { isOptimistic, ...item } = fields;
  if (isOptimistic !== undefined && typeof isOptimistic !== "boolean")
    return null;
  if (!isNavigationItem(item)) return null;
  return {
    ...item,
    ...(item.entityType === "event"
      ? {
          participantPreview: item.participantPreview.map((participant) => ({
            ...participant,
          })),
        }
      : {}),
    ...(isOptimistic !== undefined ? { isOptimistic } : {}),
  };
};

const selectCanonicalNavigationGames = (
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
    const normalizedItem = readCanonicalNavigationItem(item);
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
): NavigationGamesCacheScope | null => {
  if (typeof profileId === "string" && profileId !== "") {
    return {
      kind: "profile",
      scopeId: profileId,
      scopeKey: `profile:${profileId}`,
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

    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 3
    ) {
      localStorage.removeItem(storageKey);
      return [];
    }

    const fields = parsed as {
      version?: unknown;
      updatedAtMs?: unknown;
      topGames?: unknown;
    };
    if (fields.version !== NAVIGATION_GAMES_PERSISTED_TOP_CACHE_VERSION) {
      localStorage.removeItem(storageKey);
      return [];
    }

    const updatedAtMs =
      typeof fields.updatedAtMs === "number" &&
      Number.isSafeInteger(fields.updatedAtMs)
        ? fields.updatedAtMs
        : 0;
    if (
      updatedAtMs <= 0 ||
      Date.now() - updatedAtMs > NAVIGATION_GAMES_PERSISTED_TOP_CACHE_TTL_MS
    ) {
      localStorage.removeItem(storageKey);
      return [];
    }

    return selectCanonicalNavigationGames(fields.topGames, {
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
    topGames: selectCanonicalNavigationGames(topGames, {
      maxItems: NAVIGATION_GAMES_MAX_RUNTIME_ITEMS_PER_SECTION,
    }),
    pagedGames: selectCanonicalNavigationGames(pagedGames, {
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
    topGames: selectCanonicalNavigationGames(topGames, {
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
