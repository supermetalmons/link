import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

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
  "go",
  "disposeGameSession",
  "cancelSessionPreload",
  "resetSessionBoardState",
  "resetSessionFlags",
  "clearAllManagedGameTimeouts",
  "resetBotScoreReactionState",
  "nextBoardRenderSession",
  "clearViewedRematchState",
  "resetRemoteMoveHistories",
  "resetOnlineReconnectRequestState",
  "resetTimerStateForMatch",
  "clearTimerActivationCooldownState",
  "clearTimerVictoryClaimTimeout",
  "setWatchOnlyState",
  "isCreateInviteRoute",
  "isSnapshotRoute",
  "isBotsRoute",
].map((name) => {
  const declaration = source.statements.find(
    (node) =>
      (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (item) => item.name.getText(source) === name,
        )),
  );
  assert.ok(declaration, name);
  return declaration.getText(source).replace(/^export /, "");
});

const home = { mode: "home", path: "", autojoin: false };
const invite = (inviteId = "next", autojoin = false) => ({
  mode: "invite",
  path: inviteId,
  inviteId,
  autojoin,
});

function harness({
  pendingAutomatch = false,
  route = home,
  waiting = false,
} = {}) {
  const events = [];
  const ui = {};
  const subscriptions = new Set();
  const pendingTimeouts = new Set([1, 2]);
  let api;
  let wagerMatch = "old";
  let wagerSnapshot = { agreed: "old" };
  const initial = {
    activeRouteState: route,
    initialWagersMatchId: "old",
    cancelRematchScoresPreload: () =>
      events.push(["preload-cancel", api.state().initialWagersMatchId]),
    isOnlineGame: true,
    isGameWithBot: true,
    isWaitingForRematchResponse: true,
    pendingRematchNavigationToLiveBoard: true,
    puzzleMode: true,
    selectedProblem: "old-problem",
    didStartLocalGame: true,
    isGameOver: true,
    isReconnect: true,
    didConnect: true,
    isWaitingForInviteToGetAccepted: true,
    pendingAutomatchTransition: pendingAutomatch,
    isInviteBotIntoLocalGameUnavailable: true,
    didMakeFirstLocalPlayerMoveOnLocalBoard: true,
    isWatchOnly: true,
    watchOnlyListeners: new Set(),
    boardViewMode: "historicalView",
    boardRenderSessionId: 4,
    displayedHistoryViewId: 3,
    viewedRematchRequestToken: 2,
    viewedRematchMatchId: "old",
    viewedRematchGame: {},
    viewedRematchPair: {},
    moveHistoryFlipOverrideEnabled: true,
    moveHistoryFlipOverrideSessionId: 4,
    moveHistoryFlipOverrideBaseBoardFlipped: true,
    botScoreReactionPlayedTurns: new Set([1]),
    remoteMoveHistories: new Map([["white", ["old"]]]),
    remoteMoveHistoriesMatchId: "old",
    pendingOnlineReconnectInviteId: "old",
    lastOnlineReconnectRequestedAtMs: 123,
    flashbackMode: true,
    resignedColor: "white",
    winnerByTimerColor: "black",
    currentInputs: ["old-selection"],
    timerStashMatchId: "old",
    blackTimerStash: "old-black",
    whiteTimerStash: "old-white",
    pendingTimerResolutionOnRestore: "old",
    timerActivationCooldownMatchId: "old",
    timerActivationCooldownTurnNumber: 3,
    timerActivationCooldownStartedAtMs: 123,
    timerVictoryClaimTimeoutId: 1,
    wagerOutcomeAnimTimer: 2,
    didSetupWagerSubscription: false,
    unsubscribeFromWagerState: null,
    currentWagerState: wagerSnapshot,
    wagerOutcomeShown: true,
    wagerOutcomeAnimating: true,
    wagerOutcomeAnimationAllowed: true,
    whiteProcessedMovesCount: 5,
    blackProcessedMovesCount: 4,
    didSetWhiteProcessedMovesCount: true,
    didSetBlackProcessedMovesCount: true,
    currentGameModelMatchId: "old",
    whiteFlatMovesString: "old-white",
    blackFlatMovesString: "old-black",
    wagerMatchId: "old",
    lastObservedMatchSideFallbackWarningKey: "old",
    lastReactionTime: 123,
    lastBotMoveTimestamp: 123,
    processedVoiceReactions: new Set(["old"]),
    playerSideColor: "black",
    currentGameVariant: "old",
    isMoveHistoryPopupOpen: true,
    game: { contentPositions: () => [], winner: undefined },
  };
  const capture = (name) =>
    events.push([
      name,
      {
        watchOnly: api.state().isWatchOnly,
        flashback: api.state().flashbackMode,
        inputs: [...api.state().currentInputs],
        timer: api.state().timerStashMatchId,
        wager: api.state().currentWagerState,
        selectedProblem: api.state().selectedProblem,
        waiting: api.state().isWaitingForInviteToGetAccepted,
      },
    ]);
  initial.watchOnlyListeners.add(() => capture("watcher"));
  const noop = () => {};
  const setterNames = [
    "setIslandButtonDimmed",
    "setHomeVisible",
    "setBrushAndNavigationButtonDimmed",
    "setNavigationListButtonVisible",
    "setAutomatchWaitingState",
    "setInviteLinkActionVisible",
    "setAutomatchVisible",
    "setBotGameOptionVisible",
    "setPlaySamePuzzleAgainButtonVisible",
    "setAutomatchEnabled",
    "setUndoVisible",
    "setAutomoveActionVisible",
    "setAutomoveActionEnabled",
    "setUndoEnabled",
    "setWatchOnlyVisible",
    "showVoiceReactionButton",
    "showMoveHistoryButton",
    "setEndMatchVisible",
    "setEndMatchConfirmed",
    "showWaitingStateText",
    "showPrimaryAction",
    "setDisplayedBoardSquareTypes",
  ];
  const boardMethods = [
    "setBoardMetadataDisplaySwapped",
    "resetPlayersMetadataForSession",
    "setBoardFlipped",
    "setBotStrengthControlVisible",
    "setBotStrengthControlMode",
    "setupGameInfoElements",
    "hideTimerCountdownDigits",
    "hideAllMoveStatuses",
    "setInviteBotButtonVisible",
    "removeHighlights",
    "hideItemSelectionOrConfirmationOverlay",
  ];
  const dependencies = {
    initial,
    MonsRules: { Color: { White: "white" } },
    PrimaryActionType: { None: "none" },
    legacyDefaultGameVariant: "Classic",
    botAutomoveMode: "normal",
    getCurrentRouteState: () => route,
    clearManagedGameTimeouts: () => {
      events.push(["timeouts-clear"]);
      pendingTimeouts.clear();
    },
    clearManagedGameTimeout: (id) => pendingTimeouts.delete(id),
    clearRematchHistoryCaches: () => events.push(["history-clear"]),
    setCurrentWagerMatch: (matchId) => {
      events.push(["wager-match", matchId]);
      if (wagerMatch === matchId) return;
      wagerMatch = matchId;
      wagerSnapshot = null;
      subscriptions.forEach((listener) => listener(wagerSnapshot));
    },
    subscribeToWagerState: (listener) => {
      events.push(["subscribe"]);
      subscriptions.add(listener);
      listener(wagerSnapshot);
      return () => {
        events.push(["unsubscribe"]);
        subscriptions.delete(listener);
      };
    },
    applyWagerState: () => capture("wager-notify"),
    summarizeWagerState: (state) => state,
    logWagerDebug: noop,
    shouldDeferWagerStateForUninstalledMatch: () => false,
    syncWagerOutcome: noop,
    connection: {
      setWagerViewMatchId: (id) => {
        events.push(["wager-view", id]);
        subscriptions.forEach((listener) => listener(wagerSnapshot));
      },
      setupConnection: noop,
      hasPendingInviteCreationFor: (id) => id === "next",
    },
    Board: {
      ...Object.fromEntries(
        boardMethods.map((name) => [
          name,
          (value) => {
            ui[name] = value;
          },
        ]),
      ),
      setupBoard: () => events.push(["setup-board", ui.preserveAnimation]),
      hasMonsBoardDisplayAnimationRunning: () => waiting,
      setPreserveDisplayAnimation: (value) => {
        ui.preserveAnimation = value;
      },
      stopMonsBoardAsDisplayAnimations: () => {
        if (!ui.preserveAnimation) waiting = false;
      },
      runMonsBoardAsDisplayWaitingAnimation: () => {
        waiting = true;
        events.push(["waiting-animation"]);
      },
    },
    ...Object.fromEntries(
      setterNames.map((name) => [
        name,
        (value) => {
          ui[name] = value;
        },
      ]),
    ),
    triggerMoveHistoryPopupReload: noop,
    buildInitialRouteGameSeed: () => ({}),
    applyGameSeedToCurrentGame: noop,
    ensureLocalRematchSeriesInitialized: noop,
    updateDisplayedBoardSquareTypes: noop,
    syncInviteBotIntoLocalGameButton: noop,
    markMainGameContentReady: noop,
    hideTimerButtons: noop,
    disableAndHideUndoResignAndTimerControls: noop,
    createLegacyBoardSquareTypeGrid: () => "legacy-grid",
  };
  const keys = Object.keys(initial);
  const { outputText } = ts.transpileModule(
    `
    ${keys.map((key) => `let ${key} = initial.${key};`).join("\n")}
    ${declarations.join("\n")}
    return {
      go, disposeGameSession,
      state: () => ({ ${keys.join(",")} }),
      setState: (values) => { ${keys.map((key) => `if (Object.hasOwn(values, "${key}")) ${key} = values.${key};`).join("\n")} }
    };
  `,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  );
  api = new Function(...Object.keys(dependencies), outputText)(
    ...Object.values(dependencies),
  );
  return {
    ...api,
    events,
    ui,
    subscriptions,
    pendingTimeouts,
    publishWager: (state) => {
      wagerMatch = "old";
      wagerSnapshot = state;
      subscriptions.forEach((listener) => listener(state));
    },
  };
}

for (const action of ["go", "disposeGameSession"]) {
  test(`${action} clears the dirty session baseline and cancels old work`, async () => {
    const h = harness();
    await h[action](home);
    const state = h.state();
    assert.deepEqual(h.events.slice(0, 3), [
      ["preload-cancel", null],
      ["timeouts-clear"],
      ["history-clear"],
    ]);
    assert.equal(h.pendingTimeouts.size, 0);
    for (const flag of [
      "isOnlineGame",
      "isGameWithBot",
      "isWaitingForRematchResponse",
      "pendingRematchNavigationToLiveBoard",
      "puzzleMode",
      "didStartLocalGame",
      "isGameOver",
      "isReconnect",
      "didConnect",
      "isWatchOnly",
      "flashbackMode",
    ]) {
      assert.equal(state[flag], false, flag);
    }
    assert.equal(state.boardViewMode, "activeLive");
    assert.equal(state.boardRenderSessionId, 5);
    assert.equal(state.viewedRematchMatchId, null);
    assert.equal(state.viewedRematchGame, null);
    assert.equal(state.moveHistoryFlipOverrideEnabled, false);
    assert.equal(state.botScoreReactionPlayedTurns.size, 0);
    assert.equal(state.pendingOnlineReconnectInviteId, null);
    assert.deepEqual(state.currentInputs, []);
    assert.equal(state.resignedColor, undefined);
    assert.equal(state.winnerByTimerColor, undefined);
    assert.equal(state.timerStashMatchId, null);
    assert.equal(state.blackTimerStash, null);
    assert.equal(state.whiteTimerStash, null);
    assert.equal(state.timerActivationCooldownMatchId, null);
    assert.equal(state.timerVictoryClaimTimeoutId, null);
    assert.equal(state.cancelRematchScoresPreload, null);
    assert.equal(h.ui.setBoardFlipped, false);
    assert.equal(state.selectedProblem, action === "go" ? "old-problem" : null);
  });
}

test("wager subscriptions survive repeated startup and are replaced once after disposal", async () => {
  const h = harness();
  await h.go(home);
  await h.go(home);
  assert.equal(h.subscriptions.size, 1);
  assert.equal(h.events.filter(([name]) => name === "subscribe").length, 1);
  h.disposeGameSession(home);
  h.disposeGameSession(home);
  assert.equal(h.subscriptions.size, 0);
  assert.equal(h.events.filter(([name]) => name === "unsubscribe").length, 1);
  assert.equal(
    h.events.filter(([name]) => name === "preload-cancel").length,
    1,
  );
  assert.equal(h.pendingTimeouts.size, 0);
  assert.equal(h.state().remoteMoveHistories.size, 0);
  assert.equal(h.state().processedVoiceReactions.size, 0);
  assert.equal(h.state().currentGameModelMatchId, null);
  await h.go(home);
  assert.equal(h.subscriptions.size, 1);
  assert.equal(h.events.filter(([name]) => name === "subscribe").length, 2);
});

for (const action of ["go", "disposeGameSession"]) {
  test(`${action} preserves synchronous wager and watch-only notification ordering`, async () => {
    const h = harness();
    await h.go(home);
    const wager = { agreed: "old" };
    h.publishWager(wager);
    h.setState({
      isWatchOnly: true,
      flashbackMode: true,
      currentInputs: ["old-selection"],
      timerStashMatchId: "old",
      selectedProblem: "old-problem",
    });
    h.events.length = 0;
    await h[action](home);
    const meaningful = h.events.filter(([name]) =>
      [
        "unsubscribe",
        "wager-match",
        "wager-view",
        "wager-notify",
        "watcher",
      ].includes(name),
    );
    if (action === "go") {
      assert.deepEqual(meaningful, [
        ["wager-match", null],
        [
          "wager-notify",
          {
            watchOnly: true,
            flashback: false,
            inputs: [],
            timer: "old",
            wager: null,
            selectedProblem: "old-problem",
            waiting: false,
          },
        ],
        ["wager-view", null],
        [
          "wager-notify",
          {
            watchOnly: true,
            flashback: false,
            inputs: [],
            timer: "old",
            wager: null,
            selectedProblem: "old-problem",
            waiting: false,
          },
        ],
        [
          "watcher",
          {
            watchOnly: false,
            flashback: false,
            inputs: [],
            timer: "old",
            wager: null,
            selectedProblem: "old-problem",
            waiting: false,
          },
        ],
      ]);
    } else {
      assert.deepEqual(meaningful, [
        ["unsubscribe"],
        [
          "watcher",
          {
            watchOnly: false,
            flashback: true,
            inputs: ["old-selection"],
            timer: "old",
            wager,
            selectedProblem: null,
            waiting: false,
          },
        ],
        ["wager-match", null],
        ["wager-view", null],
      ]);
    }
  });
}

test("automatch waiting survives disposal and is consumed by startup once", async () => {
  const h = harness({ pendingAutomatch: true });
  h.disposeGameSession(invite());
  assert.equal(h.state().pendingAutomatchTransition, true);
  assert.equal(h.state().isWaitingForInviteToGetAccepted, true);
  assert.equal(h.ui.preserveAnimation, true);
  assert.equal(h.ui.setHomeVisible, true);
  assert.equal(h.ui.setIslandButtonDimmed, true);
  assert.equal(Object.hasOwn(h.ui, "setAutomatchWaitingState"), false);
  assert.equal(Object.hasOwn(h.ui, "setAutomatchVisible"), false);
  await h.go(invite());
  assert.deepEqual(
    h.events.find(([name]) => name === "setup-board"),
    ["setup-board", true],
  );
  assert.equal(h.ui.preserveAnimation, false);
  assert.equal(h.state().pendingAutomatchTransition, false);
  assert.equal(h.state().isWaitingForInviteToGetAccepted, true);
  assert.equal(h.ui.setAutomatchWaitingState, true);
  const animationStarts = h.events.filter(
    ([name]) => name === "waiting-animation",
  ).length;
  assert.ok(animationStarts > 0);
  h.disposeGameSession(home);
  assert.equal(h.ui.setAutomatchWaitingState, false);
  await h.go(home);
  assert.equal(h.state().isWaitingForInviteToGetAccepted, false);
  assert.equal(
    h.events.filter(([name]) => name === "waiting-animation").length,
    animationStarts,
  );
});

test("manual invite animation is preserved only for a matching pending creation from the lobby", async () => {
  const cases = [
    { route: home, waiting: true, next: invite(), preserve: true },
    { route: home, waiting: true, next: invite("next", true), preserve: false },
    { route: home, waiting: true, next: invite("other"), preserve: false },
    { route: home, waiting: false, next: invite(), preserve: false },
    { route: invite("old"), waiting: true, next: invite(), preserve: false },
    { route: home, waiting: true, next: home, preserve: false },
    { route: home, waiting: true, next: undefined, preserve: false },
  ];
  for (const scenario of cases) {
    const h = harness(scenario);
    h.disposeGameSession(scenario.next);
    assert.equal(
      h.ui.preserveAnimation,
      scenario.preserve,
      JSON.stringify(scenario),
    );
    assert.equal(h.state().isWaitingForInviteToGetAccepted, false);
    assert.equal(h.ui.setAutomatchWaitingState, false);
    assert.equal(
      Object.hasOwn(h.ui, "setDisplayedBoardSquareTypes"),
      !scenario.preserve,
    );
    if (scenario.preserve) {
      await h.go(scenario.next);
      assert.deepEqual(
        h.events.find(([name]) => name === "setup-board"),
        ["setup-board", true],
      );
      assert.equal(h.ui.preserveAnimation, false);
    }
  }
});
