import { canonicalMatch, required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as MonsRules from "mons-rules";
import ts from "typescript";
import { createRematchViewingHarness } from "./fixtures/rematchViewingHarness.mjs";

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
  "hasMoveHistoryFlipOverrideForCurrentSession",
  "clearMoveHistoryFlipOverrideForCurrentSession",
  "nextBoardRenderSession",
  "baseBoardShouldBeFlipped",
  "activeBoardShouldBeFlipped",
  "canTrackLocalRematchSeries",
  "getLocalRematchSeriesDescriptor",
  "getActiveRematchSeriesDescriptor",
  "getRematchIndexByMatchId",
  "getViewedMatchBoardFlipped",
  "getMoveHistorySourceGame",
  "getRematchSeriesNavigatorItems",
  "didToggleMoveHistoryBoardFlip",
  "didSelectVerboseTrackingEntity",
  "didOpenMoveHistoryPopup",
  "didDismissMoveHistoryPopup",
  "scheduleHistoricalMatchArchiveRefresh",
].map((name) => {
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(declaration, name);
  return declaration.getText(source).replace(/^export /, "");
});

function gameWithMoves() {
  const game = new MonsRules.Game();
  for (const move of ["l10,5;l9,4", "l9,4;l8,5"]) {
    assert.equal(game.playFen(move).kind, "complete");
  }
  return game;
}

function harness({ historical = true, online = true, flipped = true } = {}) {
  const liveGame = gameWithMoves();
  const historicalGame = gameWithMoves();
  const earlierGame = required(
    MonsRules.Game.fromFen(required(historicalGame.trackingEntries[0]).fen),
  );
  /** @type {import("@mons/shared/game-sessions").HistoricalMatchPair} */
  const pair = {
    matchId: "match-0",
    hostPlayerId: "host",
    guestPlayerId: "guest",
    hostMatch: canonicalMatch({
      color: "white",
      emojiId: 1,
      aura: "none",
      fen: historicalGame.toFen(),
    }),
    guestMatch: canonicalMatch({
      color: "black",
      emojiId: 2,
      aura: "none",
      fen: historicalGame.toFen(),
    }),
  };
  /**
   * @type {import("@mons/shared/game-sessions").HistoricalMatchPair | PromiseLike<import("@mons/shared/game-sessions").HistoricalMatchPair | null> | null}
   */
  let archivedPair = null;
  let nextTimeoutId = 0;
  /** @type {Map<number, () => void>} */
  const timeouts = new Map();
  const viewer = createRematchViewingHarness({
    selection: historical
      ? { matchId: pair.matchId, pair, game: historicalGame }
      : null,
    loadMatchPair: async () => archivedPair,
    buildHistoricalGame: () => historicalGame,
    setTimeout: (callback) => {
      const id = ++nextTimeoutId;
      timeouts.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timeouts.delete(id),
  });
  /** @type {Array<[string, ...unknown[]]>} */
  const events = [];
  /** @type {{boardViewMode: "historicalView" | "activeLive"; boardRenderSessionId: number; moveHistoryFlipOverrideEnabled: boolean; moveHistoryFlipOverrideSessionId: number | null; moveHistoryFlipOverrideBaseBoardFlipped: boolean | null; playerSideColor: MonsRules.Color; isMoveHistoryPopupOpen: boolean; flashbackMode: boolean; flashbackStateGame: MonsRules.Game | null; game: MonsRules.Game; currentInputs: string[]; isOnlineGame: boolean; isWatchOnly: boolean; puzzleMode: boolean; isGameWithBot: boolean}} */
  const initial = {
    boardViewMode: historical ? "historicalView" : "activeLive",
    boardRenderSessionId: 1,
    moveHistoryFlipOverrideEnabled: false,
    moveHistoryFlipOverrideSessionId: null,
    moveHistoryFlipOverrideBaseBoardFlipped: null,
    playerSideColor: MonsRules.Color.White,
    isMoveHistoryPopupOpen: true,
    flashbackMode: true,
    flashbackStateGame: earlierGame,
    game: liveGame,
    currentInputs: ["old-input"],
    isOnlineGame: online,
    isWatchOnly: false,
    puzzleMode: false,
    isGameWithBot: false,
  };
  const board = {
    isFlipped: flipped,
    metadataSwapped: false,
    /**
     * @param {boolean} value
     */
    setBoardFlipped(value) {
      board.isFlipped = value;
      events.push(["flip", value]);
    },
    /**
     * @param {boolean} value
     */
    setBoardMetadataDisplaySwapped(value) {
      board.metadataSwapped = value;
      events.push(["metadata", value]);
    },
    removeHighlights: () => events.push(["clearHighlights"]),
    hideItemSelectionOrConfirmationOverlay: () =>
      events.push(["clearSelection"]),
  };
  /** @typedef {{state(): typeof initial & {selection: ReturnType<typeof viewer.getSelection>}; setState(values: Partial<typeof initial>): void; flip: typeof import("../src/game/gameController.ts").didToggleMoveHistoryBoardFlip; dismiss: typeof import("../src/game/gameController.ts").didDismissMoveHistoryPopup; selectMove: typeof import("../src/game/gameController.ts").didSelectVerboseTrackingEntity; open: typeof import("../src/game/gameController.ts").didOpenMoveHistoryPopup; orientation(matchId: string, pair: import("@mons/shared/game-sessions").HistoricalMatchPair): boolean; navigator: typeof import("../src/game/gameController.ts").getRematchSeriesNavigatorItems; refreshArchive(): void; nextRender(): void}} HistoryApi */
  /** @type {HistoryApi} */
  let api;
  const dependencies = {
    initial,
    MonsRules,
    Board: board,
    rematchViewing: viewer,
    connection: {
      getActiveMatchId: () => "match-2",
      getRematchSeriesDescriptor: () => ({
        inviteId: "invite",
        activeMatchId: "match-2",
        hasSeries: true,
        matches: [0, 1, 2].map((index) => ({
          matchId: `match-${index}`,
          index,
          isActiveMatch: index === 2,
          isPendingResponse: false,
        })),
      }),
    },
    isCreateInviteRoute: () => true,
    getViewedMatchPlayerColor: () => "black",
    setNewBoard: (/** @type {boolean} */ flashback) =>
      events.push(["board", flashback, api.state().flashbackStateGame]),
    updateWagerDisplayForMoveNavigation: (
      /** @type {[number, number]} */ ...args
    ) => events.push(["wagerMove", ...args]),
    applyWagerState: () => events.push(["wager"]),
    triggerMoveHistoryPopupReload: () => events.push(["reload"]),
    syncInviteBotIntoLocalGameButton: () => events.push(["inviteBot"]),
    updateBoardMoveStatuses: (/** @type {unknown[]} */ ...args) =>
      events.push(["statuses", ...args]),
    refreshDisplayedMatchPresentation: () =>
      events.push(["appearance", required(viewer.getSelection()).pair]),
  };
  const keys = Object.keys(initial);
  const { outputText } = ts.transpileModule(
    `${keys.map((key) => `let ${key} = initial.${key};`).join("\n")}
    ${declarations.join("\n")}
    return {
      state: () => ({ ${keys.join(",")}, selection: rematchViewing.getSelection() }),
      setState: (values) => { ${keys.map((key) => `if (Object.hasOwn(values, "${key}")) ${key} = values.${key};`).join("\n")} },
      flip: didToggleMoveHistoryBoardFlip,
      dismiss: didDismissMoveHistoryPopup,
      selectMove: didSelectVerboseTrackingEntity,
      open: didOpenMoveHistoryPopup,
      orientation: getViewedMatchBoardFlipped,
      navigator: getRematchSeriesNavigatorItems,
      refreshArchive: scheduleHistoricalMatchArchiveRefresh,
      nextRender: nextBoardRenderSession,
    };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  );
  api = /** @type {HistoryApi} */ (
    new Function(...Object.keys(dependencies), outputText)(
      ...Object.values(dependencies),
    )
  );
  return {
    ...api,
    viewer,
    board,
    pair,
    liveGame,
    historicalGame,
    earlierGame,
    events,
    archive: (/** @type {typeof archivedPair} */ value) => {
      archivedPair = value;
    },
    runArchive: async () => {
      const [id, callback] = required(timeouts.entries().next().value);
      timeouts.delete(id);
      callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("dismissing historical move history restores the selected complete game and retains its view", () => {
  const h = harness();
  h.dismiss();
  const state = h.state();
  assert.equal(state.boardViewMode, "historicalView");
  assert.equal(required(state.selection).game, h.historicalGame);
  assert.equal(state.flashbackStateGame, h.historicalGame);
  assert.equal(state.flashbackMode, true);
  assert.equal(state.isMoveHistoryPopupOpen, false);
  assert.deepEqual(state.currentInputs, []);
  assert.equal(h.board.isFlipped, true);
  assert.deepEqual(
    h.events.map(([name]) => name),
    ["clearHighlights", "clearSelection", "board", "wager", "inviteBot"],
  );
  assert.equal(required(h.events[2])[1], true);
});

test("dismissing live flashback restores live orientation and board without entering historical view", () => {
  const h = harness({ historical: false });
  h.dismiss();
  assert.equal(h.state().boardViewMode, "activeLive");
  assert.equal(h.state().selection, null);
  assert.equal(h.state().flashbackMode, false);
  assert.equal(h.board.isFlipped, false);
  assert.deepEqual(
    h.events.map(([name]) => name),
    ["flip", "board", "wager", "inviteBot"],
  );
  assert.equal(required(h.events[1])[1], false);
});

test("flip toggles restore the original orientation and metadata while retaining a scrubbed game", () => {
  const h = harness();
  const count = h.historicalGame.trackingEntries.length;
  h.flip(0);
  assert.equal(h.board.isFlipped, false);
  assert.equal(h.board.metadataSwapped, true);
  assert.equal(required(h.state().selection).game, h.historicalGame);
  assert.equal(h.state().flashbackStateGame, h.earlierGame);
  assert.deepEqual(
    h.events.map(([name]) => name),
    ["metadata", "flip", "board", "wagerMove", "reload"],
  );
  assert.deepEqual(h.events[3], ["wagerMove", 0, count]);
  h.events.length = 0;
  h.flip(0);
  assert.equal(h.board.isFlipped, true);
  assert.equal(h.board.metadataSwapped, false);
  assert.equal(h.state().moveHistoryFlipOverrideEnabled, false);
  assert.deepEqual(
    h.events.map(([name]) => name),
    ["metadata", "flip", "board", "wagerMove", "reload"],
  );
});

test("a new board render clears flip override metadata before subsequent view orientation", () => {
  const h = harness();
  h.flip(0);
  h.nextRender();
  assert.equal(h.state().moveHistoryFlipOverrideEnabled, false);
  assert.equal(h.state().moveHistoryFlipOverrideBaseBoardFlipped, null);
  assert.equal(h.board.metadataSwapped, false);
  assert.equal(h.orientation("match-0", h.pair), false);
  assert.equal(h.orientation("match-1", h.pair), true);
});

test("online rematch orientation and navigator side alternate by match index", () => {
  const h = harness();
  assert.equal(h.orientation("match-0", h.pair), false);
  assert.equal(h.orientation("match-1", h.pair), true);
  assert.equal(h.orientation("unlisted", h.pair), true);
  assert.deepEqual(
    h.navigator().map((item) => item.playerIsWhite),
    [true, false, true],
  );
  h.setState({ playerSideColor: MonsRules.Color.Black });
  assert.equal(h.orientation("match-0", h.pair), true);
  assert.equal(h.orientation("match-1", h.pair), false);
  assert.deepEqual(
    h.navigator().map((item) => item.playerIsWhite),
    [false, true, false],
  );
});

test("local historical orientation uses its saved base side while the navigator alternates sides", () => {
  const h = harness({ online: false });
  h.viewer.advanceLocalSeries({
    gameVariant: h.historicalGame.variant,
    gameModel: h.historicalGame,
    boardFlipped: true,
    resignedColor: null,
  });
  assert.equal(h.orientation("local-1", h.pair), true);
  assert.deepEqual(
    h.navigator().map((item) => item.playerIsWhite),
    [false, true],
  );
  h.flip(0);
  assert.equal(h.orientation("local-1", h.pair), true);
});

test("archival appearance refresh preserves the selected and scrubbed gameplay models", async () => {
  const h = harness();
  h.viewer.seedProvisional(h.pair);
  h.refreshArchive();
  h.selectMove(0);
  const scrubbed = h.state().flashbackStateGame;
  h.events.length = 0;
  h.archive({
    ...h.pair,
    hostMatch: {
      ...required(h.pair.hostMatch),
      emojiId: 7,
      aura: "rainbow",
      fen: "new-fen",
    },
  });
  await h.runArchive();
  assert.equal(h.state().flashbackStateGame, scrubbed);
  assert.equal(required(h.state().selection).game, h.historicalGame);
  assert.equal(
    required(required(h.state().selection).pair.hostMatch).fen,
    required(h.pair.hostMatch).fen,
  );
  assert.equal(
    required(required(h.state().selection).pair.hostMatch).emojiId,
    7,
  );
  assert.deepEqual(
    h.events.map(([name]) => name),
    ["appearance", "reload"],
  );
});
