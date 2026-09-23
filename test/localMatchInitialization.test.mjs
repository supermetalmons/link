import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as MonsRules from "mons-rules";
import { createGameVariantHelpers } from "@mons/shared/game-variants";
import ts from "typescript";

const variants = createGameVariantHelpers(MonsRules);
const randomVariant = variants
  .getAllGameVariantNames()
  .find((variant) => variant !== variants.legacyDefaultGameVariant);
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
  "initializeLocalMatch",
  "startFreshLocalMatch",
  "startBotMatch",
  "didClickStartBotGameButton",
  "didConfirmRematchProposal",
  "prepareForNewLocalLiveMatch",
  "nextBoardRenderSession",
  "clearViewedRematchState",
  "hasMoveHistoryFlipOverrideForCurrentSession",
  "baseBoardShouldBeFlipped",
  "activeBoardShouldBeFlipped",
  "canTrackLocalRematchSeries",
  "localRematchMatchIdForIndex",
  "ensureLocalRematchSeriesInitialized",
  "localColorFromMonsColor",
  "snapshotCurrentLocalMatchForHistory",
  "advanceLocalRematchSeriesToNextMatch",
  "resetTimerStateForMatch",
  "resetRemoteMoveHistories",
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

function harness({ bot = false } = {}) {
  const originalGame = variants.createGameModelForStoredVariant(randomVariant);
  const initial = {
    game: originalGame,
    currentGameVariant: randomVariant,
    isOnlineGame: false,
    isWatchOnly: false,
    puzzleMode: false,
    isGameWithBot: bot,
    isGameOver: true,
    isReconnect: true,
    didConnect: true,
    isWaitingForInviteToGetAccepted: true,
    isWaitingForRematchResponse: true,
    flashbackMode: true,
    resignedColor: MonsRules.Color.White,
    winnerByTimerColor: MonsRules.Color.Black,
    isInviteBotIntoLocalGameUnavailable: !bot,
    didMakeFirstLocalPlayerMoveOnLocalBoard: true,
    didStartLocalGame: false,
    whiteProcessedMovesCount: 8,
    blackProcessedMovesCount: 7,
    didSetWhiteProcessedMovesCount: true,
    didSetBlackProcessedMovesCount: true,
    currentGameModelMatchId: "previous-match",
    whiteFlatMovesString: "old-white-move",
    blackFlatMovesString: "old-black-move",
    currentInputs: ["old-selection"],
    botScoreReactionPlayedTurns: new Set([1]),
    remoteMoveHistories: new Map([["white", { moves: ["old-move"] }]]),
    remoteMoveHistoriesMatchId: "previous-match",
    timerStashMatchId: "previous-match",
    whiteTimerStash: "old-white-timer",
    blackTimerStash: "old-black-timer",
    pendingTimerResolutionOnRestore: "old-resolution",
    boardViewMode: "historicalView",
    boardRenderSessionId: 4,
    displayedHistoryViewId: 3,
    viewedRematchRequestToken: 2,
    viewedRematchMatchId: "older-match",
    viewedRematchGame: originalGame,
    viewedRematchPair: {},
    moveHistoryFlipOverrideEnabled: true,
    moveHistoryFlipOverrideSessionId: 4,
    moveHistoryFlipOverrideBaseBoardFlipped: false,
    playerSideColor: bot ? MonsRules.Color.Black : MonsRules.Color.White,
    botPlayerColor: MonsRules.Color.White,
    lastBotMoveTimestamp: 1234,
    localRematchSeriesIdSeed: 10,
    localRematchSeriesInviteId: "local-9",
    localActiveRematchMatchId: "local-9",
    localRematchMatchIds: ["local-9"],
    localRematchSnapshotsByMatchId: new Map(),
  };
  const ui = {};
  const renders = [];
  const automoves = [];
  const seeds = [];
  const scores = new Map();
  let api;
  const capture = () => ({
    ...api.state(),
    ui: { ...ui },
    renderCount: renders.length,
  });
  const noop = () => {};
  const setters = [
    "setHomeVisible",
    "setIslandButtonDimmed",
    "setUndoVisible",
    "setBrushAndNavigationButtonDimmed",
    "setInviteLinkActionVisible",
    "setAutomatchVisible",
    "setBotGameOptionVisible",
    "setNavigationListButtonVisible",
    "setAutomoveActionVisible",
    "setAutomoveActionEnabled",
    "showMoveHistoryButton",
    "showVoiceReactionButton",
    "setEndMatchVisible",
    "setEndMatchConfirmed",
    "showWaitingStateText",
  ];
  const dependencies = {
    initial,
    MonsRules,
    ...variants,
    ...Object.fromEntries(
      setters.map((name) => [name, (value) => (ui[name] = value)]),
    ),
    buildRandomGameSeed: () => {
      seeds.push("random");
      return variants.buildGameSeedForStoredVariant(randomVariant);
    },
    buildGameSeedForStoredVariant: (variant) => {
      seeds.push(variant);
      return variants.buildGameSeedForStoredVariant(variant);
    },
    isCreateInviteRoute: () => true,
    Board: {
      setBoardMetadataDisplaySwapped: (value) => (ui.metadataSwapped = value),
      setBoardFlipped: (value) => (ui.flipped = value),
      removeHighlights: () => (ui.highlights = false),
      hideItemSelectionOrConfirmationOverlay: () => (ui.selection = false),
      showOpponentAsBotPlayer: () => (ui.opponentIsBot = true),
      resetForNewGame: () => (ui.reset = true),
    },
    connection: { setWagerViewMatchId: (value) => (ui.wagerMatch = value) },
    rematchHistory: {
      setScore: (id, score) => scores.set(id, score),
      deleteScore: (id) => scores.delete(id),
    },
    applyBoardUiForCurrentView: noop,
    clearTimerActivationCooldownState: () => (ui.timerCooldown = null),
    showResignButton: () => (ui.resign = true),
    setNewBoard: () => renders.push(capture()),
    updateUndoButtonBasedOnGameState: () => (ui.undoSynchronized = true),
    syncInviteBotIntoLocalGameButton: () => (ui.inviteBotSynchronized = true),
    triggerMoveHistoryPopupReload: noop,
    dismissNotificationBannerIfNeeded: noop,
    automove: () => automoves.push(capture()),
  };
  const { outputText } = ts.transpileModule(
    `${Object.keys(initial)
      .map((name) => `let ${name} = initial.${name};`)
      .join("\n")}
    ${declarations.join("\n")}
    function state() { return {
      ${Object.keys(initial).join(", ")},
      botScoreReactionPlayedTurnCount: botScoreReactionPlayedTurns.size,
      remoteMoveHistoryCount: remoteMoveHistories.size,
    }; }
    return { state, startBot: didClickStartBotGameButton, rematch: didConfirmRematchProposal };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  );
  api = new Function(...Object.keys(dependencies), outputText)(
    ...Object.values(dependencies),
  );
  return { ...api, originalGame, ui, renders, automoves, seeds, scores };
}

function assertFreshMatch(state, bot) {
  for (const name of [
    "isGameOver",
    "isReconnect",
    "didConnect",
    "isWaitingForInviteToGetAccepted",
    "isWaitingForRematchResponse",
    "flashbackMode",
    "didMakeFirstLocalPlayerMoveOnLocalBoard",
    "didSetWhiteProcessedMovesCount",
    "didSetBlackProcessedMovesCount",
    "moveHistoryFlipOverrideEnabled",
  ])
    assert.equal(state[name], false, name);
  for (const name of [
    "currentGameModelMatchId",
    "whiteFlatMovesString",
    "blackFlatMovesString",
    "remoteMoveHistoriesMatchId",
    "timerStashMatchId",
    "whiteTimerStash",
    "blackTimerStash",
    "pendingTimerResolutionOnRestore",
    "viewedRematchMatchId",
    "viewedRematchGame",
    "viewedRematchPair",
  ])
    assert.equal(state[name], null, name);
  assert.equal(state.resignedColor, undefined);
  assert.equal(state.winnerByTimerColor, undefined);
  assert.equal(state.whiteProcessedMovesCount, 0);
  assert.equal(state.blackProcessedMovesCount, 0);
  assert.equal(state.botScoreReactionPlayedTurnCount, 0);
  assert.equal(state.remoteMoveHistoryCount, 0);
  assert.deepEqual(state.currentInputs, []);
  assert.equal(state.didStartLocalGame, true);
  assert.equal(state.isGameWithBot, bot);
  assert.equal(state.isInviteBotIntoLocalGameUnavailable, bot);
  assert.equal(state.boardViewMode, "activeLive");
  assert.equal(state.boardRenderSessionId, 5);
}

test("local rematch clears historical and terminal state while preserving history and alternating sides", () => {
  const h = harness();
  h.rematch();
  const state = h.state();
  assertFreshMatch(state, false);
  assert.equal(h.renders.length, 1);
  assertFreshMatch(h.renders[0], false);
  assert.notEqual(state.game, h.originalGame);
  assert.deepEqual(h.seeds, [variants.legacyDefaultGameVariant]);
  assert.equal(state.game.variant, variants.legacyDefaultGameVariant);
  assert.equal(state.playerSideColor, MonsRules.Color.Black);
  assert.equal(h.ui.flipped, true);
  assert.equal(h.ui.showVoiceReactionButton, false);
  assert.equal(h.ui.setEndMatchVisible, false);
  assert.equal(h.ui.setEndMatchConfirmed, false);
  assert.equal(h.ui.showWaitingStateText, "");
  assert.deepEqual(state.localRematchMatchIds, ["local-9", "local-91"]);
  assert.equal(state.localRematchSeriesInviteId, "local-9");
  assert.equal(state.localActiveRematchMatchId, "local-91");
  const previous = state.localRematchSnapshotsByMatchId.get("local-9");
  assert.equal(previous.gameModel, h.originalGame);
  assert.equal(previous.fen, h.originalGame.toFen());
  assert.equal(previous.resignedColor, "white");
  assert.equal(previous.boardFlipped, false);
  assert.ok(h.scores.has("local-9"));
  assert.equal(h.automoves.length, 0);
});

test("white bot start opens with one automove only after the new model, colors and controls are ready", () => {
  const h = harness();
  h.startBot();
  assert.equal(h.automoves.length, 1);
  const started = h.automoves[0];
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
  assert.equal(h.renders[0].game, started.game);
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
  const state = h.state();
  assertFreshMatch(state, true);
  assert.equal(state.botPlayerColor, MonsRules.Color.Black);
  assert.equal(state.playerSideColor, MonsRules.Color.White);
  assert.equal(state.game.activeColor, state.playerSideColor);
  assert.equal(h.ui.flipped, false);
  assert.deepEqual(h.seeds, ["random"]);
  assert.equal(state.game.variant, randomVariant);
  assert.deepEqual(state.localRematchMatchIds, ["local-9", "local-91"]);
  const previous = state.localRematchSnapshotsByMatchId.get("local-9");
  assert.equal(previous.gameModel, h.originalGame);
  assert.equal(previous.boardFlipped, true);
  assert.equal(h.renders.length, 1);
  assert.notEqual(h.renders[0].game, h.originalGame);
  assert.equal(h.automoves.length, 0);
});
