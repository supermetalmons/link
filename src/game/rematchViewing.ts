import * as MonsRules from "mons-rules";
import type {
  HistoricalMatchPair,
  RematchSeriesDescriptor,
} from "../connection/connectionModels";
import type { StoredGameVariant } from "./gameVariants";
import {
  createRematchHistory,
  HISTORICAL_MATCH_RETRY_DELAY_MS,
} from "./rematchHistory";

export type ViewedRematch = {
  readonly matchId: string;
  readonly pair: HistoricalMatchPair;
  readonly game: MonsRules.Game;
};

export type RematchSelectionRequest = {
  readonly isCurrent: () => boolean;
};

export type LocalRematchSnapshot = {
  matchId: string;
  index: number;
  gameVariant: StoredGameVariant;
  gameModel: MonsRules.Game;
  fen: string;
  whiteScore: number;
  blackScore: number;
  boardFlipped: boolean;
  resignedColor: "white" | "black" | null;
};

type LocalMatchSnapshotInput = Pick<
  LocalRematchSnapshot,
  "gameVariant" | "gameModel" | "boardFlipped" | "resignedColor"
>;

type RematchViewingDependencies = {
  loadMatchPair: (matchId: string) => Promise<HistoricalMatchPair | null>;
  buildHistoricalGame: (
    matchId: string,
    pair: HistoricalMatchPair,
  ) => MonsRules.Game | null;
  countRecordedMoves: (matchId: string, pair: HistoricalMatchPair) => number;
  createSessionGuard: () => () => boolean;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (timeoutId: number) => void;
  wait: (delay: number) => Promise<void>;
  now?: () => number;
};

const createLocalRematchSeries = () => {
  let nextSeriesId = 1;
  let inviteId: string | null = null;
  let activeMatchId: string | null = null;
  const matchIds: string[] = [];
  const snapshots = new Map<string, LocalRematchSnapshot>();

  const ensure = (): void => {
    if (inviteId && activeMatchId && matchIds.length > 0) return;
    inviteId = `local-${nextSeriesId++}`;
    activeMatchId = inviteId;
    matchIds.length = 0;
    matchIds.push(activeMatchId);
  };

  const descriptor = (): RematchSeriesDescriptor | null => {
    if (!inviteId || !activeMatchId || matchIds.length === 0) return null;
    return {
      inviteId,
      activeMatchId,
      hasSeries: matchIds.length > 1,
      matches: matchIds.map((matchId, index) => ({
        index,
        matchId,
        isActiveMatch: matchId === activeMatchId,
        isPendingResponse: false,
      })),
    };
  };

  const snapshot = (input: LocalMatchSnapshotInput): LocalRematchSnapshot => {
    ensure();
    const matchId = activeMatchId!;
    const value = {
      ...input,
      matchId,
      index: matchIds.indexOf(matchId),
      fen: input.gameModel.toFen(),
      whiteScore: input.gameModel.scores[MonsRules.Color.White],
      blackScore: input.gameModel.scores[MonsRules.Color.Black],
    };
    snapshots.set(matchId, value);
    return value;
  };

  return {
    ensure,
    descriptor,
    snapshot,
    getSnapshot: (matchId: string) => snapshots.get(matchId) ?? null,
    advance: (): string => {
      ensure();
      activeMatchId = `${inviteId}${matchIds.length}`;
      matchIds.push(activeMatchId);
      return activeMatchId;
    },
    reset: (): void => {
      inviteId = null;
      activeMatchId = null;
      matchIds.length = 0;
      snapshots.clear();
    },
  };
};

const buildLocalHistoricalPair = (
  snapshot: LocalRematchSnapshot,
  localPlayerUid: string | null,
): HistoricalMatchPair => ({
  matchId: snapshot.matchId,
  hostPlayerId: localPlayerUid || "local",
  guestPlayerId: null,
  hostMatch: {
    schemaVersion: 1,
    version: 1,
    color: snapshot.resignedColor ?? "white",
    emojiId: 0,
    aura: "none",
    gameVariant: snapshot.gameVariant,
    fen: snapshot.fen,
    status: snapshot.resignedColor ? "surrendered" : "active",
    flatMovesString: "",
    timer: { state: "idle" },
  },
  guestMatch: null,
});

const mergeHistoricalMatchPresentation = (
  pair: HistoricalMatchPair,
  archivedPair: HistoricalMatchPair,
): HistoricalMatchPair => {
  const merged = { ...pair };
  for (const side of ["hostMatch", "guestMatch"] as const) {
    const match = pair[side];
    const actorUid =
      side === "hostMatch" ? pair.hostPlayerId : pair.guestPlayerId;
    const appearance =
      actorUid === archivedPair.hostPlayerId
        ? archivedPair.hostMatch
        : actorUid === archivedPair.guestPlayerId
          ? archivedPair.guestMatch
          : null;
    if (match && appearance) {
      merged[side] = {
        ...match,
        emojiId: appearance.emojiId,
        aura: appearance.aura,
      };
    }
  }
  return merged;
};

const moveHistoryEntitiesCount = (game: MonsRules.Game): number => {
  try {
    return game.trackingEntries.length;
  } catch {
    return 0;
  }
};

export const createRematchViewing = (
  dependencies: RematchViewingDependencies,
) => {
  let selection: ViewedRematch | null = null;
  let requestGeneration = 0;
  let displayedGeneration = 0;
  const localSeries = createLocalRematchSeries();
  const history = createRematchHistory({
    ...dependencies,
    scoreFromPair: (matchId, pair) => {
      const game = dependencies.buildHistoricalGame(matchId, pair);
      return game
        ? {
            white: game.scores[MonsRules.Color.White],
            black: game.scores[MonsRules.Color.Black],
          }
        : null;
    },
  });

  const clearSelection = (): void => {
    requestGeneration += 1;
    displayedGeneration += 1;
    selection = null;
  };

  const beginSelection = (
    isRenderCurrent: () => boolean,
  ): RematchSelectionRequest => {
    const generation = ++requestGeneration;
    const isSessionCurrent = dependencies.createSessionGuard();
    return {
      isCurrent: () =>
        generation === requestGeneration &&
        isSessionCurrent() &&
        isRenderCurrent(),
    };
  };

  const shouldPreferRefreshedData = (
    matchId: string,
    pair: HistoricalMatchPair,
    game: MonsRules.Game,
    refreshedPair: HistoricalMatchPair,
    refreshedGame: MonsRules.Game,
  ): boolean => {
    const count = moveHistoryEntitiesCount(game);
    const refreshedCount = moveHistoryEntitiesCount(refreshedGame);
    if (refreshedCount !== count) return refreshedCount > count;
    if (refreshedGame.turnNumber !== game.turnNumber) {
      return refreshedGame.turnNumber > game.turnNumber;
    }
    return (
      dependencies.countRecordedMoves(matchId, refreshedPair) >
      dependencies.countRecordedMoves(matchId, pair)
    );
  };

  const loadSelection = async (
    request: RematchSelectionRequest,
    matchId: string,
    source: { online: boolean; localPlayerUid: string | null },
  ): Promise<ViewedRematch | null> => {
    if (!request.isCurrent()) return null;
    if (!source.online) {
      const snapshot = localSeries.getSnapshot(matchId);
      return snapshot
        ? {
            matchId,
            pair: buildLocalHistoricalPair(snapshot, source.localPlayerUid),
            game: snapshot.gameModel,
          }
        : null;
    }
    const hadRecentMiss = history.hasRecentMiss(matchId);
    let pair = await history.load(matchId);
    if (!request.isCurrent()) return null;
    if (!pair && !hadRecentMiss) {
      pair = await history.load(matchId, { forceRefresh: true });
    }
    if (!request.isCurrent() || !pair) return null;
    let game = dependencies.buildHistoricalGame(matchId, pair);
    if (!game || !request.isCurrent()) return null;
    const historyCount = moveHistoryEntitiesCount(game);
    if (
      historyCount <= 1 &&
      dependencies.countRecordedMoves(matchId, pair) > historyCount
    ) {
      await dependencies.wait(HISTORICAL_MATCH_RETRY_DELAY_MS);
      if (!request.isCurrent()) return null;
      const refreshedPair = await history.load(matchId, { forceRefresh: true });
      if (!request.isCurrent()) return null;
      if (refreshedPair) {
        const refreshedGame = dependencies.buildHistoricalGame(
          matchId,
          refreshedPair,
        );
        if (
          refreshedGame &&
          shouldPreferRefreshedData(
            matchId,
            pair,
            game,
            refreshedPair,
            refreshedGame,
          )
        ) {
          pair = refreshedPair;
          game = refreshedGame;
        } else if (!history.isProvisional(matchId)) {
          pair = mergeHistoricalMatchPresentation(pair, refreshedPair);
        }
      }
    }
    return { matchId, pair, game };
  };

  const snapshotLocalMatch = (
    input: LocalMatchSnapshotInput,
  ): LocalRematchSnapshot => {
    const snapshot = localSeries.snapshot(input);
    history.setScore(snapshot.matchId, {
      white: snapshot.whiteScore,
      black: snapshot.blackScore,
    });
    return snapshot;
  };

  return {
    getSelection: (): ViewedRematch | null => selection,
    beginSelection,
    loadSelection,
    commitSelection: (
      request: RematchSelectionRequest,
      nextSelection: ViewedRematch,
    ): boolean => {
      if (!request.isCurrent()) return false;
      displayedGeneration += 1;
      selection = nextSelection;
      return true;
    },
    getCachedSelection: (matchId: string): ViewedRematch | null => {
      const pair = history.getCachedPair(matchId);
      if (!pair) return null;
      const game = dependencies.buildHistoricalGame(matchId, pair);
      return game ? { matchId, pair, game } : null;
    },
    clearSelection,
    refreshSelectedArchive: (
      isDisplayed: () => boolean,
      onAppearanceChanged: () => void,
      onError: (error: unknown) => void,
    ): void => {
      if (!selection) return;
      const { matchId } = selection;
      const generation = displayedGeneration;
      history.refreshArchive(matchId, {
        isCurrent: () =>
          generation === displayedGeneration &&
          selection?.matchId === matchId &&
          isDisplayed(),
        onRefresh: (pair) => {
          if (!selection) return;
          selection = {
            ...selection,
            pair: mergeHistoricalMatchPresentation(selection.pair, pair),
          };
          onAppearanceChanged();
        },
        onError,
      });
    },
    seedProvisional: history.seedProvisional,
    getScore: history.getScore,
    setScore: history.setScore,
    prefetchScores: history.prefetchScores,
    ensureLocalSeries: localSeries.ensure,
    getLocalSeriesDescriptor: localSeries.descriptor,
    getLocalSnapshot: localSeries.getSnapshot,
    resetLocalSeries: localSeries.reset,
    advanceLocalSeries: (input: LocalMatchSnapshotInput): void => {
      snapshotLocalMatch(input);
      history.deleteScore(localSeries.advance());
    },
    reset: (): void => {
      clearSelection();
      history.reset();
      localSeries.reset();
    },
  };
};
