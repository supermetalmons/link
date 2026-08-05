import { closeTransientUi } from "../ui/uiSession";
import { disposeGameSession } from "../game/gameController";
import { disposeBoardRuntime } from "../game/board";
import { connection } from "../connection/connection";
import { resetWagerStore } from "../game/wagerState";
import { resetMainGameLoadedState } from "../game/mainGameLoadState";
import { resetWagerMaterialsState } from "../services/wagerMaterialsService";
import { resetProfileMiningState } from "../services/rocksMiningService";
import { resetNftCache } from "../services/nftService";
import { resetPlayerMetadataCaches } from "../utils/playerMetadata";
import { resetEnsCache } from "../utils/ensResolver";
import { resetLeaderboardCache } from "../ui/Leaderboard";
import { getLifecycleCounters } from "./lifecycleDiagnostics";
import type { RouteState } from "../navigation/routeState";

const reportMatchScopeCounterDrift = () => {
  if (import.meta.env.PROD) {
    return;
  }
  const counters = getLifecycleCounters();
  const drift = {
    connectionObservers: counters.connectionObservers,
    boardDomListeners: counters.boardDomListeners,
    boardIntervals: counters.boardIntervals,
    boardTimeouts: counters.boardTimeouts,
    boardRaf: counters.boardRaf,
    gameTimeouts: counters.gameTimeouts,
    uiTimeouts: counters.uiTimeouts,
  };
  const hasDrift = Object.values(drift).some((value) => value !== 0);
  if (hasDrift) {
    console.warn("match-scope-counters-not-baseline", drift);
  }
};

export const teardownMatchScope = (nextRouteState?: RouteState) => {
  closeTransientUi();
  disposeGameSession(nextRouteState);
  disposeBoardRuntime();
  connection.beginMatchSessionTeardown();
  connection.detachFromMatchSession();
  resetWagerStore();
  resetWagerMaterialsState();
  resetMainGameLoadedState();
  reportMatchScopeCounterDrift();
};

export const teardownProfileScope = () => {
  connection.detachFromProfileSession();
  resetProfileMiningState();
  resetNftCache();
  resetPlayerMetadataCaches();
  resetEnsCache();
  resetLeaderboardCache();
};
