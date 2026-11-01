import { canonicalMatch, required } from "./fixtures/canonicalData.mjs";
import { Game, Color } from "mons-rules";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";

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
const source = ts.createSourceFile(
  "gameController.ts",
  readFileSync(
    new URL("../src/game/gameController.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const names = [
  "publishGameControlsContext",
  "setWatchOnlyState",
  "resetMatchConnectionFlags",
  "didSelectPuzzle",
  "playSameCompletedPuzzleAgain",
  "resetToTheStartOfThePuzzle",
  "didJustCreateRematchProposalSuccessfully",
  "didDiscoverExistingRematchProposalWaitingForResponse",
  "failedToCreateRematchProposal",
  "tryRestoreLiveViewAfterRematchAcceptance",
  "didUpdateRematchSeriesMetadata",
  "didReceiveRematchesSeriesEndIndicator",
  "didRecoverMyMatch",
  "didReceiveMatchUpdate",
  "didReceiveMatchUpdates",
  "didFailToLoadGame",
];
const declarations = names.map((name) => {
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

/**
 * @typedef {import("../src/content/problems.ts").Problem} Problem
 * @typedef {import("@mons/shared/game-sessions").GameSessionMatch} Match
 * @typedef {import("../src/game/gameControlsModel.ts").GameControlsSnapshot} ControlsSnapshot
 * @typedef {ControlsSnapshot["presentation"]} Presentation
 * @typedef {Game & {id: string}} FixtureGame
 * @typedef {{isOnlineGame: boolean; isWatchOnly: boolean; isGameWithBot: boolean; isWaitingForRematchResponse: boolean; pendingRematchNavigationToLiveBoard: boolean; puzzleMode: boolean; selectedProblem: Problem | null; didStartLocalGame: boolean; isGameOver: boolean; isReconnect: boolean; didConnect: boolean; isWaitingForInviteToGetAccepted: boolean; boardViewMode: ControlsSnapshot["context"]["boardViewMode"]; flashbackMode: boolean; currentInputs: string[]; resignedColor: Color | undefined; winnerByTimerColor: Color | undefined; playerSideColor: Color; lastReactionTime: number; game: FixtureGame; watchOnlyListeners: Set<(value: boolean) => void>}} ResetState
 * @typedef {Pick<typeof import("../src/game/gameController.ts"), "didSelectPuzzle" | "playSameCompletedPuzzleAgain" | "didJustCreateRematchProposalSuccessfully" | "didDiscoverExistingRematchProposalWaitingForResponse" | "failedToCreateRematchProposal" | "didUpdateRematchSeriesMetadata" | "didReceiveRematchesSeriesEndIndicator" | "didRecoverMyMatch" | "didReceiveMatchUpdate" | "didReceiveMatchUpdates" | "didFailToLoadGame"> & {resetToTheStartOfThePuzzle(): void; publishGameControlsContext(): void; setWatchOnlyState(value: boolean): void; resetMatchConnectionFlags(waiting: boolean): void; tryRestoreLiveViewAfterRematchAcceptance(): void; state(): ResetState; setState(values: Partial<ResetState>): void; onReady?: () => void}} ResetApi
 */
/** @type {Problem} */
const problem = {
  id: "lesson",
  icon: "",
  label: "Lesson",
  fen: "puzzle",
  description: "Learn a move",
};
/** @param {string} id @returns {FixtureGame} */
const makeGame = (id) => {
  const game = Object.assign(new Game(), { id });
  /** @type {Pick<Game, "winner" | "scores">} */
  const view = { winner: undefined, scores: { white: 3, black: 2 } };
  Object.defineProperties(game, {
    winner: { value: view.winner },
    scores: { value: view.scores },
  });
  return game;
};
/** @param {string} [fen] @param {Match["color"]} [color] @returns {Match} */
const match = (fen = "recovered", color = "white") =>
  canonicalMatch({ fen, color });

/** @param {Partial<ResetState>} [overrides] @param {{presentation?: Partial<Presentation>; hydration?: boolean}} [options] */
function harness(overrides = {}, { presentation = {}, hydration = true } = {}) {
  /** @type {ResetState} */
  const initial = {
    isOnlineGame: true,
    isWatchOnly: false,
    isGameWithBot: false,
    isWaitingForRematchResponse: false,
    pendingRematchNavigationToLiveBoard: false,
    puzzleMode: false,
    selectedProblem: null,
    didStartLocalGame: false,
    isGameOver: true,
    isReconnect: true,
    didConnect: true,
    isWaitingForInviteToGetAccepted: true,
    boardViewMode: "activeLive",
    flashbackMode: false,
    currentInputs: ["selected"],
    resignedColor: Color.White,
    winnerByTimerColor: Color.Black,
    playerSideColor: Color.White,
    lastReactionTime: 123,
    game: makeGame("old"),
    watchOnlyListeners: new Set(),
    ...overrides,
  };
  const store = createGameControlsStore({
    duration: 60,
    progress: 0,
    requestDate: 1000,
  });
  store.updatePresentation({
    endMatchVisible: true,
    watchOnlyVisible: initial.isWatchOnly,
    replayPuzzleVisible: true,
    ...presentation,
  });
  /** @type {Array<{name: string; args: unknown[]; state: ResetState; snapshot: ControlsSnapshot; notifications: number}>} */
  const events = [];
  /**
   * @type {import("../src/game/gameControlsModel.ts").GameControlsSnapshot[]}
   */
  const notifications = [];
  /** @type {ResetApi} */
  let api;
  let epoch = 0;
  let historicalSelection =
    initial.boardViewMode === "historicalView" ? { matchId: "previous" } : null;
  const record = (
    /** @type {string} */ name,
    /** @type {unknown[]} */ ...args
  ) => {
    events.push({
      name,
      args,
      state: api.state(),
      snapshot: store.getSnapshot(),
      notifications: notifications.length,
    });
  };
  const effect =
    (/** @type {string} */ name) =>
    (/** @type {unknown[]} */ ...args) =>
      record(name, ...args);
  /** @template {keyof Presentation} K @param {K} key @returns {(value: Presentation[K]) => void} */
  const setPresentation = (key) => (value) => {
    store.updatePresentation({ [key]: value });
    record(key, value);
  };
  const setGame = (/** @type {FixtureGame} */ next) => {
    api.setState({ game: next });
    record("install-game", next.id);
  };
  const readGame = (/** @type {string} */ fen) => {
    record("parse-fen", fen);
    return fen === "invalid" ? null : makeGame(fen);
  };
  const changeView = (
    /** @type {ResetState["boardViewMode"]} */ mode,
    /** @type {string} */ name,
  ) => {
    api.setState({ boardViewMode: mode, flashbackMode: false });
    historicalSelection = null;
    api.publishGameControlsContext();
    store.updatePresentation({
      waitingText: "",
      endMatchVisible: mode === "waitingLive",
    });
    record(name);
  };
  initial.watchOnlyListeners.add(effect("watch-only-listener"));
  const connection = {
    getActiveMatchId: () => "live",
    rematchSeriesEndIsIndicated: () => false,
    signInIfNeededAndConnectToGame: effect("connect"),
    tryNavigateWatchOnlyToLatestApprovedMatch: () => true,
  };
  const dependencies = {
    initial,
    batchGameControlsUpdates: store.batchUpdates,
    updateGameControlsContext: store.updateContext,
    getCurrentSessionId: () => 9,
    isGameConnectionBound: () => true,
    connection,
    MonsRules: { Color: { White: "white", Black: "black" } },
    PrimaryActionType: { None: "none", Rematch: "rematch" },
    Sound: { Undo: "undo", DidConnect: "connected" },
    Board: Object.fromEntries(
      [
        "removeHighlights",
        "hideItemSelectionOrConfirmationOverlay",
        "setBoardFlipped",
        "stopMonsBoardAsDisplayAnimations",
        "hideTimerCountdownDigits",
        "updateEmojiAndAuraIfNeeded",
        "setupPlayerId",
      ].map((name) => [name, effect(name)]),
    ),
    showPrimaryAction: (
      /** @type {Parameters<typeof import("../src/ui/controls/bottomControlsPort.ts").showPrimaryAction>[0]} */ action,
    ) => {
      store.dispatchGameControls({ type: "setPrimaryAction", action });
      record("setPrimaryAction", action);
    },
    setPlaySamePuzzleAgainButtonVisible: setPresentation("replayPuzzleVisible"),
    setEndMatchVisible: setPresentation("endMatchVisible"),
    setEndMatchConfirmed: setPresentation("endMatchConfirmed"),
    setWatchOnlyVisible: setPresentation("watchOnlyVisible"),
    showWaitingStateText: setPresentation("waitingText"),
    setHomeVisible: setPresentation("homeVisible"),
    showMoveHistoryButton: setPresentation("moveHistoryVisible"),
    setInviteLinkActionVisible: setPresentation("inviteLinkVisible"),
    setBotGameOptionVisible: setPresentation("botGameVisible"),
    setNavigationListButtonVisible: setPresentation("navigationVisible"),
    setAutomoveActionVisible: (/** @type {boolean} */ visible) => {
      store.dispatchGameControls({ type: "setAutomoveVisible", visible });
      record("setAutomoveVisible", visible);
    },
    setAutomoveActionEnabled: (/** @type {boolean} */ enabled) => {
      store.dispatchGameControls({ type: "setAutomoveEnabled", enabled });
      record("setAutomoveEnabled", enabled);
    },
    setAutomatchVisible: effect("automatch-visible"),
    disableAndHideUndoResignAndTimerControls: () =>
      store.dispatchGameControls({ type: "hideGameControls" }),
    applyGameplayControlsPreset: (
      /** @type {import("../src/game/sessionControls.ts").GameplayControlsPreset} */ preset,
    ) => {
      assert.equal(preset, "puzzle");
      store.updatePresentation({ homeVisible: true, inviteLinkVisible: false });
      store.dispatchGameControls({ type: "setUndoVisible", visible: true });
      record("puzzle-controls");
    },
    updateUndoButtonBasedOnGameState: () => {
      store.dispatchGameControls({ type: "setUndoEnabled", enabled: true });
      record("update-undo");
    },
    dismissNotificationBannerIfNeeded: effect("dismiss-banner"),
    clearMoveHistoryFlipOverrideForCurrentSession: effect(
      "clear-flip-override",
    ),
    closeNavigationAndAppearancePopupIfAny: effect("close-popups"),
    setNewBoard: effect("render"),
    showPuzzleInstructions: effect("instructions"),
    triggerMoveHistoryPopupReload: effect("history-reload"),
    playSounds: effect("sounds"),
    loadCurrentGameFromFen: (/** @type {string} */ fen) => {
      const next = readGame(fen);
      if (!next) return false;
      setGame(next);
      return true;
    },
    gameModelFromFen: readGame,
    installCurrentGameModel: setGame,
    buildGameSeedForStoredVariant: (/** @type {string} */ variant) => ({
      gameVariant: variant,
    }),
    applyGameSeedToCurrentGame: (/** @type {{gameVariant: string}} */ seed) =>
      setGame(makeGame(seed.gameVariant)),
    resetBotScoreReactionState: effect("reset-bot-reactions"),
    remoteMoveSync: {
      resetProgress: effect("reset-progress"),
      setProcessedCount: effect("processed-count"),
      remember: (/** @type {unknown[]} */ ...args) => {
        record("remember", ...args);
        return true;
      },
    },
    rematchViewing: {
      clearSelection: () => {
        historicalSelection = null;
        record("clear-selection");
      },
      seedProvisional: effect("archive-pair"),
      setScore: effect("archive-score"),
    },
    matchTimers: {
      reset: effect("reset-timer"),
      update: effect("update-timer"),
    },
    enterWaitingLiveView: () => changeView("waitingLive", "enter-waiting"),
    restoreLiveBoardView: () => changeView("activeLive", "restore-live"),
    nextBoardRenderSession: effect("next-render-session"),
    activeBoardShouldBeFlipped: () => false,
    applyBoardUiForCurrentView: effect("apply-view-controls"),
    getActiveRematchSeriesDescriptor: () => ({
      activeMatchId: "live",
      matches: [{ matchId: "live", isPendingResponse: false }],
    }),
    didSelectRematchSeriesMatch: async (/** @type {string} */ id) => {
      record("select-rematch", id);
      return true;
    },
    navigateFromWaitingLiveToLastCompletedMatch: effect("navigate-completed"),
    markMainGameWaiting: effect("mark-waiting"),
    markMainGameError: effect("mark-error"),
    ensureBoardViewInvariants: effect("check-view"),
    shouldPreserveHistoricalViewForCurrentInvite: () =>
      api.state().boardViewMode === "historicalView" &&
      historicalSelection !== null,
    resetWagerStateForMatch: effect("reset-wager"),
    verifyMovesIfNeeded: effect("verify-moves"),
    applyWagerState: effect("apply-wager"),
    markKnownWagerInitialStateReceived: effect("initial-wager"),
    preloadRematchScoresAfterGameLoaded: effect("preload-scores"),
    handleResignStatus: effect("resign"),
    handleResignStatusWithoutRender: effect("resign-without-render"),
    getSessionGuard: () => {
      const expected = epoch;
      return () => expected === epoch;
    },
    prepareInitialGameHydration: (/** @type {Match} */ value) =>
      hydration
        ? { kind: "provisional", gameModel: makeGame(value.fen) }
        : null,
    resetOnlineReconnectRequestState: effect("reset-reconnect"),
    didConnectTo: (
      /** @type {Match} */ _match,
      /** @type {string} */ _playerId,
      /** @type {string} */ _matchId,
      /** @type {{kind: "provisional"; gameModel: FixtureGame}} */ prepared,
    ) => {
      setGame(prepared.gameModel);
      api.setState({ isOnlineGame: true });
      api.publishGameControlsContext();
      record("hydrate");
    },
    movesCountOfMatch: () => 0,
    markMainGameContentReady: (/** @type {unknown[]} */ ...args) => {
      record("content-ready", ...args);
      api.onReady?.();
    },
  };
  const keys = Object.keys(initial);
  const { outputText } = ts.transpileModule(
    `${keys.map((key) => `let ${key} = initial.${key};`).join("\n")}
     ${declarations.join("\n")}
     return {
       ${names.join(",")},
       state: () => ({ ${keys.join(",")} }),
       setState: (values) => {
         ${keys.map((key) => `if (Object.hasOwn(values, "${key}")) ${key} = values.${key};`).join("\n")}
       }
     };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  );
  api = /** @type {ResetApi} */ (
    new Function(...Object.keys(dependencies), outputText)(
      ...Object.values(dependencies),
    )
  );
  api.publishGameControlsContext();
  store.subscribe(() => notifications.push(store.getSnapshot()));
  return Object.assign(api, {
    store,
    events,
    notifications,
    connection,
    selection: () => historicalSelection,
    invalidate: () => epoch++,
  });
}

/** @param {ReturnType<typeof harness>} h */
function assertFinalNotification(h) {
  assert.deepEqual(h.notifications, [h.store.getSnapshot()]);
  assert.ok(
    h.events.every(
      (/** @type {{ notifications: number; }} */ event) =>
        event.notifications === 0,
    ),
  );
}

test("puzzle selection publishes once after rendering with the existing mode and installing the selected lesson", () => {
  const h = harness({ isOnlineGame: false, isReconnect: false });
  h.didSelectPuzzle(problem);
  assertFinalNotification(h);
  const render = h.events.find(({ name }) => name === "render");
  const instructions = h.events.find(({ name }) => name === "instructions");
  assert.equal(required(render).state.puzzleMode, false);
  assert.equal(required(render).snapshot.context.isGameOver, false);
  assert.equal(required(instructions).snapshot.context.puzzleMode, true);
  assert.equal(
    required(instructions).snapshot.context.selectedPuzzleId,
    problem.id,
  );
  assert.equal(h.state().game.id, problem.fen);
  assert.deepEqual(h.state().currentInputs, []);
  assert.equal(
    h.store.getSnapshot().presentation.gameControls.undo.enabled,
    true,
  );
});

test("invalid puzzle selection publishes completed cleanup without replacing the game or selected lesson", () => {
  const h = harness({ puzzleMode: true, selectedProblem: problem });
  const previousGame = h.state().game;
  h.didSelectPuzzle({ ...problem, id: "invalid-lesson", fen: "invalid" });
  assertFinalNotification(h);
  assert.equal(h.state().game, previousGame);
  assert.equal(h.state().selectedProblem, problem);
  assert.equal(h.store.getSnapshot().context.isGameOver, false);
  assert.equal(
    h.events.some(({ name }) => name === "render"),
    false,
  );
  assert.equal(
    h.events.some(({ name }) => name === "instructions"),
    false,
  );
});

test("completed puzzle replay skips instructions and puzzle restart keeps its existing mode", () => {
  const replay = harness({ puzzleMode: true, selectedProblem: problem });
  replay.playSameCompletedPuzzleAgain();
  assertFinalNotification(replay);
  assert.equal(
    replay.events.some(({ name }) => name === "instructions"),
    false,
  );

  const restart = harness({ puzzleMode: true, selectedProblem: problem });
  restart.resetToTheStartOfThePuzzle();
  assertFinalNotification(restart);
  assert.equal(restart.state().isGameOver, true);
  assert.equal(restart.state().selectedProblem, problem);
  assert.deepEqual(
    restart.events
      .filter(({ name }) => ["render", "sounds", "update-undo"].includes(name))
      .map(({ name }) => name),
    ["render", "sounds", "update-undo"],
  );

  const invalid = harness({ selectedProblem: { ...problem, fen: "invalid" } });
  const before = invalid.store.getSnapshot();
  invalid.resetToTheStartOfThePuzzle();
  assert.equal(invalid.store.getSnapshot(), before);
  assert.deepEqual(invalid.notifications, []);
  assert.deepEqual(
    invalid.events.map(({ name }) => name),
    ["parse-fen"],
  );
});

for (const historical of [false, true]) {
  test(`successful online rematch publishes once and ${historical ? "retains the historical selection" : "enters the waiting view"}`, () => {
    const h = harness({
      boardViewMode: historical ? "historicalView" : "activeLive",
      flashbackMode: historical,
    });
    const selection = h.selection();
    const pair = {
      matchId: "previous",
      hostPlayerId: "host",
      guestPlayerId: "guest",
      hostMatch: match(),
      guestMatch: match("recovered", "black"),
    };
    h.didJustCreateRematchProposalSuccessfully(
      "invite",
      match("invalid", "black"),
      "previous",
      pair,
    );
    assertFinalNotification(h);
    const state = h.state();
    assert.equal(state.isReconnect, false);
    assert.equal(state.didConnect, false);
    assert.equal(state.isWaitingForInviteToGetAccepted, false);
    assert.equal(state.isWaitingForRematchResponse, true);
    assert.equal(state.resignedColor, undefined);
    assert.equal(state.winnerByTimerColor, undefined);
    assert.equal(state.game.id, "Classic");
    assert.equal(state.playerSideColor, "black");
    assert.equal(
      state.boardViewMode,
      historical ? "historicalView" : "waitingLive",
    );
    assert.equal(h.selection(), selection);
    assert.equal(state.flashbackMode, historical);
    const connect = h.events.find(({ name }) => name === "connect");
    assert.equal(required(connect).snapshot.context.isGameOver, false);
    assert.equal(required(connect).state.isWaitingForRematchResponse, true);
    assert.deepEqual(
      h.events
        .filter(({ name }) =>
          [
            "archive-pair",
            "archive-score",
            "reset-progress",
            "reset-timer",
            "connect",
          ].includes(name),
        )
        .map(({ name }) => name),
      [
        "archive-pair",
        "archive-score",
        "reset-progress",
        "reset-timer",
        "connect",
      ],
    );
  });
}

test("existing rematch discovery preserves historical viewing without emitting a redundant controls update", () => {
  const h = harness({ boardViewMode: "historicalView", flashbackMode: true });
  const selection = h.selection();
  const game = h.state().game;
  h.didDiscoverExistingRematchProposalWaitingForResponse();
  assert.equal(h.state().isWaitingForRematchResponse, true);
  assert.equal(h.state().game, game);
  assert.equal(h.selection(), selection);
  assert.deepEqual(h.notifications, []);
  assert.deepEqual(
    h.events.map(({ name }) => name),
    ["history-reload"],
  );

  const live = harness();
  live.didDiscoverExistingRematchProposalWaitingForResponse();
  assertFinalNotification(live);
  assert.deepEqual(
    live.events.map(({ name }) => name),
    ["enter-waiting", "mark-waiting", "history-reload"],
  );
});

test("failed rematch clears pending navigation and publishes the restored action after board work", () => {
  const h = harness({
    boardViewMode: "waitingLive",
    isWaitingForRematchResponse: true,
    pendingRematchNavigationToLiveBoard: true,
  });
  h.failedToCreateRematchProposal();
  assertFinalNotification(h);
  assert.equal(h.state().isWaitingForRematchResponse, false);
  assert.equal(h.state().pendingRematchNavigationToLiveBoard, false);
  assert.equal(h.store.getSnapshot().context.boardViewMode, "activeLive");
  assert.equal(
    h.store.getSnapshot().presentation.gameControls.primaryAction,
    "rematch",
  );
  assert.equal(
    required(h.events.find(({ name }) => name === "render")).snapshot.context
      .boardViewMode,
    "activeLive",
  );
});

test("rematch acceptance clears waiting but leaves historical selection until navigation commits", () => {
  const h = harness({
    boardViewMode: "historicalView",
    flashbackMode: true,
    isWaitingForRematchResponse: true,
    pendingRematchNavigationToLiveBoard: true,
  });
  const selection = h.selection();
  h.didUpdateRematchSeriesMetadata();
  assertFinalNotification(h);
  assert.equal(h.state().isWaitingForRematchResponse, false);
  assert.equal(h.state().pendingRematchNavigationToLiveBoard, false);
  assert.equal(h.selection(), selection);
  assert.equal(h.state().boardViewMode, "historicalView");
  assert.equal(
    h.events.some(({ name }) => name === "restore-live"),
    false,
  );
  assert.deepEqual(
    required(h.events.find(({ name }) => name === "select-rematch")).args,
    ["live"],
  );
});

test("accepted waiting rematch restores live controls in the same notification", () => {
  const h = harness({
    boardViewMode: "waitingLive",
    isWaitingForRematchResponse: true,
  });
  h.didUpdateRematchSeriesMetadata();
  assertFinalNotification(h);
  assert.equal(h.state().isWaitingForRematchResponse, false);
  assert.equal(h.store.getSnapshot().context.boardViewMode, "activeLive");
  assert.equal(h.store.getSnapshot().presentation.endMatchVisible, false);
  assert.equal(
    h.events.some(({ name }) => name === "select-rematch"),
    false,
  );
});

for (const spectator of [false, true]) {
  test(`series end publishes confirmation while preserving the ${spectator ? "spectator early return" : "waiting participant navigation"}`, () => {
    const h = harness({
      isWatchOnly: spectator,
      boardViewMode: "waitingLive",
      isWaitingForRematchResponse: true,
      pendingRematchNavigationToLiveBoard: true,
    });
    h.connection.rematchSeriesEndIsIndicated = () => true;
    h.didReceiveRematchesSeriesEndIndicator();
    assertFinalNotification(h);
    const snapshot = h.store.getSnapshot();
    assert.equal(snapshot.context.isSeriesEnded, true);
    assert.equal(snapshot.presentation.endMatchConfirmed, true);
    assert.equal(h.state().isWaitingForRematchResponse, spectator);
    assert.equal(h.state().pendingRematchNavigationToLiveBoard, spectator);
    assert.equal(
      h.events.some(({ name }) => name === "navigate-completed"),
      !spectator,
    );
    assert.equal(
      h.events.some(({ name }) => name === "history-reload"),
      !spectator,
    );
  });
}

test("spectator rematch metadata resets only live progress while preserving its role and reconnect status", () => {
  const h = harness({
    isWatchOnly: true,
    boardViewMode: "historicalView",
    flashbackMode: true,
  });
  h.didUpdateRematchSeriesMetadata();
  assertFinalNotification(h);
  assert.equal(h.state().isWatchOnly, true);
  assert.equal(h.state().isReconnect, true);
  assert.equal(h.state().didConnect, false);
  assert.equal(h.state().isGameOver, false);
  assert.deepEqual(h.state().currentInputs, []);
  assert.equal(h.state().resignedColor, undefined);
  assert.equal(h.state().winnerByTimerColor, undefined);
  assert.equal(
    required(h.events.find(({ name }) => name === "reset-progress")).snapshot
      .context.isGameOver,
    false,
  );
});

test("own-match recovery preserves historical selection and synchronously publishes role changes before hydration", () => {
  const h = harness({
    isWatchOnly: true,
    boardViewMode: "historicalView",
    flashbackMode: true,
    isGameOver: false,
  });
  const selection = h.selection();
  h.didRecoverMyMatch(match(), "live");
  assertFinalNotification(h);
  assert.equal(h.selection(), selection);
  assert.equal(h.state().boardViewMode, "historicalView");
  assert.equal(h.state().flashbackMode, true);
  assert.equal(h.state().isReconnect, true);
  assert.equal(h.state().didConnect, false);
  assert.equal(h.state().game.id, "recovered");
  const watcher = h.events.find(({ name }) => name === "watch-only-listener");
  assert.equal(required(watcher).snapshot.context.isWatchOnly, false);
  assert.equal(required(watcher).state.game.id, "old");
  assert.equal(
    h.events.some(({ name }) => name === "setBoardFlipped"),
    false,
  );
  assert.deepEqual(
    h.events
      .filter(({ name }) =>
        [
          "reset-wager",
          "install-game",
          "verify-moves",
          "update-timer",
          "preload-scores",
        ].includes(name),
      )
      .map(({ name }) => name),
    [
      "reset-wager",
      "install-game",
      "verify-moves",
      "update-timer",
      "preload-scores",
    ],
  );
});

test("stale recovery is a no-op and invalid recovery retains the role change completed before parsing", () => {
  const stale = harness({ isWatchOnly: true });
  const before = stale.store.getSnapshot();
  stale.didRecoverMyMatch(match(), "old-match");
  assert.equal(stale.store.getSnapshot(), before);
  assert.deepEqual(stale.notifications, []);
  assert.deepEqual(stale.events, []);

  const invalid = harness({ isWatchOnly: true });
  const game = invalid.state().game;
  invalid.didRecoverMyMatch(match("invalid"), "live");
  assertFinalNotification(invalid);
  assert.equal(invalid.state().game, game);
  assert.equal(invalid.state().isWatchOnly, false);
  assert.equal(invalid.state().isReconnect, true);
  assert.equal(invalid.state().didConnect, false);
  assert.equal(
    invalid.events.some(({ name }) => name === "reset-wager"),
    false,
  );
});

test("first hydration publishes final controls only after the match becomes connected", () => {
  const h = harness({
    didConnect: false,
    isReconnect: false,
    isGameOver: false,
  });
  h.didReceiveMatchUpdate(match("initial"), "player", "live");
  assertFinalNotification(h);
  assert.equal(h.state().didConnect, true);
  assert.equal(h.state().isWaitingForInviteToGetAccepted, false);
  const ready = h.events.find(({ name }) => name === "content-ready");
  assert.equal(required(ready).state.didConnect, true);
  assert.equal(required(ready).state.game.id, "initial");
  assert.equal(required(ready).snapshot.context.isOnlineGame, true);
  assert.deepEqual(
    h.events
      .filter(({ name }) =>
        ["hydrate", "processed-count", "remember", "content-ready"].includes(
          name,
        ),
      )
      .map(({ name }) => name),
    ["hydrate", "processed-count", "remember", "content-ready"],
  );
});

test("unavailable hydration and stale match callbacks do not publish or install a model", () => {
  const h = harness({ didConnect: false }, { hydration: false });
  const before = h.store.getSnapshot();
  h.didReceiveMatchUpdate(match(), "player", "live");
  assert.equal(h.state().didConnect, false);
  assert.equal(h.store.getSnapshot(), before);
  assert.deepEqual(h.notifications, []);
  h.events.length = 0;
  h.didReceiveMatchUpdate(match(), "player", "old-match");
  h.didReceiveMatchUpdates(new Map([["player", match()]]), "live", () => false);
  assert.deepEqual(h.events, []);
});

test("session invalidation during first hydration prevents the next match callback", () => {
  const h = harness({
    didConnect: false,
    isReconnect: false,
    isGameOver: false,
  });
  h.onReady = h.invalidate;
  h.didReceiveMatchUpdates(
    new Map([
      ["white", match("initial")],
      ["black", match("later", "black")],
    ]),
    "live",
    () => true,
  );
  assertFinalNotification(h);
  assert.equal(h.events.filter(({ name }) => name === "hydrate").length, 1);
  assert.equal(
    h.events.filter(({ name }) => name === "content-ready").length,
    1,
  );
  assert.equal(h.state().game.id, "initial");
});

test("load failure publishes its error controls after resetting connection flags", () => {
  const h = harness();
  h.didFailToLoadGame(true);
  assertFinalNotification(h);
  assert.equal(h.state().isWaitingForInviteToGetAccepted, false);
  assert.equal(h.state().isReconnect, true);
  assert.equal(h.state().didConnect, false);
  const error = h.events.find(({ name }) => name === "mark-error");
  assert.equal(
    required(error).snapshot.presentation.waitingText,
    "Game not found.",
  );
  assert.equal(required(error).snapshot.presentation.homeVisible, true);
});
