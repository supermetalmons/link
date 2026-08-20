import "./session/pendingLogoutWipeBootstrap";
import "./index.css";
import ReactDOM from "react-dom/client";
import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

import "./ui/ShinyCard";
import BoardComponent from "./ui/BoardComponent";
import MainMenu, {
  closeAllKindsOfPopups,
  TopRightControls,
} from "./ui/MainMenu";
import { useAuthStatus } from "./connection/authentication";
import { connection } from "./connection/connection";
import BottomControls from "./ui/BottomControls";
import { isMobile } from "./utils/misc";
import { preventTouchstartIfNeeded } from "./runtime/touchInputGuard";
import { preloadSounds } from "./content/sounds";
import { soundPlayer } from "./utils/SoundPlayer";
import ProfileSignIn, {
  handleLogout,
  isLogoutUiLocked,
  showSettings,
  subscribeToLogoutUiLock,
} from "./ui/ProfileSignIn";
import EventModal from "./ui/EventModal";
import { isMainGameLoaded, onMainGameLoaded } from "./game/mainGameLoadState";
import { Sound } from "./utils/gameModels";
import { initializeAppSessionManager } from "./session/AppSessionManager";
import { getCurrentRouteState } from "./navigation/routeState";
import { installLogoutSync } from "./session/logoutOrchestrator";
import { bindGameConnection } from "./game/gameConnectionPort";
import {
  getIsMuted,
  persistMuteState,
  setIsMuted,
  subscribeToMuteState,
} from "./runtime/muteStore";
import {
  bindIslandButtonDimmer,
  setIslandButtonDimmed,
} from "./runtime/islandButtonPort";
import { bindMiningConnection } from "./island/miningConnectionPort";
import {
  didClickAndChangePlayerEmoji,
  didUpdateIdCardMons,
  setAnimatedMonsEnabled,
  updateEmojiAndAuraIfNeeded,
} from "./game/board";
import { isWatchOnly } from "./game/gameController";
import { updateProfileDisplayName } from "./ui/identity/profileUiPort";
import { syncTutorialProgress } from "./content/problems";
import { syncOwnProfileMiningState } from "./services/ownProfileMiningHydration";
import { bindPlayerMetadataRuntime } from "./utils/playerMetadataRuntimePort";
import { bindProfileSurfaceData } from "./ui/profileSurfaceDataPort";
import { bindMainMenuRuntime } from "./ui/mainMenuRuntimePort";
import { bindShinyCardRuntime } from "./ui/shinyCardRuntimePort";
import { bindTutorialPersistence } from "./content/tutorialPersistencePort";

bindGameConnection(connection);
bindMiningConnection(connection);
bindTutorialPersistence({
  updateCompletedProblems: (problemIds) =>
    connection.updateCompletedProblems(problemIds),
  updateTutorialCompleted: (completed) =>
    connection.updateTutorialCompleted(completed),
});
bindPlayerMetadataRuntime({
  createSessionGuard: () => connection.createSessionGuard(),
  getProfileByLoginId: (loginId) => connection.getProfileByLoginId(loginId),
  updateEmoji: (newId, matchOnly, aura) =>
    connection.updateEmoji(newId, matchOnly, aura),
  updateEmojiAndAuraIfNeeded,
  isWatchOnly: () => isWatchOnly,
  updateProfileDisplayName,
  syncTutorialProgress,
  syncOwnProfileMiningState,
});
bindProfileSurfaceData({
  createEvent: (schedule, options) => connection.createEvent(schedule, options),
  getLeaderboard: (type) => connection.getLeaderboard(type),
  subscribeToProfileEventPrizes: (profileId, onUpdate, onError) =>
    connection.subscribeToProfileEventPrizes(profileId, onUpdate, onError),
  withdrawEventPrize: (eventId, prizeId, solanaAddress) =>
    connection.withdrawEventPrize(eventId, prizeId, solanaAddress),
});
bindMainMenuRuntime({ setAnimatedMonsEnabled });
bindShinyCardRuntime({
  updateProfileCounter: (counter) => connection.updateProfileCounter(counter),
  updateCardBackgroundId: (id) => connection.updateCardBackgroundId(id),
  updateCardSubtitleId: (id) => connection.updateCardSubtitleId(id),
  updateProfileMons: (mons) => connection.updateProfileMons(mons),
  updateCardStickers: (stickers) => connection.updateCardStickers(stickers),
  didClickAndChangePlayerEmoji,
  didUpdateIdCardMons,
});

const LazyIslandButton = lazy(() => import("./ui/IslandButton"));

export { getIsMuted, setIslandButtonDimmed };

const App = () => {
  const { authState } = useAuthStatus();
  const { authStatus } = authState;
  const isMuted = useSyncExternalStore(
    subscribeToMuteState,
    getIsMuted,
    getIsMuted,
  );
  const [isIslandButtonDim, setIsIslandButtonDim] = useState(() => {
    const routeState = getCurrentRouteState();
    return routeState.mode !== "home" && routeState.mode !== "event";
  });
  const [shouldLoadIslandButton, setShouldLoadIslandButton] =
    useState(isMainGameLoaded());
  const [isLogoutUiLockedState, setIsLogoutUiLockedState] = useState(() =>
    isLogoutUiLocked(),
  );
  const shouldHideAuthControls =
    authStatus === "loading" || isLogoutUiLockedState;

  bindIslandButtonDimmer((dimmed: boolean) => {
    setIsIslandButtonDim(dimmed);
  });

  useEffect(() => {
    persistMuteState();
  }, [isMuted]);

  useEffect(() => {
    if (shouldLoadIslandButton) {
      return;
    }
    const unsubscribe = onMainGameLoaded(() => {
      setShouldLoadIslandButton(true);
      preloadSounds([Sound.IslandShowUp]).catch(() => {});
    });
    return unsubscribe;
  }, [shouldLoadIslandButton]);

  useEffect(() => {
    return subscribeToLogoutUiLock((isLocked) => {
      setIsLogoutUiLockedState(isLocked);
    });
  }, []);

  const handleMuteToggle = useCallback(() => {
    const nextIsMuted = !isMuted;
    setIsMuted(nextIsMuted);
    if (!nextIsMuted) {
      void soundPlayer.initializeOnUserInteraction(true);
    }
  }, [isMuted]);

  return (
    <div className="app-container">
      <div className="top-buttons-container">
        {!shouldHideAuthControls && shouldLoadIslandButton && (
          <Suspense fallback={null}>
            <LazyIslandButton dimmed={isIslandButtonDim} />
          </Suspense>
        )}
        <TopRightControls
          authState={authState}
          isVisible={!shouldHideAuthControls}
          isMuted={isMuted}
          onBeforeOpen={closeAllKindsOfPopups}
          onToggleMute={handleMuteToggle}
          onOpenSettings={showSettings}
          onRequestLogout={handleLogout}
        />
        {!shouldHideAuthControls && <ProfileSignIn authState={authState} />}
      </div>
      <BoardComponent />
      <MainMenu />
      <BottomControls authState={authState} />
      <EventModal />
    </div>
  );
};

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement,
);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if (isMobile) {
  document.addEventListener(
    "touchstart",
    (e) => {
      preventTouchstartIfNeeded(e);
    },
    { passive: false },
  );
}

document.addEventListener(
  "contextmenu",
  function (e) {
    e.preventDefault();
  },
  false,
);

connection.signIn();
installLogoutSync();
initializeAppSessionManager();
