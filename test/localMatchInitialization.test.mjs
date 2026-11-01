import { required, canonicalMatch } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import * as MonsRules from "mons-rules";
import { createGameVariantHelpers } from "@mons/shared/game-variants";
import ts from "typescript";
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
const { createSessionControlsPresenter } =
  await import("../src/game/sessionControls.ts");
const { createRemoteMoveSyncController } =
  await import("../src/game/remoteMoveSyncController.ts");

const variants = createGameVariantHelpers(MonsRules);
const randomVariant = required(
  variants
    .getAllGameVariantNames()
    .find((variant) => variant !== variants.legacyDefaultGameVariant),
);
assert.ok(randomVariant);

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
  "resetMatchConnectionFlags",
  "initializeLocalMatch",
  "startFreshLocalMatch",
  "startBotMatch",
  "didClickStartBotGameButton",
  "didConfirmRematchProposal",
  "prepareForNewLocalLiveMatch",
  "prepareLiveBoardView",
  "clearBoardViewInputs",
  "nextBoardRenderSession",
  "hasMoveHistoryFlipOverrideForCurrentSession",
  "baseBoardShouldBeFlipped",
  "activeBoardShouldBeFlipped",
  "canTrackLocalRematchSeries",
  "ensureLocalRematchSeriesInitialized",
  "localColorFromMonsColor",
  "advanceLocalRematchSeriesToNextMatch",
  "resetBotScoreReactionState",
  "setCurrentVariant",
  "applyGameSeedToCurrentGame",
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

function harness({ bot = false, reconnecting = false } = {}) {
  const originalGame = variants.createGameModelForStoredVariant(randomVariant);
  /** @type {(Partial<import("../src/game/gameControlsModel.ts").GameControlsContext>)[]} */
  const contexts = [];
  const initial = {
    selectedProblem: null,
    game: originalGame,
    currentGameVariant: randomVariant,
    isOnlineGame: false,
    isWatchOnly: false,
    puzzleMode: false,
    isGameWithBot: bot,
    isGameOver: true,
    isReconnect: true,
    didConnect: !reconnecting,
    isWaitingForInviteToGetAccepted: true,
    isWaitingForRematchResponse: true,
    flashbackMode: true,
    resignedColor: /** @type {MonsRules.Color | undefined} */ (
      MonsRules.Color.White
    ),
    winnerByTimerColor: /** @type {MonsRules.Color | undefined} */ (
      MonsRules.Color.Black
    ),
    isInviteBotIntoLocalGameUnavailable: !bot,
    didMakeFirstLocalPlayerMoveOnLocalBoard: true,
    didStartLocalGame: false,
    currentInputs: ["old-selection"],
    botScoreReactionPlayedTurns: new Set([1]),
    boardViewMode:
      /** @type {import("../src/game/boardViewPolicy.ts").BoardViewMode} */ (
        "historicalView"
      ),
    boardRenderSessionId: 4,
    moveHistoryFlipOverrideEnabled: true,
    moveHistoryFlipOverrideSessionId: 4,
    moveHistoryFlipOverrideBaseBoardFlipped: false,
    playerSideColor: bot ? MonsRules.Color.Black : MonsRules.Color.White,
    botPlayerColor: MonsRules.Color.White,
    lastBotMoveTimestamp: 1234,
  };
  const controlsStore = createGameControlsStore({
    duration: 60,
    progress: 15,
    requestDate: 1000,
  });
  controlsStore.updateContext({
    ...Object.fromEntries(
      Object.keys(controlsStore.getSnapshot().context)
        .filter((key) => Object.hasOwn(initial, key))
        .map((key) => [key, Reflect.get(initial, key)]),
    ),
    sessionId: 1,
  });
  /**
   * @type {import("../src/game/gameControlsModel.ts").GameControlsSnapshot[]}
   */
  const observedSnapshots = [];
  controlsStore.subscribe(() =>
    observedSnapshots.push(controlsStore.getSnapshot()),
  );
  /** @typedef {Record<string, boolean | string | null | undefined>} UiState */
  /** @type {UiState} */
  const ui = {};
  /** @typedef {typeof initial & {botScoreReactionPlayedTurnCount: number, whiteProcessedMovesCount: number, blackProcessedMovesCount: number, remoteMovesInitialized: boolean, hasPendingRemoteMoves: boolean, selection: ReturnType<ReturnType<typeof createRematchViewingHarness>["getSelection"]>, localSeries: ReturnType<ReturnType<typeof createRematchViewingHarness>["getLocalSeriesDescriptor"]>}} ExtractedState */
  /** @typedef {ExtractedState & {timerMatchId: string | null, ui: UiState, renderCount: number, snapshot: ReturnType<typeof controlsStore.getSnapshot>, notifications: number}} Capture */
  /** @type {Capture[]} */
  const renders = [];
  /** @type {Capture[]} */
  const automoves = [];
  /**
   * @type {string[]}
   */
  const seeds = [];
  const rematchViewing = createRematchViewingHarness({
    selection: {
      matchId: "older-match",
      pair: {
        matchId: "older-match",
        hostPlayerId: "host",
        guestPlayerId: "guest",
        hostMatch: null,
        guestMatch: null,
      },
      game: originalGame,
    },
  });
  rematchViewing.ensureLocalSeries();
  /** @type {{state: () => ExtractedState, startBot: () => void, rematch: () => void} | undefined} */
  let api;
  const remoteMoveSync = createRemoteMoveSyncController({
    getGame: () => api?.state().game ?? initial.game,
    getActiveMatchId: () => "previous-match",
    createSessionGuard: () => () => true,
    isGameOver: () => api?.state().isGameOver ?? initial.isGameOver,
    onReplayOutput: () => assert.fail("unexpected replay during local startup"),
  });
  remoteMoveSync.setProcessedCounts(8, 7);
  remoteMoveSync.remember(
    canonicalMatch({
      color: "white",
      flatMovesString: Array(9).fill("old").join("-"),
    }),
    "previous-match",
  );
  Reflect.apply(remoteMoveSync.verifyHistory, remoteMoveSync, [
    { historyVerified: false },
    "previous-match",
    "old-white",
    "white",
  ]);
  const timerHarness = createMatchTimerHarness({
    activeMatchId: null,
    isOnlineGame: false,
  });
  timerHarness.controller.setStash("previous-match", "white", {
    state: "running",
    turnNumber: 1,
    deadlineAtMs: 100,
  });
  timerHarness.controller.setStash("previous-match", "black", {
    state: "running",
    turnNumber: 2,
    deadlineAtMs: 200,
  });
  /** @returns {Capture} */
  const capture = () => ({
    ...required(api).state(),
    timerMatchId: timerHarness.controller.getMatchId(),
    ui: { ...ui },
    renderCount: renders.length,
    snapshot: controlsStore.getSnapshot(),
    notifications: observedSnapshots.length,
  });
  const noop = () => {};
  /** @satisfies {Parameters<typeof createSessionControlsPresenter>[0]} */
  const commands = {
    setHomeVisible: (/** @type {boolean} */ value) => {
      ui.setHomeVisible = value;
    },
    setIslandButtonDimmed: (/** @type {boolean} */ value) => {
      ui.setIslandButtonDimmed = value;
    },
    setUndoVisible: (/** @type {boolean} */ value) => {
      ui.setUndoVisible = value;
    },
    setBrushAndNavigationButtonDimmed: (/** @type {boolean} */ value) => {
      ui.setBrushAndNavigationButtonDimmed = value;
    },
    setInviteLinkActionVisible: (/** @type {boolean} */ value) => {
      ui.setInviteLinkActionVisible = value;
    },
    setAutomatchVisible: (/** @type {boolean} */ value) => {
      ui.setAutomatchVisible = value;
    },
    setBotGameOptionVisible: (/** @type {boolean} */ value) => {
      ui.setBotGameOptionVisible = value;
    },
    setNavigationListButtonVisible: (/** @type {boolean} */ value) => {
      ui.setNavigationListButtonVisible = value;
    },
    setAutomoveActionVisible: (/** @type {boolean} */ value) => {
      ui.setAutomoveActionVisible = value;
    },
    setAutomoveActionEnabled: (/** @type {boolean} */ value) => {
      ui.setAutomoveActionEnabled = value;
    },
    showMoveHistoryButton: (/** @type {boolean} */ value) => {
      ui.showMoveHistoryButton = value;
    },
    showVoiceReactionButton: (/** @type {boolean} */ value) => {
      ui.showVoiceReactionButton = value;
    },
    setEndMatchVisible: (/** @type {boolean} */ value) => {
      ui.setEndMatchVisible = value;
    },
    setEndMatchConfirmed: (/** @type {boolean} */ value) => {
      ui.setEndMatchConfirmed = value;
    },
    showWaitingStateText: (/** @type {string} */ value) => {
      ui.showWaitingStateText = value;
    },
    showResignButton: () => {
      ui.resign = true;
    },
    setUndoEnabled: () => assert.fail("unexpected setUndoEnabled"),
    setAutomatchWaitingState: () =>
      assert.fail("unexpected setAutomatchWaitingState"),
    setPlaySamePuzzleAgainButtonVisible: () =>
      assert.fail("unexpected setPlaySamePuzzleAgainButtonVisible"),
    setAutomatchEnabled: () => assert.fail("unexpected setAutomatchEnabled"),
    setWatchOnlyVisible: () => assert.fail("unexpected setWatchOnlyVisible"),
    hideTimerButtons: () => assert.fail("unexpected hideTimerButtons"),
    disableAndHideUndoResignAndTimerControls: () =>
      assert.fail("unexpected disableAndHideUndoResignAndTimerControls"),
    showPrimaryAction: () => assert.fail("unexpected showPrimaryAction"),
  };
  const dependencies = {
    remoteMoveSync,
    rematchViewing,
    matchTimers: timerHarness.controller,
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
    MonsRules,
    ...variants,
    ...commands,
    buildRandomGameSeed: () => {
      seeds.push("random");
      return variants.buildGameSeedForStoredVariant(randomVariant);
    },
    buildGameSeedForStoredVariant: (
      /** @type {Parameters<typeof variants.buildGameSeedForStoredVariant>[0]} */ variant,
    ) => {
      assert.ok(typeof variant === "string");
      seeds.push(variant);
      return variants.buildGameSeedForStoredVariant(variant);
    },
    isCreateInviteRoute: () => true,
    Board: {
      setBoardMetadataDisplaySwapped: (/** @type {boolean} */ value) =>
        (ui.metadataSwapped = value),
      setBoardFlipped: (/** @type {boolean} */ value) => (ui.flipped = value),
      removeHighlights: () => (ui.highlights = false),
      hideItemSelectionOrConfirmationOverlay: () => (ui.selection = false),
      showOpponentAsBotPlayer: () => (ui.opponentIsBot = true),
      resetForNewGame: () => (ui.reset = true),
    },
    connection: {
      setWagerViewMatchId: (/** @type {string | null} */ value) =>
        (ui.wagerMatch = value),
    },
    applyBoardUiForCurrentView: noop,
    setNewBoard: () => renders.push(capture()),
    updateUndoButtonBasedOnGameState: () => (ui.undoSynchronized = true),
    syncInviteBotIntoLocalGameButton: () => (ui.inviteBotSynchronized = true),
    triggerMoveHistoryPopupReload: noop,
    dismissNotificationBannerIfNeeded: noop,
    automove: () => automoves.push(capture()),
  };
  /** @template {keyof typeof commands} K @param {K} name @param {(...args: Parameters<(typeof commands)[K]>) => void} update */
  const wrap = (name, update) => {
    const command = commands[name];
    Reflect.set(
      commands,
      name,
      (/** @type {Parameters<(typeof commands)[K]>} */ ...args) => {
        update(...args);
        Reflect.apply(command, commands, args);
      },
    );
  };
  wrap("setHomeVisible", (value) =>
    controlsStore.updatePresentation({ homeVisible: value }),
  );
  wrap("setBotGameOptionVisible", (value) =>
    controlsStore.updatePresentation({ botGameVisible: value }),
  );
  wrap("setNavigationListButtonVisible", (value) =>
    controlsStore.updatePresentation({ navigationVisible: value }),
  );
  wrap("showMoveHistoryButton", (value) =>
    controlsStore.updatePresentation({ moveHistoryVisible: value }),
  );
  wrap("showVoiceReactionButton", (value) =>
    controlsStore.updatePresentation({ voiceReactionVisible: value }),
  );
  wrap("setEndMatchVisible", (value) =>
    controlsStore.updatePresentation({ endMatchVisible: value }),
  );
  wrap("setEndMatchConfirmed", (value) =>
    controlsStore.updatePresentation({ endMatchConfirmed: value }),
  );
  wrap("showWaitingStateText", (value) =>
    controlsStore.updatePresentation({ waitingText: value }),
  );
  wrap("setUndoVisible", (visible) =>
    controlsStore.dispatchGameControls({ type: "setUndoVisible", visible }),
  );
  wrap("setAutomoveActionVisible", (visible) =>
    controlsStore.dispatchGameControls({ type: "setAutomoveVisible", visible }),
  );
  wrap("setAutomoveActionEnabled", (enabled) =>
    controlsStore.dispatchGameControls({ type: "setAutomoveEnabled", enabled }),
  );
  wrap("showResignButton", () =>
    controlsStore.dispatchGameControls({ type: "showResign" }),
  );
  wrap("setBrushAndNavigationButtonDimmed", (dimmed) =>
    controlsStore.updatePresentation({
      navigationDimmed: dimmed,
      appearanceDimmed: dimmed,
    }),
  );
  wrap("setInviteLinkActionVisible", (visible) =>
    controlsStore.updatePresentation({
      inviteLinkVisible: visible,
      ...(!visible ? { inviteReadyToCopy: false } : {}),
    }),
  );
  Object.assign(dependencies, commands);
  const presenter = createSessionControlsPresenter(dependencies);
  Object.assign(dependencies, presenter);
  const { outputText } = ts.transpileModule(
    `${Object.keys(initial)
      .map((name) => `let ${name} = initial.${name};`)
      .join("\n")}
    ${declarations.join("\n")}
    function state() { return {
      ${Object.keys(initial).join(", ")},
      botScoreReactionPlayedTurnCount: botScoreReactionPlayedTurns.size,
      whiteProcessedMovesCount: remoteMoveSync.getProcessedCount("white"),
      blackProcessedMovesCount: remoteMoveSync.getProcessedCount("black"),
      remoteMovesInitialized: remoteMoveSync.hasInitializedBothSides(),
      hasPendingRemoteMoves: remoteMoveSync.hasPendingMoves(),
      selection: rematchViewing.getSelection(),
      localSeries: rematchViewing.getLocalSeriesDescriptor(),
    }; }
    return { state, startBot: didClickStartBotGameButton, rematch: didConfirmRematchProposal };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  );
  api = new Function(...Object.keys(dependencies), outputText)(
    ...Object.values(dependencies),
  );
  return {
    ...required(api),
    state: () => ({
      ...required(api).state(),
      timerMatchId: timerHarness.controller.getMatchId(),
    }),
    controlsStore,
    observedSnapshots,
    contexts,
    originalGame,
    ui,
    renders,
    automoves,
    seeds,
    rematchViewing,
    assertVerificationReset: () => {
      Reflect.apply(remoteMoveSync.verifyHistory, remoteMoveSync, [
        {
          historyVerified: false,
          verifyHistory: () =>
            assert.fail("previous match verification was retained"),
        },
        "previous-match",
        "new-black",
        "black",
      ]);
    },
  };
}

/** @param {ReturnType<ReturnType<typeof harness>["state"]>} state @param {boolean} bot */
function assertFreshMatch(state, bot) {
  for (const name of /** @type {const} */ ([
    "isGameOver",
    "isReconnect",
    "didConnect",
    "isWaitingForInviteToGetAccepted",
    "isWaitingForRematchResponse",
    "flashbackMode",
    "didMakeFirstLocalPlayerMoveOnLocalBoard",
    "remoteMovesInitialized",
    "hasPendingRemoteMoves",
    "moveHistoryFlipOverrideEnabled",
  ]))
    assert.equal(state[name], false, name);
  assert.equal(state.timerMatchId, null);
  assert.equal(state.resignedColor, undefined);
  assert.equal(state.winnerByTimerColor, undefined);
  assert.equal(state.whiteProcessedMovesCount, 0);
  assert.equal(state.blackProcessedMovesCount, 0);
  assert.equal(state.botScoreReactionPlayedTurnCount, 0);
  assert.deepEqual(state.currentInputs, []);
  assert.equal(state.didStartLocalGame, true);
  assert.equal(state.selection, null);
  assert.equal(state.isGameWithBot, bot);
  assert.equal(state.isInviteBotIntoLocalGameUnavailable, bot);
  assert.equal(state.boardViewMode, "activeLive");
  assert.equal(state.boardRenderSessionId, 5);
}

/** @param {Record<string, boolean | string | null | undefined>} ui */
function assertPlayableControls(ui) {
  assert.equal(ui.setUndoVisible, true);
  assert.equal(ui.setAutomoveActionVisible, true);
  assert.equal(ui.setAutomoveActionEnabled, true);
  assert.equal(ui.showMoveHistoryButton, true);
  assert.equal(ui.resign, true);
  assert.equal(ui.setInviteLinkActionVisible, false);
  assert.equal(ui.setAutomatchVisible, false);
  assert.equal(ui.setBotGameOptionVisible, false);
  assert.equal(ui.setNavigationListButtonVisible, false);
}

test("local rematch clears historical and terminal state while preserving history and alternating sides", () => {
  const h = harness();
  h.rematch();
  h.assertVerificationReset();
  assert.deepEqual(h.observedSnapshots, [h.controlsStore.getSnapshot()]);
  for (const render of h.renders) {
    assert.equal(render.notifications, 0);
    assert.equal(render.snapshot.context.boardViewMode, "activeLive");
    assert.equal(render.snapshot.context.isGameOver, false);
    assert.equal(render.snapshot.presentation.gameControls.resignVisible, true);
  }
  const state = h.state();
  assertFreshMatch(state, false);
  assert.equal(h.renders.length, 1);
  assertFreshMatch(required(h.renders[0]), false);
  assertPlayableControls(required(h.renders[0]).ui);
  assert.notEqual(state.game, h.originalGame);
  assert.deepEqual(h.seeds, [variants.legacyDefaultGameVariant]);
  assert.equal(state.game.variant, variants.legacyDefaultGameVariant);
  assert.equal(state.playerSideColor, MonsRules.Color.Black);
  assert.equal(h.ui.flipped, true);
  assert.equal(h.ui.showVoiceReactionButton, false);
  assert.equal(h.ui.setEndMatchVisible, false);
  assert.equal(h.ui.setEndMatchConfirmed, false);
  assert.equal(h.ui.showWaitingStateText, "");
  assert.deepEqual(
    required(state.localSeries).matches.map((match) => match.matchId),
    ["local-1", "local-11"],
  );
  assert.equal(required(state.localSeries).inviteId, "local-1");
  assert.equal(required(state.localSeries).activeMatchId, "local-11");
  const previous = required(h.rematchViewing.getLocalSnapshot("local-1"));
  assert.equal(previous.gameModel, h.originalGame);
  assert.equal(previous.fen, h.originalGame.toFen());
  assert.equal(previous.resignedColor, "white");
  assert.equal(previous.boardFlipped, false);
  assert.ok(h.rematchViewing.getScore("local-1"));
  assert.equal(h.automoves.length, 0);
});

test("white bot start opens with one automove only after the new model, colors and controls are ready", () => {
  const h = harness();
  h.startBot();
  h.assertVerificationReset();
  assert.deepEqual(h.observedSnapshots, [h.controlsStore.getSnapshot()]);
  for (const render of h.renders) {
    assert.equal(render.notifications, 0);
    assert.equal(render.snapshot.context.boardViewMode, "activeLive");
    assert.equal(render.snapshot.context.isGameOver, false);
    assert.equal(render.snapshot.presentation.gameControls.resignVisible, true);
  }
  assert.equal(required(h.contexts.at(-1)).isGameWithBot, true);
  assert.equal(required(h.contexts.at(-1)).isGameOver, false);
  assert.equal(h.automoves.length, 1);
  const started = required(h.automoves[0]);
  assert.equal(started.notifications, 0);
  assert.equal(started.snapshot, h.controlsStore.getSnapshot());
  assertFreshMatch(started, true);
  assert.notEqual(started.game, h.originalGame);
  assert.equal(started.game.variant, randomVariant);
  assert.deepEqual(h.seeds, ["random"]);
  assert.equal(started.botPlayerColor, MonsRules.Color.White);
  assert.equal(started.playerSideColor, MonsRules.Color.Black);
  assert.equal(started.game.activeColor, started.botPlayerColor);
  assert.equal(started.lastBotMoveTimestamp, 0);
  assert.equal(started.renderCount, 1);
  assert.equal(h.renders.length, 1);
  assert.equal(required(h.renders[0]).game, started.game);
  assertPlayableControls(required(h.renders[0]).ui);
  assert.equal(started.ui.flipped, true);
  assert.equal(started.ui.opponentIsBot, true);
  assert.equal(started.ui.reset, true);
  assert.equal(started.ui.showVoiceReactionButton, true);
  assert.equal(started.ui.setAutomoveActionVisible, true);
  assert.equal(started.ui.showMoveHistoryButton, true);
  assert.equal(started.ui.resign, true);
  assert.equal(started.ui.undoSynchronized, true);
  assert.equal(started.ui.inviteBotSynchronized, true);
});

test("bot rematch preserves the previous game, switches the bot to black and waits for the human", () => {
  const h = harness({ bot: true });
  h.rematch();
  h.assertVerificationReset();
  assert.deepEqual(h.observedSnapshots, [h.controlsStore.getSnapshot()]);
  for (const render of h.renders) {
    assert.equal(render.notifications, 0);
    assert.equal(render.snapshot.context.boardViewMode, "activeLive");
    assert.equal(render.snapshot.context.isGameOver, false);
    assert.equal(render.snapshot.presentation.gameControls.resignVisible, true);
  }
  const state = h.state();
  assertFreshMatch(state, true);
  assert.equal(state.botPlayerColor, MonsRules.Color.Black);
  assert.equal(state.playerSideColor, MonsRules.Color.White);
  assert.equal(state.game.activeColor, state.playerSideColor);
  assert.equal(h.ui.flipped, false);
  assert.deepEqual(h.seeds, ["random"]);
  assert.equal(state.game.variant, randomVariant);
  assert.deepEqual(
    required(state.localSeries).matches.map((match) => match.matchId),
    ["local-1", "local-11"],
  );
  const previous = required(h.rematchViewing.getLocalSnapshot("local-1"));
  assert.equal(previous.gameModel, h.originalGame);
  assert.equal(previous.boardFlipped, true);
  assert.equal(h.renders.length, 1);
  assert.notEqual(required(h.renders[0]).game, h.originalGame);
  assertPlayableControls(required(h.renders[0]).ui);
  assert.equal(h.automoves.length, 0);
});

test("a rematch while reconnecting returns without publishing controls or starting a match", () => {
  const h = harness({ reconnecting: true });
  const before = h.controlsStore.getSnapshot();
  const state = h.state();
  h.controlsStore.batchUpdates(() => {
    assert.equal(h.rematch(), undefined);
    assert.equal(h.controlsStore.getSnapshot(), before);
    assert.deepEqual(h.observedSnapshots, []);
  });
  assert.deepEqual(h.state(), state);
  assert.deepEqual(h.renders, []);
  assert.deepEqual(h.seeds, []);
  assert.deepEqual(h.observedSnapshots, []);
  h.controlsStore.updatePresentation({ homeVisible: true });
  assert.deepEqual(h.observedSnapshots, [h.controlsStore.getSnapshot()]);
});
