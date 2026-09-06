import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { Game } from "mons-rules";
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

const { countRecordedMovesInHistoricalPair, getTrustedGameFromMatchPair } =
  await import("../src/game/historicalMatchModels.ts");

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
  "cacheProvisionalHistoricalMatchPair",
  "mergeHistoricalMatchPresentation",
  "ensureHistoricalMatchPair",
  "scheduleHistoricalMatchArchiveRefresh",
  "enterHistoricalView",
  "clearViewedRematchState",
  "nextBoardRenderSession",
  "isBoardRenderSessionActive",
  "didSelectRematchSeriesMatch",
  "moveHistoryEntitiesCount",
  "hasSuspiciouslyShortHistoricalMoveHistory",
  "shouldPreferRefreshedHistoricalData",
]
  .map((name) => {
    const declaration = source.statements.find(
      (statement) =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );
    assert.ok(declaration, name);
    return declaration.getText(source).replace(/^export /, "");
  })
  .join("\n");
const pair = (emojiId = 1) => ({
  matchId: "invite",
  hostPlayerId: "host",
  guestPlayerId: "guest",
  hostMatch: { emojiId, aura: "", fen: "local-host" },
  guestMatch: { emojiId: 2, aura: "", fen: "local-guest" },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(load = async () => null, buildGame = () => ({})) {
  const cache = new Map();
  const provisional = new Set();
  const timers = [];
  const retryWaits = [];
  let loads = 0;
  let paints = 0;
  let sessionVersion = 1;
  const dependencies = {
    historicalMatchPairCache: cache,
    provisionalHistoricalMatchIds: provisional,
    historicalMatchPairMissUntilByMatchId: new Map(),
    historicalMatchPairMissCooldownMs: 3000,
    historicalMatchPairRetryDelayMs: 250,
    isOnlineGame: true,
    connection: {
      loadHistoricalMatchPair: async (matchId) => {
        loads++;
        return load(matchId);
      },
      setWagerViewMatchId: () => {},
    },
    getSessionGuard: () => {
      const captured = sessionVersion;
      return () => captured === sessionVersion;
    },
    cacheHistoricalScore: () => {},
    setManagedGameTimeout: (callback, delay, guard) =>
      timers.push({ callback, delay, guard }),
    refreshDisplayedMatchPresentation: () => {
      paints++;
    },
    triggerMoveHistoryPopupReload: () => {},
    Board: {
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
    buildHistoricalGameModel: (_matchId, value) => buildGame(value),
    countRecordedMovesInHistoricalPair: (_matchId, value) =>
      countRecordedMovesInHistoricalPair(value, "white"),
    window: {
      setTimeout: (callback, delay) => {
        retryWaits.push(delay);
        queueMicrotask(callback);
      },
    },
  };
  const { outputText } = ts.transpileModule(
    `
    let boardViewMode = "activeLive";
    let viewedRematchMatchId = null;
    let viewedRematchPair = null;
    let viewedRematchGame = null;
    let flashbackMode = false;
    let flashbackStateGame = null;
    let currentInputs = [];
    let boardRenderSessionId = 1;
    let displayedHistoryViewId = 0;
    let viewedRematchRequestToken = 0;
    let moveHistoryFlipOverrideEnabled = false;
    let moveHistoryFlipOverrideSessionId = null;
    let moveHistoryFlipOverrideBaseBoardFlipped = null;
    ${functions}
  `,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  );
  const api = new Function(
    ...Object.keys(dependencies),
    `${outputText}; return {
    provisional: cacheProvisionalHistoricalMatchPair,
    load: ensureHistoricalMatchPair,
    select: (pair) => enterHistoricalView(pair.matchId, pair, {}, boardRenderSessionId),
    navigate: didSelectRematchSeriesMatch,
    displayed: () => viewedRematchPair,
    displayedGame: () => viewedRematchGame,
    leave: () => { nextBoardRenderSession(); boardViewMode = "activeLive"; clearViewedRematchState(); }
  };`,
  )(...Object.values(dependencies));
  return {
    ...api,
    cache,
    provisionalIds: provisional,
    timers,
    retryWaits,
    loads: () => loads,
    paints: () => paints,
    runTimer: async () => {
      const timer = timers.shift();
      assert.ok(timer);
      if (timer.guard()) timer.callback();
      await flush();
    },
    invalidate: () => {
      sessionVersion++;
      cache.clear();
      provisional.clear();
    },
  };
}

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
  const match = {
    version: 2,
    color: "white",
    emojiId: 1,
    aura: "",
    gameVariant: game.variant,
    fen: game.toFen(),
    flatMovesString: moves.join("-"),
    status: "surrendered",
    timer: "",
  };
  return {
    ...pair(),
    hostMatch: match,
    guestMatch: {
      ...match,
      color: "black",
      emojiId: 2,
      flatMovesString: "",
      status: "",
    },
  };
}

function verifiedGame(value) {
  const trusted = getTrustedGameFromMatchPair(
    value,
    (fen) => Game.fromFen(fen) ?? null,
  );
  assert.ok(trusted);
  return trusted.gameModel;
}

test("short takeback history adopts refreshed archive cosmetics without replacing equal gameplay", async () => {
  const seed = takebackPair();
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
  assert.equal(h.cache.get(seed.matchId), archived);
  assert.equal(h.provisionalIds.has(seed.matchId), false);
  assert.equal(h.timers.length, 0);
});

test("short takeback history still selects a refreshed model with more gameplay", async () => {
  const seed = takebackPair();
  const selectedGame = verifiedGame(seed);
  const refreshedGame = verifiedGame(seed);
  const move = "l10,5;l9,4";
  assert.equal(refreshedGame.playFen(move).kind, "complete");
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
  assert.equal(h.provisionalIds.has(seed.matchId), false);
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
    assert.equal(h.cache.get(seed.matchId), seed);
    assert.equal(h.provisionalIds.has(seed.matchId), true);
    assert.equal(h.timers.length, 1);
  }
});

test("pre-proposal Firebase pairs fetch the authoritative archive and never overwrite its cosmetics", async () => {
  const archived = pair(1001);
  const h = harness(async () => archived);
  h.provisional(pair());
  assert.equal(h.provisionalIds.has("invite"), true);
  assert.deepEqual(await h.load("invite"), archived);
  assert.equal(h.loads(), 1);
  assert.equal(h.provisionalIds.has("invite"), false);
  h.provisional(pair(9));
  assert.deepEqual(await h.load("invite"), archived);
  assert.equal(h.loads(), 1);
});

test("instant provisional history retries archival and refreshes frozen cosmetics without replacing gameplay", async () => {
  let ready = false;
  const archived = {
    ...pair(1001),
    hostMatch: { emojiId: 1001, aura: "rainbow", fen: "archived-rating-host" },
  };
  const h = harness(async () => (ready ? archived : null));
  const seed = pair();
  h.provisional(seed);
  assert.equal(h.select(seed), true);
  assert.equal(h.timers[0].delay, 250);
  await h.runTimer();
  assert.equal(h.timers[0].delay, 3000);
  ready = true;
  await h.runTimer();
  assert.equal(h.timers.length, 0);
  assert.equal(h.loads(), 2);
  assert.equal(h.paints(), 2);
  assert.deepEqual(h.displayed().hostMatch, {
    ...seed.hostMatch,
    emojiId: 1001,
    aura: "rainbow",
  });
  assert.deepEqual(h.cache.get("invite"), archived);
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
  pending.resolve(pair(1001));
  await flush();
  assert.equal(h.paints(), paints);
  assert.equal(h.timers.length, 0);
});

test("failed history navigation preserves the displayed match's archive refresh", async () => {
  let ready = false;
  const seed = { ...pair(), matchId: "invite1" };
  const archived = {
    ...seed,
    hostMatch: { ...seed.hostMatch, emojiId: 1001, aura: "rainbow" },
  };
  const h = harness(async (matchId) =>
    matchId === seed.matchId && ready ? archived : null,
  );
  h.provisional(seed);
  h.select(seed);
  await h.runTimer();
  assert.equal(h.timers[0].delay, 3000);
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
  const h = harness(async (matchId) =>
    matchId === seed.matchId ? pending.promise : older,
  );
  h.provisional(seed);
  h.select(seed);
  await h.runTimer();
  assert.equal(await h.navigate(older.matchId), true);
  assert.equal(h.displayed(), older);
  const paints = h.paints();
  pending.resolve({ ...seed, hostMatch: { ...seed.hostMatch, emojiId: 1001 } });
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
  pending.resolve(pair(1001));
  await flush();
  assert.equal(h.displayed(), seed);
  assert.equal(h.paints(), paints);
  await h.runTimer();
  assert.equal(h.displayed().hostMatch.emojiId, 1001);
  assert.equal(h.paints(), paints + 1);
  assert.equal(h.timers.length, 0);
});

test("session invalidation stops a queued historical archive refresh before it loads", async () => {
  const h = harness(async () => pair(1001));
  h.provisional(pair());
  h.select(pair());
  const paints = h.paints();
  h.invalidate();
  await h.runTimer();
  assert.equal(h.loads(), 0);
  assert.equal(h.paints(), paints);
  assert.equal(h.cache.size, 0);
  assert.equal(h.timers.length, 0);
});

test("archive reads cannot repopulate a torn-down session's history cache", async () => {
  const pending = deferred();
  const h = harness(() => pending.promise);
  h.provisional(pair());
  const reading = h.load("invite");
  h.invalidate();
  pending.resolve(pair(1001));
  assert.equal(await reading, null);
  assert.equal(h.cache.size, 0);
  assert.equal(h.provisionalIds.size, 0);
});

test("an overlapping older archive miss cannot reinstate provisional cosmetics after archival succeeds", async () => {
  const older = deferred();
  let calls = 0;
  const archived = pair(1001);
  const h = harness(() =>
    ++calls === 1 ? older.promise : Promise.resolve(archived),
  );
  h.provisional(pair());
  const first = h.load("invite");
  assert.deepEqual(await h.load("invite"), archived);
  older.resolve(null);
  assert.deepEqual(await first, archived);
  assert.equal(h.provisionalIds.has("invite"), false);
});
