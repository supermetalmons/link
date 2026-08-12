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
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.endsWith("/src/lifecycle/lifecycleDiagnostics.ts")) {
      return {
        ...result,
        source: String(result.source).replace("import.meta.env.DEV", "false"),
      };
    }
    return result;
  },
});

const MonsRules = await import("mons-rules");
const { MATCH_TIMER_TERMINAL } = await import("@mons/shared/timers");
const { getNextBotAutomoveMode, normalizeBotAutomoveMode } =
  await import("../src/game/botAutomoveMode.ts");
const { bindGameConnection, gameConnection, isGameConnectionBound } =
  await import("../src/game/gameConnectionPort.ts");
const {
  countRecordedMovesInHistoricalPair,
  getHistoricalResignedColor,
  getHistoricalWinnerByTimerColor,
  getMatchMovesByColor,
  getTrustedGameFromMatchPair,
  movesArrayForHistoryVerification,
  movesArrayFromFlatString,
  normalizePersistedMoveHistory,
} = await import("../src/game/historicalMatchModels.ts");
const {
  clearAllManagedGameTimeouts,
  clearManagedGameTimeout,
  setManagedGameTimeout,
} = await import("../src/game/managedGameTimeouts.ts");
const { getLifecycleCounters } =
  await import("../src/lifecycle/lifecycleDiagnostics.ts");

const match = (values = {}) => ({
  version: 1,
  color: "white",
  emojiId: 1,
  fen: "fen",
  status: "",
  flatMovesString: "",
  timer: "",
  ...values,
});

const pair = (hostMatch, guestMatch) => ({
  matchId: "match-1",
  hostPlayerId: "host",
  guestPlayerId: "guest",
  hostMatch,
  guestMatch,
});

test("requires explicit game connection binding and forwards with receiver context", () => {
  assert.equal(isGameConnectionBound(), false);
  assert.throws(
    () => gameConnection.getActiveMatchId(),
    /game-connection-not-bound/,
  );

  const connection = {
    activeMatchId: "match-7",
    getActiveMatchId() {
      return this.activeMatchId;
    },
  };
  bindGameConnection(connection);

  assert.equal(isGameConnectionBound(), true);
  assert.equal(gameConnection.getActiveMatchId(), "match-7");
});

test("normalizes legacy bot modes and cycles in display order", () => {
  assert.equal(normalizeBotAutomoveMode("fast"), "fast");
  assert.equal(normalizeBotAutomoveMode("ultra"), "pro");
  assert.equal(normalizeBotAutomoveMode("unknown"), "normal");
  assert.equal(getNextBotAutomoveMode("fast"), "normal");
  assert.equal(getNextBotAutomoveMode("normal"), "pro");
  assert.equal(getNextBotAutomoveMode("pro"), "fast");
});

test("normalizes persisted histories without accepting malformed values", () => {
  assert.equal(normalizePersistedMoveHistory(null), "");
  assert.equal(normalizePersistedMoveHistory(undefined), "");
  assert.equal(normalizePersistedMoveHistory("a--b"), "a--b");
  assert.equal(normalizePersistedMoveHistory({}), null);
  assert.deepEqual(movesArrayForHistoryVerification("a--b"), ["a", "", "b"]);
  assert.deepEqual(movesArrayFromFlatString("a--b"), ["a", "b"]);
  assert.deepEqual(movesArrayFromFlatString(null), []);
});

test("maps historical moves by stored colors and series fallback", () => {
  const storedColors = pair(
    match({ color: "black", flatMovesString: "b1-b2" }),
    match({ color: "white", flatMovesString: "w1" }),
  );
  assert.deepEqual(getMatchMovesByColor(storedColors, null), {
    whiteMoves: "w1",
    blackMoves: "b1-b2",
  });
  assert.equal(countRecordedMovesInHistoricalPair(storedColors, null), 3);

  const seriesColors = pair(
    match({ color: "legacy", flatMovesString: "w1-w2" }),
    match({ color: "legacy", flatMovesString: "b1" }),
  );
  assert.deepEqual(getMatchMovesByColor(seriesColors, "white"), {
    whiteMoves: "w1-w2",
    blackMoves: "b1",
  });
  assert.deepEqual(getMatchMovesByColor(seriesColors, "black"), {
    whiteMoves: "b1",
    blackMoves: "w1-w2",
  });
});

test("trusts only verified, agreeing historical game candidates", () => {
  const historicalPair = pair(
    match({ color: "white", fen: "host", flatMovesString: "w1-w2" }),
    match({ color: "black", fen: "guest", flatMovesString: "b1" }),
  );
  const receivedHistories = [];
  const candidateFor = (fen) => ({
    verifyHistory(history) {
      receivedHistories.push(history);
      return true;
    },
    toFen() {
      return "agreed";
    },
    source: fen,
  });

  const trusted = getTrustedGameFromMatchPair(historicalPair, candidateFor);
  assert.equal(trusted?.gameModel.source, "host");
  assert.equal(trusted?.whiteMovesCount, 2);
  assert.equal(trusted?.blackMovesCount, 1);
  assert.deepEqual(receivedHistories, [
    { white: ["w1", "w2"], black: ["b1"] },
    { white: ["w1", "w2"], black: ["b1"] },
  ]);

  assert.equal(
    getTrustedGameFromMatchPair(historicalPair, (fen) => ({
      verifyHistory: () => true,
      toFen: () => fen,
    })),
    null,
  );
  assert.equal(
    getTrustedGameFromMatchPair(
      pair(match({ color: "white" }), match({ color: "white" })),
      candidateFor,
    ),
    null,
  );
});

test("derives historical terminal colors from records and series fallback", () => {
  assert.equal(
    getHistoricalResignedColor(
      pair(
        match({ color: "legacy", status: "surrendered" }),
        match({ color: "legacy" }),
      ),
      "black",
    ),
    MonsRules.Color.Black,
  );
  assert.equal(
    getHistoricalWinnerByTimerColor(
      pair(
        match({ color: "white" }),
        match({ color: "black", timer: MATCH_TIMER_TERMINAL }),
      ),
      null,
    ),
    MonsRules.Color.Black,
  );
});

test("managed game timeouts retain guard and lifecycle behavior", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const callbacks = new Map();
  let nextId = 1;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout(callback) {
        const id = nextId;
        nextId += 1;
        callbacks.set(id, callback);
        return id;
      },
    },
  });
  const initialCount = getLifecycleCounters().gameTimeouts;
  try {
    let calls = 0;
    const clearedId = setManagedGameTimeout(() => {
      calls += 1;
    }, 10);
    assert.equal(getLifecycleCounters().gameTimeouts, initialCount + 1);
    clearManagedGameTimeout(clearedId);
    assert.equal(getLifecycleCounters().gameTimeouts, initialCount);

    const guardedId = setManagedGameTimeout(
      () => {
        calls += 1;
      },
      10,
      () => false,
    );
    callbacks.get(guardedId)();
    assert.equal(calls, 0);
    assert.equal(getLifecycleCounters().gameTimeouts, initialCount);

    setManagedGameTimeout(() => {}, 10);
    setManagedGameTimeout(() => {}, 10);
    assert.equal(getLifecycleCounters().gameTimeouts, initialCount + 2);
    clearAllManagedGameTimeouts();
    assert.equal(getLifecycleCounters().gameTimeouts, initialCount);
  } finally {
    clearAllManagedGameTimeouts();
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      delete globalThis.window;
    }
  }
});
