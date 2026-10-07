import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";
import { deriveBoardViewControls } from "../src/game/boardViewPolicy.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      specifier.startsWith("./") &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { createGameControlsState, gameControlsReducer } =
  await import("../src/ui/controls/bottomControlsState.ts");
const timerConfig = { duration: 60, progress: 15, requestDate: 1000 };

const source = ts.createSourceFile(
  "gameController.ts",
  readFileSync(
    new URL("../src/game/gameController.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const declarations = [
  "publishGameControlsContext",
  "clearViewedRematchState",
  "nextBoardRenderSession",
  "isBoardRenderSessionActive",
  "applyBoardViewGameControlPolicy",
  "applyBoardUiForCurrentView",
  "clearBoardViewInputs",
  "prepareLiveBoardView",
  "enterWaitingLiveView",
  "restoreLiveBoardView",
  "prepareForNewLocalLiveMatch",
  "enterHistoricalView",
  "ensureBoardViewInvariants",
  "didSelectVerboseTrackingEntity",
].map((name) => {
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(declaration, name);
  return declaration.getText(source).replace(/^export /, "");
});

function harness(
  overrides = {},
  initialControls = createGameControlsState(timerConfig),
) {
  const events = [];
  const contexts = [];
  let gameControls = initialControls;
  const initial = {
    selectedProblem: null,
    puzzleMode: false,
    boardViewMode: "historicalView",
    isOnlineGame: true,
    isWatchOnly: false,
    isGameWithBot: false,
    isGameOver: true,
    isWaitingForRematchResponse: false,
    isReconnect: false,
    boardViewDebugLogsEnabled: false,
    boardRenderSessionId: 5,
    displayedHistoryViewId: 2,
    viewedRematchRequestToken: 3,
    viewedRematchMatchId: "old",
    viewedRematchPair: { matchId: "old" },
    viewedRematchGame: { id: "old" },
    flashbackMode: true,
    flashbackStateGame: { id: "old" },
    currentInputs: ["selected"],
    moveHistoryFlipOverrideEnabled: true,
    moveHistoryFlipOverrideSessionId: 5,
    moveHistoryFlipOverrideBaseBoardFlipped: false,
    pendingTimerResolutionOnRestore: true,
    game: { winner: undefined },
    ...overrides,
  };
  let api;
  const record =
    (name) =>
    (...args) =>
      events.push({ name, args, state: api.state() });
  const board = Object.fromEntries(
    [
      "setBoardMetadataDisplaySwapped",
      "setBoardFlipped",
      "removeHighlights",
      "hideItemSelectionOrConfirmationOverlay",
      "stopMonsBoardAsDisplayAnimations",
      "runMonsBoardAsDisplayWaitingAnimation",
      "showBoardPlayersInfo",
      "hideBoardPlayersInfo",
      "hideTimerCountdownDigits",
      "hideAllMoveStatuses",
    ].map((name) => [name, record(name)]),
  );
  board.hasMonsBoardDisplayAnimationRunning = () => false;
  const dependencies = {
    getCurrentSessionId: () => 1,
    isGameConnectionBound: () => false,
    updateGameControlsContext: (context) => contexts.push(context),
    initial,
    deriveBoardViewControls,
    Board: board,
    connection: {
      setWagerViewMatchId: record("wagerView"),
      rematchSeriesEndIsIndicated: () => true,
    },
    activeBoardShouldBeFlipped: () => false,
    getViewedMatchBoardFlipped: () => true,
    getTimerMatchIdCandidate: () => "live",
    applyTimerStateFromStashes: (...args) => {
      record("restoreTimer")(...args);
      return true;
    },
    MonsRules: { Game: { fromFen: (fen) => ({ fen }) } },
    getMoveHistorySourceGame: () => ({
      trackingEntries: [{ fen: "earlier" }, { fen: "latest" }],
    }),
    ...Object.fromEntries(
      [
        "clearTimerVictoryClaimTimeout",
        "setEndMatchVisible",
        "setEndMatchConfirmed",
        "showVoiceReactionButton",
        "disableAndHideUndoResignAndTimerControls",
        "hideTimerButtons",
        "showWaitingStateText",
        "setAutomoveActionVisible",
        "setUndoVisible",
        "setUndoEnabled",
        "syncInviteBotIntoLocalGameButton",
        "refreshDisplayedMatchPresentation",
        "triggerMoveHistoryPopupReload",
        "setNewBoard",
        "applyWagerState",
        "markKnownWagerInitialStateReceived",
        "updateUndoButtonBasedOnGameState",
        "scheduleHistoricalMatchArchiveRefresh",
        "updateWagerDisplayForMoveNavigation",
      ].map((name) => [name, record(name)]),
    ),
  };
  for (const [name, action] of [
    [
      "disableAndHideUndoResignAndTimerControls",
      () => ({ type: "hideGameControls" }),
    ],
    [
      "setAutomoveActionVisible",
      (visible) => ({ type: "setAutomoveVisible", visible }),
    ],
    ["setUndoVisible", (visible) => ({ type: "setUndoVisible", visible })],
    ["setUndoEnabled", (enabled) => ({ type: "setUndoEnabled", enabled })],
    ["hideTimerButtons", () => ({ type: "hideTimers" })],
  ]) {
    dependencies[name] = (...args) => {
      record(name)(...args);
      gameControls = gameControlsReducer(gameControls, action(...args));
    };
  }
  const { outputText } = ts.transpileModule(
    `${Object.keys(initial)
      .map((name) => `let ${name} = initial.${name};`)
      .join("\n")}
    ${declarations.join("\n")}
    function state() { return { ${Object.keys(initial).join(", ")} }; }
    return {
      state,
      wait: enterWaitingLiveView,
      restore: restoreLiveBoardView,
      prepareLocal: prepareForNewLocalLiveMatch,
      history: enterHistoricalView,
      applyUi: applyBoardUiForCurrentView,
      selectMove: didSelectVerboseTrackingEntity,
    };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  );
  api = new Function(...Object.keys(dependencies), outputText)(
    ...Object.values(dependencies),
  );
  return {
    ...api,
    contexts,
    events,
    controls: () => gameControls,
    names: () => events.map(({ name }) => name),
  };
}

function assertLivePreparation(h, mode) {
  const state = h.state();
  assert.equal(state.boardViewMode, mode);
  assert.equal(state.boardRenderSessionId, 6);
  assert.equal(state.displayedHistoryViewId, 3);
  assert.equal(state.viewedRematchRequestToken, 4);
  assert.equal(state.viewedRematchMatchId, null);
  assert.equal(state.viewedRematchPair, null);
  assert.equal(state.viewedRematchGame, null);
  assert.equal(state.flashbackMode, false);
  assert.equal(state.moveHistoryFlipOverrideEnabled, false);
  assert.deepEqual(state.currentInputs, []);
  assert.deepEqual(h.names().slice(0, 5), [
    "setBoardMetadataDisplaySwapped",
    "wagerView",
    "removeHighlights",
    "hideItemSelectionOrConfirmationOverlay",
    "setBoardFlipped",
  ]);
  const wagerView = h.events.find(({ name }) => name === "wagerView");
  assert.deepEqual(wagerView.args, [null]);
  assert.equal(wagerView.state.viewedRematchMatchId, null);
  const flip = h.events.find(({ name }) => name === "setBoardFlipped");
  assert.equal(flip.state.flashbackMode, false);
  assert.deepEqual(flip.state.currentInputs, []);
}

test("waiting entry clears historical input and orientation before waiting UI and appearance", () => {
  const h = harness();
  h.wait();
  assertLivePreparation(h, "waitingLive");
  assert.equal(h.contexts.at(-1).boardViewMode, "waitingLive");
  assert.deepEqual(h.names().slice(5), [
    "clearTimerVictoryClaimTimeout",
    "runMonsBoardAsDisplayWaitingAnimation",
    "hideBoardPlayersInfo",
    "setEndMatchVisible",
    "showWaitingStateText",
    "showVoiceReactionButton",
    "setAutomoveActionVisible",
    "setUndoVisible",
    "setUndoEnabled",
    "hideTimerButtons",
    "hideTimerCountdownDigits",
    "hideAllMoveStatuses",
    "syncInviteBotIntoLocalGameButton",
    "refreshDisplayedMatchPresentation",
    "triggerMoveHistoryPopupReload",
  ]);
});

test("active restoration refreshes appearance before rendering and restores timers before wagers", () => {
  const h = harness();
  h.restore();
  assertLivePreparation(h, "activeLive");
  assert.equal(h.contexts.at(-1).boardViewMode, "activeLive");
  const refreshIndex = h.names().indexOf("refreshDisplayedMatchPresentation");
  assert.deepEqual(h.names().slice(refreshIndex), [
    "refreshDisplayedMatchPresentation",
    "setNewBoard",
    "restoreTimer",
    "applyWagerState",
    "markKnownWagerInitialStateReceived",
    "updateUndoButtonBasedOnGameState",
    "triggerMoveHistoryPopupReload",
  ]);
  assert.equal(h.state().pendingTimerResolutionOnRestore, null);
  assert.deepEqual(h.events.find(({ name }) => name === "restoreTimer").args, [
    true,
    "live",
  ]);
});

test("pending restoration stays waiting without restoring a live board or consuming its timer", () => {
  const h = harness({ isWaitingForRematchResponse: true });
  h.restore();
  assertLivePreparation(h, "waitingLive");
  assert.equal(h.names().includes("setNewBoard"), false);
  assert.equal(h.names().includes("restoreTimer"), false);
  assert.equal(h.state().pendingTimerResolutionOnRestore, true);
});

test("new local preparation stops after base UI without restoring the previous game's timer or appearance", () => {
  const h = harness({ isOnlineGame: false });
  h.prepareLocal();
  assertLivePreparation(h, "activeLive");
  assert.equal(h.names().at(-1), "syncInviteBotIntoLocalGameButton");
  assert.equal(h.names().includes("refreshDisplayedMatchPresentation"), false);
  assert.equal(h.names().includes("setNewBoard"), false);
  assert.equal(h.names().includes("restoreTimer"), false);
});

test("historical entry installs the selection before effects and renders before archive refresh", () => {
  const h = harness({ boardViewMode: "activeLive", flashbackMode: false });
  const pair = { matchId: "older" };
  const historicalGame = { id: "older" };
  assert.equal(h.history("older", pair, historicalGame, 5), true);
  const state = h.state();
  assert.equal(state.boardViewMode, "historicalView");
  assert.equal(state.boardRenderSessionId, 5);
  assert.equal(state.viewedRematchRequestToken, 3);
  assert.equal(state.displayedHistoryViewId, 3);
  assert.equal(state.flashbackStateGame, historicalGame);
  assert.deepEqual(h.names().slice(0, 4), [
    "wagerView",
    "setBoardFlipped",
    "removeHighlights",
    "hideItemSelectionOrConfirmationOverlay",
  ]);
  assert.equal(h.events[0].state.viewedRematchMatchId, "older");
  assert.equal(h.events[1].state.viewedRematchPair, pair);
  assert.equal(h.events[2].state.flashbackMode, true);
  assert.deepEqual(h.events[2].state.currentInputs, []);
  assert.deepEqual(h.names().slice(-5), [
    "applyWagerState",
    "refreshDisplayedMatchPresentation",
    "setNewBoard",
    "scheduleHistoricalMatchArchiveRefresh",
    "triggerMoveHistoryPopupReload",
  ]);
  assert.deepEqual(
    h.events.find(
      ({ name }) => name === "scheduleHistoricalMatchArchiveRefresh",
    ).args,
    ["older", 3],
  );
});

test("a stale historical entry cannot change state or emit effects", () => {
  const h = harness();
  const before = h.state();
  assert.equal(h.history("older", {}, {}, 4), false);
  assert.deepEqual(h.state(), before);
  assert.deepEqual(h.events, []);
});

test("live local UI leaves existing end and reaction controls untouched", () => {
  const h = harness({ boardViewMode: "activeLive", isOnlineGame: false });
  h.applyUi();
  assert.deepEqual(h.names(), [
    "stopMonsBoardAsDisplayAnimations",
    "showBoardPlayersInfo",
    "showWaitingStateText",
    "syncInviteBotIntoLocalGameButton",
  ]);
});

test("historical UI clears timer claims before presentation and hides controls before board digits", () => {
  const h = harness();
  h.applyUi();
  assert.deepEqual(h.names(), [
    "clearTimerVictoryClaimTimeout",
    "stopMonsBoardAsDisplayAnimations",
    "showBoardPlayersInfo",
    "showWaitingStateText",
    "setEndMatchVisible",
    "setEndMatchConfirmed",
    "showVoiceReactionButton",
    "disableAndHideUndoResignAndTimerControls",
    "hideTimerButtons",
    "hideTimerCountdownDigits",
    "hideAllMoveStatuses",
    "syncInviteBotIntoLocalGameButton",
  ]);
});

test("active online UI changes only reaction visibility between board appearance and bot controls", () => {
  for (const isWatchOnly of [false, true]) {
    const h = harness({ boardViewMode: "activeLive", isWatchOnly });
    h.applyUi();
    assert.deepEqual(h.names(), [
      "stopMonsBoardAsDisplayAnimations",
      "showBoardPlayersInfo",
      "showWaitingStateText",
      "showVoiceReactionButton",
      "syncInviteBotIntoLocalGameButton",
    ]);
    assert.deepEqual(
      h.events.find(({ name }) => name === "showVoiceReactionButton").args,
      [!isWatchOnly],
    );
  }
});

test("view controls preserve independent timer and action state while clearing mode-specific controls", () => {
  for (const confirmation of ["none", "resign", "timer", "claim"]) {
    const initial = {
      undo: { visible: true, enabled: true },
      automove: { visible: true, enabled: false },
      resignVisible: true,
      primaryAction: "rematch",
      timer: {
        mode: "progressing",
        config: timerConfig,
        startEnabled: true,
        claimEnabled: false,
      },
      confirmation,
    };
    for (const boardViewMode of [
      "activeLive",
      "waitingLive",
      "historicalView",
    ]) {
      const h = harness({ boardViewMode }, initial);
      h.applyUi();
      const controls = h.controls();
      if (boardViewMode === "activeLive") {
        assert.equal(controls, initial);
        continue;
      }
      assert.deepEqual(controls.undo, { visible: false, enabled: false });
      assert.deepEqual(controls.automove, { visible: false, enabled: false });
      assert.equal(controls.primaryAction, "rematch");
      assert.equal(controls.timer.config, timerConfig);
      assert.deepEqual(controls.timer, {
        ...initial.timer,
        mode: "hidden",
        startEnabled: false,
      });
      assert.equal(controls.resignVisible, boardViewMode === "waitingLive");
      assert.equal(
        controls.confirmation,
        boardViewMode === "waitingLive" && confirmation === "resign"
          ? "resign"
          : "none",
      );
    }
  }
});

test("scrubbing a live match changes flashback without entering historical view", () => {
  const h = harness({ boardViewMode: "activeLive", flashbackMode: false });
  h.selectMove(0);
  assert.equal(h.state().boardViewMode, "activeLive");
  assert.equal(h.state().flashbackMode, true);
  assert.deepEqual(h.state().flashbackStateGame, { fen: "earlier" });
  h.selectMove(1);
  assert.equal(h.state().boardViewMode, "activeLive");
  assert.equal(h.state().flashbackMode, false);
});
