import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { createGameControlsStore } =
  await import("../src/game/gameControlsStore.ts");
const { deriveGameControlsView } =
  await import("../src/game/gameControlsModel.ts");
const { gameControlsReducer } =
  await import("../src/ui/controls/bottomControlsState.ts");
const { deriveBoardViewControls } =
  await import("../src/game/boardViewPolicy.ts");

const config = { duration: 60, progress: 0, requestDate: 1000 };

test("snapshots retain identity until state changes and unsubscribe does not reset state", () => {
  const store = createGameControlsStore(config);
  const initial = store.getSnapshot();
  assert.equal(store.getSnapshot(), initial);
  const snapshots = [];
  const stop = store.subscribe(() => snapshots.push(store.getSnapshot()));
  store.updateContext({ isOnlineGame: false });
  store.updatePresentation({ endMatchVisible: false });
  assert.equal(store.getSnapshot(), initial);
  assert.equal(snapshots.length, 0);
  store.updateContext({ isOnlineGame: true, sessionId: 2 });
  store.updatePresentation({ endMatchVisible: true, endMatchConfirmed: true });
  assert.equal(snapshots.length, 2);
  assert.equal(initial.context.isOnlineGame, false);
  assert.equal(initial.presentation.endMatchVisible, false);
  const retained = store.getSnapshot();
  stop();
  const stopAgain = store.subscribe(() => {});
  assert.equal(store.getSnapshot(), retained);
  store.updateContext({ isOnlineGame: false });
  assert.equal(snapshots.length, 2);
  stopAgain();
});

test("synchronous presentation updates expose current context and preserve unrelated retained controls", () => {
  const store = createGameControlsStore(config);
  const observed = [];
  store.updatePresentation({ endMatchConfirmed: true, homeVisible: true });
  store.subscribe(() => observed.push(store.getSnapshot()));
  store.updateContext({ isWatchOnly: true, isOnlineGame: true });
  store.updatePresentation({ watchOnlyVisible: true });
  store.updateContext({ isWatchOnly: false, isGameWithBot: true });
  store.updatePresentation({ voiceReactionVisible: true });
  const context = observed.at(-1).context;
  assert.equal(context.isWatchOnly, false);
  assert.equal(context.isGameWithBot, true);
  assert.equal(observed.at(-1).presentation.endMatchConfirmed, true);
  assert.equal(observed.at(-1).presentation.homeVisible, true);
});

test("context changes never recreate timer configuration or reset disabled requests", () => {
  const store = createGameControlsStore(config);
  const dispatch = (action) => {
    store.updatePresentation({
      gameControls: gameControlsReducer(
        store.getSnapshot().presentation.gameControls,
        action,
      ),
    });
  };
  const timer = { duration: 60, progress: 15, requestDate: 5000 };
  dispatch({ type: "showTimerProgress", config: timer });
  dispatch({ type: "enableTimer" });
  dispatch({ type: "disableTimer" });
  const gameControls = store.getSnapshot().presentation.gameControls;
  store.updateContext({ isOnlineGame: true, boardViewMode: "historicalView" });
  store.updateContext({ boardViewMode: "activeLive" });
  assert.equal(store.getSnapshot().presentation.gameControls, gameControls);
  assert.deepEqual(gameControls.timer.config, timer);
  assert.equal(gameControls.timer.startEnabled, false);
  dispatch({ type: "showTimerProgress", config: timer });
  assert.notEqual(store.getSnapshot().presentation.gameControls, gameControls);
});

test("waiting and historical policy retain explicit confirmation and local live reaction state", () => {
  const store = createGameControlsStore(config);
  store.updatePresentation({
    endMatchVisible: true,
    endMatchConfirmed: true,
    voiceReactionVisible: true,
  });
  const applyPolicy = (context) => {
    const controls = deriveBoardViewControls({
      mode: "activeLive",
      isOnlineGame: false,
      isWatchOnly: false,
      isGameWithBot: false,
      isGameOver: false,
      isWaitingForRematchResponse: false,
      isSeriesEnded: false,
      ...context,
    });
    store.updatePresentation(
      Object.fromEntries(
        Object.entries(controls).filter(([, value]) => value !== null),
      ),
    );
  };
  applyPolicy({});
  assert.equal(store.getSnapshot().presentation.voiceReactionVisible, true);
  assert.equal(store.getSnapshot().presentation.endMatchConfirmed, true);
  applyPolicy({ mode: "waitingLive", isOnlineGame: true });
  applyPolicy({ mode: "historicalView", isOnlineGame: true });
  assert.equal(store.getSnapshot().presentation.endMatchVisible, false);
  assert.equal(store.getSnapshot().presentation.endMatchConfirmed, true);
  applyPolicy({});
  assert.equal(store.getSnapshot().presentation.endMatchVisible, false);
  assert.equal(store.getSnapshot().presentation.endMatchConfirmed, true);
  assert.equal(store.getSnapshot().presentation.voiceReactionVisible, true);
});

test("view selectors use published role, completion, series and puzzle facts", () => {
  const store = createGameControlsStore(config);
  store.updateContext({ isOnlineGame: true });
  assert.equal(
    deriveGameControlsView(store.getSnapshot()).canWagerInCurrentGame,
    true,
  );
  store.updateContext({
    isWatchOnly: true,
    isGameOver: true,
    isSeriesEnded: true,
  });
  let view = deriveGameControlsView(store.getSnapshot());
  assert.equal(view.canWagerInCurrentGame, false);
  assert.equal(view.isWatchOnlyMatchFinished, true);
  store.updatePresentation({
    gameControls: gameControlsReducer(
      store.getSnapshot().presentation.gameControls,
      {
        type: "setPrimaryAction",
        action: "rematch",
      },
    ),
  });
  store.updateContext({ puzzleMode: true, selectedPuzzleId: "lesson" });
  view = deriveGameControlsView(store.getSnapshot());
  assert.equal(view.primaryActionText, "Next Lesson");
});

test("explicit presentation reset keeps the current context and caller's timer timestamp", () => {
  const store = createGameControlsStore(config);
  store.updateContext({ isOnlineGame: true, sessionId: 7 });
  store.updatePresentation({ endMatchConfirmed: true, waitingText: "waiting" });
  const context = store.getSnapshot().context;
  const resetConfig = { ...config, requestDate: 9000 };
  store.resetPresentation(resetConfig);
  assert.equal(store.getSnapshot().context, context);
  assert.equal(store.getSnapshot().presentation.endMatchConfirmed, false);
  assert.equal(store.getSnapshot().presentation.waitingText, "");
  assert.deepEqual(
    store.getSnapshot().presentation.gameControls.timer.config,
    resetConfig,
  );
});

test("compatibility presentation commands remain no-ops without a mounted owner", async () => {
  const { getGameControlsSnapshot } =
    await import("../src/game/gameControlsStore.ts");
  const port = await import("../src/ui/controls/bottomControlsPort.ts");
  const before = getGameControlsSnapshot();
  port.setHomeVisible(true);
  port.showResignButton();
  port.showTimerButtonProgressing(10, 20, true);
  port.setIsReadyToCopyExistingInviteLink();
  assert.equal(getGameControlsSnapshot(), before);
});
