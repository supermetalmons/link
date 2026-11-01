import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";
import { Game } from "mons-rules";
import { PrimaryActionType } from "../src/ui/controls/primaryAction.ts";
import { deriveBoardViewControls } from "../src/game/boardViewPolicy.ts";
import { MATCH_TIMER_TERMINAL } from "@mons/shared/timers";
import { createMatchTimerHarness } from "./fixtures/matchTimerHarness.mjs";
import { createRematchViewingHarness } from "./fixtures/rematchViewingHarness.mjs";

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
const { createGameControlsState } =
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
  assert.ok(declaration && ts.isFunctionDeclaration(declaration));
  assert.ok(declaration, name);
  return declaration.getText(source).replace(/^export /, "");
});

/**
 * @typedef {import("../src/game/boardViewPolicy.ts").BoardViewMode} ViewMode
 * @typedef {import("@mons/shared/game-sessions").HistoricalMatchPair} MatchPair
 * @typedef {import("../src/game/gameControlsModel.ts").GameControlsSnapshot} ControlsSnapshot
 * @typedef {import("../src/ui/controls/bottomControlsState.ts").GameControlsState} ControlsState
 * @typedef {{ selectedProblem: null, puzzleMode: boolean, boardViewMode: ViewMode, isOnlineGame: boolean, isWatchOnly: boolean, isGameWithBot: boolean, isGameOver: boolean, isWaitingForRematchResponse: boolean, isReconnect: boolean, boardViewDebugLogsEnabled: boolean, boardRenderSessionId: number, flashbackMode: boolean, flashbackStateGame: Game | { fen: string } | null, currentInputs: string[], moveHistoryFlipOverrideEnabled: boolean, moveHistoryFlipOverrideSessionId: number | null, moveHistoryFlipOverrideBaseBoardFlipped: boolean | null, game: Game }} InitialState
 * @typedef {InitialState & { selection: ReturnType<ReturnType<typeof createRematchViewingHarness>["getSelection"]> }} HarnessState
 * @typedef {{ state(): HarnessState, setWaiting(value: boolean): void, wait(): void, restore(): void, prepareLocal(): void, history(matchId: string, pair: MatchPair, game: Game, sessionId: number): boolean, applyUi(): void, selectMove: typeof import("../src/game/gameController.ts").didSelectVerboseTrackingEntity }} HarnessApi
 * @typedef {{ name: string, args: unknown[], state: HarnessState, snapshot: ControlsSnapshot, notifications: number }} RecordedEvent
 */
/** @param {string} id */
const labelledGame = (id) => Object.assign(new Game(), { id });
/** @param {string} matchId @returns {MatchPair} */
const matchPair = (matchId) => ({
  matchId,
  hostPlayerId: "host",
  guestPlayerId: null,
  hostMatch: null,
  guestMatch: null,
});

/** @param {Partial<InitialState>} [overrides] @param {ControlsState} [initialControls] @param {{ rejectHistoricalCommit?: boolean }} [options] */
function harness(
  overrides = {},
  initialControls = createGameControlsState(timerConfig),
  { rejectHistoricalCommit = false } = {},
) {
  /** @type {RecordedEvent[]} */
  const events = [];
  /** @type {(Partial<import("../src/game/gameControlsModel.ts").GameControlsContext>)[]} */
  const contexts = [];
  /** @type {InitialState} */
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
    flashbackMode: true,
    flashbackStateGame: labelledGame("old"),
    currentInputs: ["selected"],
    moveHistoryFlipOverrideEnabled: true,
    moveHistoryFlipOverrideSessionId: 5,
    moveHistoryFlipOverrideBaseBoardFlipped: false,
    game: new Game(),
    ...overrides,
  };
  const controlsStore = createGameControlsStore(timerConfig);
  controlsStore.updateContext({
    isOnlineGame: initial.isOnlineGame,
    isWatchOnly: initial.isWatchOnly,
    isGameWithBot: initial.isGameWithBot,
    puzzleMode: initial.puzzleMode,
    isGameOver: initial.isGameOver,
    boardViewMode: initial.boardViewMode,
    sessionId: 1,
  });
  controlsStore.updatePresentation({ gameControls: initialControls });
  /**
   * @type {import("../src/game/gameControlsModel.ts").GameControlsSnapshot[]}
   */
  const observedSnapshots = [];
  controlsStore.subscribe(() =>
    observedSnapshots.push(controlsStore.getSnapshot()),
  );
  const rematchViewing = createRematchViewingHarness({
    selection: {
      matchId: "old",
      pair: matchPair("old"),
      game: labelledGame("old"),
    },
  });
  if (rejectHistoricalCommit) {
    rematchViewing.commitSelection = () => false;
  }
  /** @type {HarnessApi | undefined} */
  let api;
  /** @param {string} name @returns {(...args: unknown[]) => void} */
  const record =
    (name) =>
    (...args) => {
      events.push({
        name,
        args,
        state: required(api).state(),
        snapshot: controlsStore.getSnapshot(),
        notifications: observedSnapshots.length,
      });
    };
  let seedingTimer = true;
  const timerHarness = createMatchTimerHarness(
    { activeMatchId: "live" },
    () => {
      const state = api?.state() ?? initial;
      return {
        boardViewMode: seedingTimer ? "historicalView" : state.boardViewMode,
        isReconnect: state.isReconnect,
        isWatchOnly: state.isWatchOnly,
        isGameOver: state.isGameOver,
      };
    },
    ([name, ...args]) =>
      record(name === "terminal" ? "restoreTimer" : name)(...args),
  );
  timerHarness.controller.update(
    true,
    { color: "white", timer: MATCH_TIMER_TERMINAL },
    "live",
  );
  seedingTimer = false;
  const board = {
    setBoardMetadataDisplaySwapped: record("setBoardMetadataDisplaySwapped"),
    setBoardFlipped: record("setBoardFlipped"),
    removeHighlights: record("removeHighlights"),
    hideItemSelectionOrConfirmationOverlay: record(
      "hideItemSelectionOrConfirmationOverlay",
    ),
    stopMonsBoardAsDisplayAnimations: record(
      "stopMonsBoardAsDisplayAnimations",
    ),
    runMonsBoardAsDisplayWaitingAnimation: record(
      "runMonsBoardAsDisplayWaitingAnimation",
    ),
    showBoardPlayersInfo: record("showBoardPlayersInfo"),
    hideBoardPlayersInfo: record("hideBoardPlayersInfo"),
    hideTimerCountdownDigits: record("hideTimerCountdownDigits"),
    hideAllMoveStatuses: record("hideAllMoveStatuses"),
    hasMonsBoardDisplayAnimationRunning: () => false,
  };
  const dependencies = {
    rematchViewing,
    matchTimers: {
      ...timerHarness.controller,
      cancelVictoryClaim() {
        record("cancelTimerVictoryClaim")();
        timerHarness.controller.cancelVictoryClaim();
      },
    },
    getCurrentSessionId: () => 1,
    isGameConnectionBound: () => false,
    batchGameControlsUpdates: controlsStore.batchUpdates,
    updateGameControlsContext: (
      /** @type {Partial<import("../src/game/gameControlsModel.ts").GameControlsContext>} */ context,
    ) => {
      controlsStore.updateContext(context);
      contexts.push(context);
    },
    initial,
    deriveBoardViewControls,
    Board: board,
    connection: {
      setWagerViewMatchId: record("wagerView"),
      rematchSeriesEndIsIndicated: () => true,
    },
    activeBoardShouldBeFlipped: () => false,
    getViewedMatchBoardFlipped: () => true,
    MonsRules: { Game: { fromFen: (/** @type {string} */ fen) => ({ fen }) } },
    getMoveHistorySourceGame: () => ({
      trackingEntries: [{ fen: "earlier" }, { fen: "latest" }],
    }),
    syncInviteBotIntoLocalGameButton: record(
      "syncInviteBotIntoLocalGameButton",
    ),
    refreshDisplayedMatchPresentation: record(
      "refreshDisplayedMatchPresentation",
    ),
    triggerMoveHistoryPopupReload: record("triggerMoveHistoryPopupReload"),
    setNewBoard: record("setNewBoard"),
    applyWagerState: record("applyWagerState"),
    markKnownWagerInitialStateReceived: record(
      "markKnownWagerInitialStateReceived",
    ),
    updateUndoButtonBasedOnGameState: record(
      "updateUndoButtonBasedOnGameState",
    ),
    scheduleHistoricalMatchArchiveRefresh: record(
      "scheduleHistoricalMatchArchiveRefresh",
    ),
    updateWagerDisplayForMoveNavigation: record(
      "updateWagerDisplayForMoveNavigation",
    ),
    disableAndHideUndoResignAndTimerControls() {
      record("disableAndHideUndoResignAndTimerControls")();
      controlsStore.dispatchGameControls({ type: "hideGameControls" });
    },
    /** @param {boolean} visible */
    setAutomoveActionVisible(visible) {
      record("setAutomoveActionVisible")(visible);
      controlsStore.dispatchGameControls({
        type: "setAutomoveVisible",
        visible,
      });
    },
    /** @param {boolean} visible */
    setUndoVisible(visible) {
      record("setUndoVisible")(visible);
      controlsStore.dispatchGameControls({ type: "setUndoVisible", visible });
    },
    /** @param {boolean} enabled */
    setUndoEnabled(enabled) {
      record("setUndoEnabled")(enabled);
      controlsStore.dispatchGameControls({ type: "setUndoEnabled", enabled });
    },
    hideTimerButtons() {
      record("hideTimerButtons")();
      controlsStore.dispatchGameControls({ type: "hideTimers" });
    },
    /** @param {boolean} value */
    setEndMatchVisible(value) {
      controlsStore.updatePresentation({ endMatchVisible: value });
      record("setEndMatchVisible")(value);
    },
    /** @param {boolean} value */
    setEndMatchConfirmed(value) {
      controlsStore.updatePresentation({ endMatchConfirmed: value });
      record("setEndMatchConfirmed")(value);
    },
    /** @param {boolean} value */
    showVoiceReactionButton(value) {
      controlsStore.updatePresentation({ voiceReactionVisible: value });
      record("showVoiceReactionButton")(value);
    },
    /** @param {string} value */
    showWaitingStateText(value) {
      controlsStore.updatePresentation({ waitingText: value });
      record("showWaitingStateText")(value);
    },
  };

  const { outputText } = ts.transpileModule(
    `${Object.keys(initial)
      .map((name) => `let ${name} = initial.${name};`)
      .join("\n")}
    ${declarations.join("\n")}
    function state() { return { ${Object.keys(initial).join(", ")}, selection: rematchViewing.getSelection() }; }
    return {
      state,
      setWaiting: (value) => { isWaitingForRematchResponse = value; },
      wait: enterWaitingLiveView,
      restore: restoreLiveBoardView,
      prepareLocal: prepareForNewLocalLiveMatch,
      history: (matchId, pair, game, sessionId) => enterHistoricalView(
        { matchId, pair, game },
        rematchViewing.beginSelection(() => isBoardRenderSessionActive(sessionId)),
      ),
      applyUi: applyBoardUiForCurrentView,
      selectMove: didSelectVerboseTrackingEntity,
    };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  );
  api = /** @type {HarnessApi} */ (
    new Function(...Object.keys(dependencies), outputText)(
      ...Object.values(dependencies),
    )
  );
  return {
    ...api,
    controlsStore,
    observedSnapshots,
    contexts,
    events,
    controls: () => controlsStore.getSnapshot().presentation.gameControls,
    names: () => events.map(({ name }) => name),
  };
}

/** @param {ReturnType<typeof harness>} h @param {ViewMode} mode */
function assertLivePreparation(h, mode) {
  const state = h.state();
  assert.equal(state.boardViewMode, mode);
  assert.equal(state.boardRenderSessionId, 6);
  assert.equal(state.selection, null);
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
  assert.deepEqual(required(wagerView).args, [null]);
  assert.equal(required(wagerView).state.selection, null);
  assert.equal(required(wagerView).snapshot.context.boardViewMode, mode);
  const flip = h.events.find(({ name }) => name === "setBoardFlipped");
  assert.equal(required(flip).state.flashbackMode, false);
  assert.deepEqual(required(flip).state.currentInputs, []);
}

test("waiting entry clears historical input and orientation before waiting UI and appearance", () => {
  const h = harness();
  h.wait();
  assert.deepEqual(h.observedSnapshots, [h.controlsStore.getSnapshot()]);
  assert.ok(h.events.every(({ notifications }) => notifications === 0));
  assertLivePreparation(h, "waitingLive");
  assert.equal(required(h.contexts.at(-1)).boardViewMode, "waitingLive");
  assert.deepEqual(h.names().slice(5), [
    "cancelTimerVictoryClaim",
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
  assert.deepEqual(h.observedSnapshots, [h.controlsStore.getSnapshot()]);
  assert.ok(h.events.every(({ notifications }) => notifications === 0));
  const rendered = h.events.find(({ name }) => name === "setNewBoard");
  assert.equal(required(rendered).snapshot.context.boardViewMode, "activeLive");
  assert.equal(
    required(rendered).snapshot.presentation.voiceReactionVisible,
    true,
  );
  assertLivePreparation(h, "activeLive");
  assert.equal(required(h.contexts.at(-1)).boardViewMode, "activeLive");
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
  assert.deepEqual(
    required(h.events.find(({ name }) => name === "restoreTimer")).args,
    [true, "white"],
  );
});

test("pending restoration stays waiting without restoring a live board or consuming its timer", () => {
  const h = harness({ isWaitingForRematchResponse: true });
  h.controlsStore.batchUpdates(() => {
    h.restore();
    assert.deepEqual(h.observedSnapshots, []);
    assert.equal(
      h.controlsStore.getSnapshot().context.boardViewMode,
      "waitingLive",
    );
  });
  assert.deepEqual(h.observedSnapshots, [h.controlsStore.getSnapshot()]);
  assertLivePreparation(h, "waitingLive");
  assert.equal(h.names().includes("setNewBoard"), false);
  assert.equal(h.names().includes("restoreTimer"), false);
  h.setWaiting(false);
  h.restore();
  assert.deepEqual(
    required(h.events.find(({ name }) => name === "restoreTimer")).args,
    [true, "white"],
  );
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
  const pair = matchPair("older");
  const historicalGame = labelledGame("older");
  assert.equal(h.history("older", pair, historicalGame, 5), true);
  assert.deepEqual(h.observedSnapshots, [h.controlsStore.getSnapshot()]);
  assert.ok(h.events.every(({ notifications }) => notifications === 0));
  assert.equal(
    required(h.events[0]).snapshot.context.boardViewMode,
    "historicalView",
  );
  const state = h.state();
  assert.equal(state.boardViewMode, "historicalView");
  assert.equal(state.boardRenderSessionId, 5);
  assert.equal(state.flashbackStateGame, historicalGame);
  assert.deepEqual(h.names().slice(0, 4), [
    "wagerView",
    "setBoardFlipped",
    "removeHighlights",
    "hideItemSelectionOrConfirmationOverlay",
  ]);
  assert.equal(
    required(required(h.events[0]).state.selection).matchId,
    "older",
  );
  assert.equal(required(required(h.events[1]).state.selection).pair, pair);
  assert.equal(required(h.events[2]).state.flashbackMode, true);
  assert.deepEqual(required(h.events[2]).state.currentInputs, []);
  assert.deepEqual(h.names().slice(-5), [
    "applyWagerState",
    "refreshDisplayedMatchPresentation",
    "setNewBoard",
    "scheduleHistoricalMatchArchiveRefresh",
    "triggerMoveHistoryPopupReload",
  ]);
  assert.deepEqual(
    required(
      h.events.find(
        ({ name }) => name === "scheduleHistoricalMatchArchiveRefresh",
      ),
    ).args,
    [],
  );
});

test("a stale historical entry cannot change state or emit effects", () => {
  const h = harness();
  const before = h.state();
  const snapshot = h.controlsStore.getSnapshot();
  assert.equal(
    Reflect.apply(h.history, undefined, ["older", {}, {}, 4]),
    false,
  );
  assert.deepEqual(h.state(), before);
  assert.deepEqual(h.events, []);
  assert.equal(h.controlsStore.getSnapshot(), snapshot);
  assert.deepEqual(h.observedSnapshots, []);
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
    "cancelTimerVictoryClaim",
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
      required(h.events.find(({ name }) => name === "showVoiceReactionButton"))
        .args,
      [!isWatchOnly],
    );
  }
});

test("view controls preserve independent timer and action state while clearing mode-specific controls", () => {
  for (const confirmation of /** @type {const} */ ([
    "none",
    "resign",
    "timer",
    "claim",
  ])) {
    /** @type {ControlsState} */
    const initial = {
      undo: { visible: true, enabled: true },
      automove: { visible: true, enabled: false },
      resignVisible: true,
      primaryAction: PrimaryActionType.Rematch,
      timer: {
        mode: "progressing",
        config: timerConfig,
        startEnabled: true,
        claimEnabled: false,
      },
      confirmation,
    };
    for (const boardViewMode of /** @type {const} */ ([
      "activeLive",
      "waitingLive",
      "historicalView",
    ])) {
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

test("a rejected historical selection publishes its changed context once without later effects", () => {
  const h = harness(
    { boardViewMode: "activeLive", flashbackMode: false },
    undefined,
    { rejectHistoricalCommit: true },
  );
  const before = h.state();
  h.controlsStore.batchUpdates(() => {
    assert.equal(
      Reflect.apply(h.history, undefined, ["older", {}, {}, 5]),
      false,
    );
    assert.equal(
      h.controlsStore.getSnapshot().context.boardViewMode,
      "historicalView",
    );
    assert.deepEqual(h.observedSnapshots, []);
  });
  assert.deepEqual(h.state(), { ...before, boardViewMode: "historicalView" });
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.observedSnapshots, [h.controlsStore.getSnapshot()]);
  h.observedSnapshots.length = 0;
  h.restore();
  assert.deepEqual(h.observedSnapshots, [h.controlsStore.getSnapshot()]);
  assert.equal(
    h.controlsStore.getSnapshot().context.boardViewMode,
    "activeLive",
  );
});
