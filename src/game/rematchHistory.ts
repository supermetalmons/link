import type { HistoricalMatchPair } from "../connection/connectionModels";

export const HISTORICAL_MATCH_RETRY_DELAY_MS = 250;
const HISTORICAL_MATCH_MISS_COOLDOWN_MS = 3000;

export type RematchHistoryScore = { white: number; black: number };

type RematchHistoryDependencies = {
  loadMatchPair: (matchId: string) => Promise<HistoricalMatchPair | null>;
  scoreFromPair: (
    matchId: string,
    pair: HistoricalMatchPair,
  ) => RematchHistoryScore | null;
  createSessionGuard: () => () => boolean;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (timeoutId: number) => void;
  now?: () => number;
};

type ArchiveRefreshOptions = {
  isCurrent: () => boolean;
  onRefresh: (pair: HistoricalMatchPair) => void;
  onError: (error: unknown) => void;
};

export const createRematchHistory = (
  dependencies: RematchHistoryDependencies,
) => {
  const now = dependencies.now ?? Date.now;
  const pairs = new Map<string, HistoricalMatchPair>();
  const provisionalIds = new Set<string>();
  const scores = new Map<string, RematchHistoryScore>();
  const missesUntil = new Map<string, number>();
  const refreshTimeouts = new Set<number>();
  let generation = 0;
  let prefetch: { signature: string; promise: Promise<boolean> } | null = null;

  const createGuard = () => {
    const expectedGeneration = generation;
    const sessionGuard = dependencies.createSessionGuard();
    return () => expectedGeneration === generation && sessionGuard();
  };

  const setScore = (matchId: string, score: RematchHistoryScore): boolean => {
    const previous = scores.get(matchId);
    if (
      previous &&
      previous.white === score.white &&
      previous.black === score.black
    ) {
      return false;
    }
    scores.set(matchId, score);
    return true;
  };

  const cacheScore = (matchId: string, pair: HistoricalMatchPair): boolean => {
    const score = dependencies.scoreFromPair(matchId, pair);
    return score ? setScore(matchId, score) : false;
  };

  const hasRecentMiss = (matchId: string): boolean =>
    (missesUntil.get(matchId) ?? 0) > now();

  const load = async (
    matchId: string,
    options?: { forceRefresh?: boolean },
  ): Promise<HistoricalMatchPair | null> => {
    const forceRefresh = options?.forceRefresh === true;
    const cachedPair = pairs.get(matchId) ?? null;
    const provisional = provisionalIds.has(matchId);
    if (!forceRefresh && cachedPair && !provisional) return cachedPair;
    if (!forceRefresh) {
      if (hasRecentMiss(matchId)) return provisional ? cachedPair : null;
      missesUntil.delete(matchId);
    }
    const isCurrent = createGuard();
    let pair: HistoricalMatchPair | null = null;
    try {
      pair = await dependencies.loadMatchPair(matchId);
    } catch {
      pair = null;
    }
    if (!isCurrent()) return null;
    if (pair) {
      pairs.set(matchId, pair);
      provisionalIds.delete(matchId);
      missesUntil.delete(matchId);
      cacheScore(matchId, pair);
      return pair;
    }
    const latestPair = pairs.get(matchId) ?? null;
    if (latestPair && !provisionalIds.has(matchId)) return latestPair;
    missesUntil.set(matchId, now() + HISTORICAL_MATCH_MISS_COOLDOWN_MS);
    return forceRefresh || provisional ? latestPair : null;
  };

  const refreshArchive = (
    matchId: string,
    options: ArchiveRefreshOptions,
  ): void => {
    if (!provisionalIds.has(matchId)) return;
    const sessionGuard = createGuard();
    const isCurrent = () => sessionGuard() && options.isCurrent();
    const schedule = (delay: number) => {
      const timeoutId = dependencies.setTimeout(() => {
        refreshTimeouts.delete(timeoutId);
        if (!isCurrent()) return;
        void load(matchId, { forceRefresh: true })
          .then((pair) => {
            if (!isCurrent()) return;
            if (provisionalIds.has(matchId)) {
              schedule(HISTORICAL_MATCH_MISS_COOLDOWN_MS);
            } else if (pair) {
              options.onRefresh(pair);
            }
          })
          .catch(options.onError);
      }, delay);
      refreshTimeouts.add(timeoutId);
    };
    schedule(HISTORICAL_MATCH_RETRY_DELAY_MS);
  };

  const prefetchScores = (
    activeMatchId: string | null,
    matchIds: string[],
    onScoreChanged: () => void,
  ): Promise<boolean> => {
    const signature = `${activeMatchId ?? ""}|${matchIds.join("|")}`;
    if (prefetch?.signature === signature) return prefetch.promise;
    const isCurrent = createGuard();
    const request = (async () => {
      let didChange = false;
      const pendingIds = matchIds.filter((matchId) => !scores.has(matchId));
      let nextIndex = 0;
      const worker = async () => {
        while (isCurrent() && nextIndex < pendingIds.length) {
          const matchId = pendingIds[nextIndex++];
          if (!matchId || scores.has(matchId)) continue;
          const hadScore = scores.has(matchId);
          const pair = await load(matchId);
          if (!isCurrent()) return;
          if (!pair) continue;
          const hasScore = scores.has(matchId);
          const changedScore = cacheScore(matchId, pair);
          if ((!hadScore && hasScore) || changedScore) {
            didChange = true;
            onScoreChanged();
          }
        }
      };
      await Promise.all([worker(), worker()]);
      return isCurrent() && didChange;
    })().finally(() => {
      if (prefetch?.promise === request) prefetch = null;
    });
    prefetch = { signature, promise: request };
    return request;
  };

  return {
    getCachedPair: (matchId: string) => pairs.get(matchId) ?? null,
    isProvisional: (matchId: string) => provisionalIds.has(matchId),
    hasRecentMiss,
    seedProvisional: (pair: HistoricalMatchPair): void => {
      if (pairs.has(pair.matchId) && !provisionalIds.has(pair.matchId)) return;
      pairs.set(pair.matchId, pair);
      provisionalIds.add(pair.matchId);
      missesUntil.delete(pair.matchId);
    },
    getScore: (matchId: string) => scores.get(matchId),
    setScore,
    deleteScore: (matchId: string): void => {
      scores.delete(matchId);
    },
    load,
    refreshArchive,
    prefetchScores,
    reset: (): void => {
      generation += 1;
      pairs.clear();
      provisionalIds.clear();
      scores.clear();
      missesUntil.clear();
      refreshTimeouts.forEach(dependencies.clearTimeout);
      refreshTimeouts.clear();
      prefetch = null;
    },
  };
};
