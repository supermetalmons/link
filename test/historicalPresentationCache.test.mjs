import { required, canonicalMatch } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";
import { Game } from "mons-rules";
import ts from "typescript";
import { createRematchViewingHarness } from "./fixtures/rematchViewingHarness.mjs";

registerTypeScriptTestHooks();

const { countRecordedMovesInHistoricalPair, getTrustedGameFromMatchPair } =
  await import("../src/game/historicalMatchModels.ts");
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
const functions = [
  "publishGameControlsContext",
  "scheduleHistoricalMatchArchiveRefresh",
  "enterHistoricalView",
  "clearBoardViewInputs",
  "nextBoardRenderSession",
  "isBoardRenderSessionActive",
  "didSelectRematchSeriesMatch",
]
  .map((name) => {
    const declaration = source.statements.find(
      (statement) =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );
    assert.ok(declaration && ts.isFunctionDeclaration(declaration));
    assert.ok(declaration, name);
    return declaration.getText(source).replace(/^export /, "");
  })
  .join("\n");
/**
 * @typedef {import("@mons/shared/game-sessions").HistoricalMatchPair} HistoricalPair
 * @typedef {import("@mons/shared/game-sessions").GameSessionMatch} MatchRecord
 * @typedef {HistoricalPair & { hostMatch: MatchRecord, guestMatch: MatchRecord }} Pair
 * @typedef {{ select(pair: HistoricalPair): boolean, navigate: typeof import("../src/game/gameController.ts").didSelectRematchSeriesMatch, leave(): void }} HarnessApi
 */
/** @returns {Pair} */
const pair = (emojiId = 1) => ({
  matchId: "invite",
  hostPlayerId: "host",
  guestPlayerId: "guest",
  hostMatch: canonicalMatch({ emojiId, fen: "local-host" }),
  guestMatch: canonicalMatch({
    color: "black",
    emojiId: 2,
    fen: "local-guest",
  }),
});
/** @template [T=HistoricalPair | null] @returns {Pick<PromiseWithResolvers<T>, "promise" | "resolve">} */
const deferred = () => {
  /** @type {PromiseWithResolvers<T>} */
  const pending = Promise.withResolvers();
  return { promise: pending.promise, resolve: pending.resolve };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** @param {(matchId: string) => Promise<HistoricalPair | null>} [load] @param {(pair: HistoricalPair) => Game} [buildGame] */
function harness(load = async () => null, buildGame = () => new Game()) {
  const controlsStore = createGameControlsStore({
    duration: 90,
    progress: 0,
    requestDate: 1,
  });
  /** @type {(Partial<import("../src/game/gameControlsModel.ts").GameControlsContext>)[]} */
  const contexts = [];
  /** @type {({ id: number; callback: () => void; delay: number; })[]} */
  const timers = [];
  /**
   * @type {number[]}
   */
  const retryWaits = [];
  let nextTimerId = 0;
  let loads = 0;
  let paints = 0;
  let sessionVersion = 1;
  const rematchViewing = createRematchViewingHarness({
    loadMatchPair: async (matchId) => {
      loads++;
      return load(matchId);
    },
    buildHistoricalGame: (_matchId, pair) => buildGame(pair),
    countRecordedMoves: (_matchId, pair) =>
      countRecordedMovesInHistoricalPair(pair, "white"),
    createSessionGuard: () => {
      const captured = sessionVersion;
      return () => captured === sessionVersion;
    },
    setTimeout: (callback, delay) => {
      const id = ++nextTimerId;
      timers.push({ id, callback, delay });
      return id;
    },
    clearTimeout: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index !== -1) timers.splice(index, 1);
    },
    wait: async (delay) => {
      retryWaits.push(delay);
    },
  });
  const dependencies = {
    batchGameControlsUpdates: controlsStore.batchUpdates,
    getCurrentSessionId: () => sessionVersion,
    isGameConnectionBound: () => false,
    updateGameControlsContext: (
      /** @type {Partial<import("../src/game/gameControlsModel.ts").GameControlsContext>} */ context,
    ) => {
      controlsStore.updateContext(context);
      contexts.push(context);
    },
    isWatchOnly: false,
    isGameWithBot: false,
    puzzleMode: false,
    isGameOver: false,
    selectedProblem: null,
    rematchViewing,
    buildGame,
    isOnlineGame: true,
    connection: { setWagerViewMatchId: () => {} },
    refreshDisplayedMatchPresentation: () => {
      paints++;
    },
    triggerMoveHistoryPopupReload: () => {},
    Board: {
      playerSideMetadata: { uid: "host" },
      setBoardFlipped: () => {},
      setBoardMetadataDisplaySwapped: () => {},
      removeHighlights: () => {},
      hideItemSelectionOrConfirmationOverlay: () => {},
    },
    getViewedMatchBoardFlipped: () => false,
    applyBoardUiForCurrentView: () => {},
    applyWagerState: () => {},
    ensureBoardViewInvariants: () => {},
    setNewBoard: () => {},
    boardViewDebugLogsEnabled: false,
    hasMoveHistoryFlipOverrideForCurrentSession: () => false,
    getActiveRematchSeriesDescriptor: () => ({ activeMatchId: "invite2" }),
    activeBoardShouldBeFlipped: () => false,
  };
  const { outputText } = ts.transpileModule(
    `
    let boardViewMode = "activeLive";
    let flashbackMode = false;
    let flashbackStateGame = null;
    let currentInputs = [];
    let boardRenderSessionId = 1;
    let moveHistoryFlipOverrideEnabled = false;
    let moveHistoryFlipOverrideSessionId = null;
    let moveHistoryFlipOverrideBaseBoardFlipped = null;
    ${functions}
  `,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  );
  const api = /** @type {HarnessApi} */ (
    new Function(
      ...Object.keys(dependencies),
      `${outputText}; return {
    select: (pair) => {
      const sessionId = boardRenderSessionId;
      return enterHistoricalView(
        { matchId: pair.matchId, pair, game: buildGame(pair) },
        rematchViewing.beginSelection(() => isBoardRenderSessionActive(sessionId)),
      );
    },
    navigate: didSelectRematchSeriesMatch,
    leave: () => { nextBoardRenderSession(); boardViewMode = "activeLive"; rematchViewing.clearSelection(); }
  };`,
    )(...Object.values(dependencies))
  );
  return {
    ...api,
    contexts,
    provisional: rematchViewing.seedProvisional,
    cached: (/** @type {string} */ matchId) =>
      rematchViewing.getCachedSelection(matchId)?.pair ?? null,
    displayed: () => rematchViewing.getSelection()?.pair ?? null,
    displayedGame: () => rematchViewing.getSelection()?.game ?? null,
    timers,
    retryWaits,
    loads: () => loads,
    paints: () => paints,
    runTimer: async () => {
      const timer = timers.shift();
      assert.ok(timer);
      timer.callback();
      await flush();
    },
    invalidate: () => {
      sessionVersion++;
      rematchViewing.reset();
    },
  };
}

/** @returns {Pair} */
function takebackPair() {
  const game = new Game();
  const moves = ["l10,5;l9,4", "l9,4;l8,5"];
  for (const move of moves) {
    assert.equal(game.playFen(move).kind, "complete");
  }
  for (let index = 0; index < 2; index++) {
    const output = game.takeback();
    assert.equal(output.kind, "complete");
    moves.push(output.inputFen);
  }
  /** @type {MatchRecord} */
  const match = {
    schemaVersion: 1,
    version: 2,
    color: "white",
    emojiId: 1,
    aura: "none",
    gameVariant: game.variant,
    fen: game.toFen(),
    flatMovesString: moves.join("-"),
    status: "surrendered",
    timer: { state: "idle" },
  };
  return {
    ...pair(),
    hostMatch: match,
    guestMatch: {
      ...match,
      color: "black",
      emojiId: 2,
      flatMovesString: "",
      status: "active",
    },
  };
}

/** @param {HistoricalPair} value */
function verifiedGame(value) {
  const trusted = getTrustedGameFromMatchPair(value, (fen) =>
    typeof fen === "string" ? (Game.fromFen(fen) ?? null) : null,
  );
  assert.ok(trusted);
  return trusted.gameModel;
}

test("short takeback history adopts refreshed archive cosmetics without replacing equal gameplay", async () => {
  const seed = takebackPair();
  /** @type {Pair} */
  const archived = {
    ...seed,
    hostMatch: { ...seed.hostMatch, emojiId: 7 },
    guestMatch: { ...seed.guestMatch, emojiId: 1001, aura: "rainbow" },
  };
  const selectedGame = verifiedGame(seed);
  const refreshedGame = verifiedGame(archived);
  assert.equal(selectedGame.trackingEntries.length, 1);
  assert.equal(countRecordedMovesInHistoricalPair(seed, "white"), 4);
  let reads = 0;
  const h = harness(
    async () => (++reads === 1 ? null : archived),
    (value) => (value === seed ? selectedGame : refreshedGame),
  );
  h.provisional(seed);

  assert.equal(await h.navigate(seed.matchId), true);
  assert.equal(h.loads(), 2);
  assert.deepEqual(h.retryWaits, [250]);
  assert.deepEqual(h.displayed(), archived);
  assert.equal(h.displayedGame(), selectedGame);
  assert.equal(h.cached(seed.matchId), archived);
  assert.equal(h.timers.length, 0);
});

test("short takeback history still selects a refreshed model with more gameplay", async () => {
  const seed = takebackPair();
  const selectedGame = verifiedGame(seed);
  const refreshedGame = verifiedGame(seed);
  const move = "l10,5;l9,4";
  assert.equal(refreshedGame.playFen(move).kind, "complete");
  /** @type {Pair} */
  const archived = {
    ...seed,
    hostMatch: {
      ...seed.hostMatch,
      emojiId: 7,
      fen: refreshedGame.toFen(),
      flatMovesString: `${seed.hostMatch.flatMovesString}-${move}`,
    },
  };
  assert.equal(refreshedGame.trackingEntries.length, 2);
  let reads = 0;
  const h = harness(
    async () => (++reads === 1 ? null : archived),
    (value) => (value === seed ? selectedGame : refreshedGame),
  );
  h.provisional(seed);

  assert.equal(await h.navigate(seed.matchId), true);
  assert.equal(h.displayed(), archived);
  assert.equal(h.displayedGame(), refreshedGame);
  assert.equal(h.timers.length, 0);
});

test("short takeback history remains provisional when the archive is absent or fails", async () => {
  for (const unavailable of [null, new Error("archive-unavailable")]) {
    const seed = takebackPair();
    const selectedGame = verifiedGame(seed);
    let reads = 0;
    const h = harness(
      async () => {
        if (++reads > 1 && unavailable) throw unavailable;
        return null;
      },
      () => selectedGame,
    );
    h.provisional(seed);

    assert.equal(await h.navigate(seed.matchId), true);
    assert.equal(h.loads(), 2);
    assert.equal(h.displayed(), seed);
    assert.equal(h.displayedGame(), selectedGame);
    assert.equal(h.cached(seed.matchId), seed);
    assert.equal(h.timers.length, 1);
  }
});

test("instant provisional history retries archival and refreshes frozen cosmetics without replacing gameplay", async () => {
  let ready = false;
  /** @type {Pair} */
  const archived = {
    ...pair(1001),
    hostMatch: canonicalMatch({
      emojiId: 1001,
      aura: "rainbow",
      fen: "archived-rating-host",
    }),
  };
  const h = harness(async () => (ready ? archived : null));
  const seed = pair();
  h.provisional(seed);
  assert.equal(h.select(seed), true);
  assert.equal(required(h.contexts.at(-1)).boardViewMode, "historicalView");
  assert.equal(required(h.timers[0]).delay, 250);
  await h.runTimer();
  assert.equal(required(h.timers[0]).delay, 3000);
  ready = true;
  await h.runTimer();
  assert.equal(h.timers.length, 0);
  assert.equal(h.loads(), 2);
  assert.equal(h.paints(), 2);
  assert.deepEqual(required(h.displayed()).hostMatch, {
    ...seed.hostMatch,
    emojiId: 1001,
    aura: "rainbow",
  });
  assert.deepEqual(h.cached("invite"), archived);
});

test("archive completion cannot repaint a different board view", async () => {
  const pending = deferred();
  const h = harness(() => pending.promise);
  h.provisional(pair());
  h.select(pair());
  await h.runTimer();
  assert.equal(h.loads(), 1);
  const paints = h.paints();
  h.leave();
  required(pending.resolve)(pair(1001));
  await flush();
  assert.equal(h.paints(), paints);
  assert.equal(h.timers.length, 0);
});

test("failed history navigation preserves the displayed match's archive refresh", async () => {
  let ready = false;
  const seed = { ...pair(), matchId: "invite1" };
  /** @type {Pair} */
  const archived = {
    ...seed,
    hostMatch: { ...seed.hostMatch, emojiId: 1001, aura: "rainbow" },
  };
  const h = harness(async (/** @type {string} */ matchId) =>
    matchId === seed.matchId && ready ? archived : null,
  );
  h.provisional(seed);
  h.select(seed);
  await h.runTimer();
  assert.equal(required(h.timers[0]).delay, 3000);
  assert.equal(await h.navigate("invite"), false);
  assert.equal(h.displayed(), seed);
  ready = true;
  await h.runTimer();
  assert.deepEqual(h.displayed(), archived);
  assert.equal(h.paints(), 2);
  assert.equal(h.timers.length, 0);
});

test("successful history navigation discards the previous view's pending archive response", async () => {
  const pending = deferred();
  const seed = { ...pair(), matchId: "invite1" };
  const older = pair(7);
  const h = harness(async (/** @type {string} */ matchId) =>
    matchId === seed.matchId ? pending.promise : older,
  );
  h.provisional(seed);
  h.select(seed);
  await h.runTimer();
  assert.equal(await h.navigate(older.matchId), true);
  assert.equal(h.displayed(), older);
  const paints = h.paints();
  required(pending.resolve)({
    ...seed,
    hostMatch: { ...seed.hostMatch, emojiId: 1001 },
  });
  await flush();
  assert.equal(h.displayed(), older);
  assert.equal(h.paints(), paints);
  assert.equal(h.timers.length, 0);
});

test("returning to the same cached historical pair does not revive the previous view's refresh", async () => {
  const pending = deferred();
  const seed = pair();
  const h = harness(() => pending.promise);
  h.provisional(seed);
  h.select(seed);
  await h.runTimer();
  h.leave();
  h.select(seed);
  const paints = h.paints();
  required(pending.resolve)(pair(1001));
  await flush();
  assert.equal(h.displayed(), seed);
  assert.equal(h.paints(), paints);
  await h.runTimer();
  assert.equal(required(required(h.displayed()).hostMatch).emojiId, 1001);
  assert.equal(h.paints(), paints + 1);
  assert.equal(h.timers.length, 0);
});

test("session invalidation stops a queued historical archive refresh before it loads", async () => {
  const h = harness(async () => pair(1001));
  h.provisional(pair());
  h.select(pair());
  const paints = h.paints();
  const queued = h.timers[0];
  h.invalidate();
  required(queued).callback();
  await flush();
  assert.equal(h.loads(), 0);
  assert.equal(h.paints(), paints);
  assert.equal(h.cached("invite"), null);
  assert.equal(h.timers.length, 0);
});
