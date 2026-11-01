import { canonicalMatch, required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";
import { Game } from "mons-rules";
import ts from "typescript";

registerTypeScriptTestHooks();

const { createRemoteMoveSyncController } =
  await import("../src/game/remoteMoveSyncController.ts");

const source = ts.createSourceFile(
  "gameController.ts",
  readFileSync(
    new URL("../src/game/gameController.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const functionNames = [
  "didReceiveMatchUpdates",
  "didReceiveMatchUpdate",
  "installInitialGameHydration",
  "installTrustedGameForMatch",
  "bindVerifiedGameToMatch",
  "showVerifiedMoveHistory",
  "movesCountOfMatch",
];
const functions = functionNames.map((name) => {
  const declaration = source.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  assert.ok(declaration, name);
  return declaration.getText(source).replace(/^export /, "");
});
const variableNames = ["remoteMoveSync", "installCurrentGameModel"];
const variables = variableNames.map((name) => {
  const statement = source.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => declaration.name.getText(source) === name,
      ),
  );
  assert.ok(statement, name);
  return statement.getText(source);
});
const { outputText } = ts.transpileModule(
  `
  let game = initialGame;
  let isGameOver = false;
  let didConnect = initiallyConnected;
  let isWaitingForInviteToGetAccepted = false;
  let isWaitingForRematchResponse = false;
  let pendingRematchNavigationToLiveBoard = false;
  function handleResignStatus(_onConnect, color) {
    isGameOver = true;
    onSurrender(color, game.toFen());
  }
  const handleResignStatusWithoutRender = handleResignStatus;
  function didConnectTo(_match, _uid, id, hydration) {
    installInitialGameHydration(id, hydration);
  }
  ${variables.join("\n")}
  ${functions.join("\n")}
`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);

/**
 * @typedef {import("@mons/shared/game-sessions").GameSessionMatch} Match
 * @typedef {Extract<import("mons-rules").InputResolution, {kind: "complete"}>} CompleteOutput
 * @typedef {{gameModel: Game; whiteMovesCount: number; blackMovesCount: number}} TrustedGame
 * @typedef {{receive(match: Match, id?: string): void; receiveBatch(matches: Match[], id?: string, isActive?: () => boolean): void; game(): Game; counts(): {white: number; black: number}; initialized(): boolean; install(game: Game): void}} ReplayApi
 * @typedef {ReplayApi & {invalidate(matchId?: string): void; installFresh(): void}} ReplayControl
 * @param {{historical?: boolean; connected?: boolean; onOutput?: (output: CompleteOutput, api: ReplayControl) => void; trustedGame?: TrustedGame}} [options]
 */
function harness({
  historical = false,
  connected = true,
  onOutput,
  trustedGame,
} = {}) {
  let activeMatchId = "match";
  let sessionVersion = 0;
  let popupReloads = 0;
  /** @type {Array<string>} */
  const played = [];
  /** @type {string[]} */
  const rendered = [];
  /** @type {Array<{color: Match["color"]; fen: string}>} */
  const surrendered = [];
  /** @type {Array<{match: Match; id: string}>} */
  const timers = [];
  /** @type {Array<{canPlay: boolean; fen: string}>} */
  const contentReady = [];
  const spy = (/** @type {Game} */ game) => {
    const play = required(game).playFen.bind(game);
    required(game).playFen = (input) => {
      played.push(input);
      return play(input);
    };
    return game;
  };
  const noop = () => {};
  const dependencies = {
    batchGameControlsUpdates: (/** @type {() => void} */ callback) =>
      callback(),
    initialGame: spy(new Game()),
    initiallyConnected: connected,
    createRemoteMoveSyncController,
    connection: {
      getActiveMatchId: () => activeMatchId,
      rematchSeriesEndIsIndicated: () => false,
    },
    getSessionGuard: () => {
      const captured = sessionVersion;
      return () => captured === sessionVersion;
    },
    boardViewMode: historical ? "historicalView" : "activeLive",
    isReconnect: false,
    isWatchOnly: true,
    isMoveHistoryPopupOpen: false,
    Board: {
      setupPlayerId: noop,
      updateEmojiAndAuraIfNeeded: noop,
      stopMonsBoardAsDisplayAnimations: noop,
    },
    applyOutput: (
      /** @type {readonly string[]} */ _inputs,
      /** @type {string} */ _fen,
      /** @type {CompleteOutput} */ output,
      /** @type {boolean} */ remote,
    ) => {
      assert.equal(remote, true);
      rendered.push(output.inputFen);
      onOutput?.(output, control);
    },
    AssistedInputKind: { None: 0 },
    ensureBoardViewInvariants: noop,
    isObservedMatchOpponentSide: () => true,
    applyWagerState: noop,
    syncWagerOutcome: noop,
    triggerMoveHistoryPopupReload: () => popupReloads++,
    matchTimers: {
      update: (
        /** @type {boolean} */ _onConnect,
        /** @type {Match} */ match,
        /** @type {string} */ id,
      ) => timers.push({ match, id }),
    },
    setCurrentVariant: noop,
    onSurrender: (
      /** @type {Match["color"]} */ color,
      /** @type {string} */ fen,
    ) => surrendered.push({ color, fen }),
    prepareInitialGameHydration: (/** @type {{ fen: string; }} */ match) =>
      trustedGame
        ? {
            kind: "trusted",
            trustedGame: {
              ...trustedGame,
              gameModel: spy(trustedGame.gameModel),
            },
          }
        : {
            kind: "provisional",
            gameModel: spy(required(Game.fromFen(match.fen))),
          },
    markMainGameContentReady: (/** @type {boolean} */ canPlay) =>
      contentReady.push({ canPlay, fen: api.game().toFen() }),
    resetOnlineReconnectRequestState: noop,
    showWaitingStateText: noop,
    setEndMatchVisible: noop,
    setAutomoveActionVisible: noop,
    showMoveHistoryButton: noop,
    setInviteLinkActionVisible: noop,
    setAutomatchVisible: noop,
    setBotGameOptionVisible: noop,
    setNavigationListButtonVisible: noop,
    showPrimaryAction: noop,
    PrimaryActionType: { None: 0 },
    applyBoardUiForCurrentView: noop,
    updateUndoButtonBasedOnGameState: noop,
    setAutomoveActionEnabled: noop,
    setEndMatchConfirmed: noop,
    playSounds: noop,
    Sound: { DidConnect: "connected" },
  };
  const api = /** @type {ReplayApi} */ (
    new Function(
      ...Object.keys(dependencies),
      `${outputText}
    return {
      receive: (match, id = "match") => didReceiveMatchUpdate(match, match.color, id),
      receiveBatch: (matches, id = "match", isActive = () => true) => didReceiveMatchUpdates(new Map(matches.map(match => [match.color, match])), id, isActive),
      game: () => game,
      counts: () => ({ white: remoteMoveSync.getProcessedCount("white"), black: remoteMoveSync.getProcessedCount("black") }),
      initialized: () => remoteMoveSync.hasInitializedBothSides(),
      install: (nextGame) => { installCurrentGameModel(nextGame); remoteMoveSync.setProcessedCounts(0, 0); isGameOver = false; },
    };
  `,
    )(...Object.values(dependencies))
  );
  const control = Object.assign(api, {
    played,
    rendered,
    surrendered,
    timers,
    contentReady,
    popupReloads: () => popupReloads,
    invalidate: (matchId = activeMatchId) => {
      activeMatchId = matchId;
      sessionVersion++;
    },
    installFresh: () => api.install(spy(new Game())),
  });
  return control;
}

/**
 * @param {Game} game
 */
function nextMove(game) {
  /** @type {import("mons-rules").Input[]} */
  const inputs = [];
  for (let step = 0; step < 8; step++) {
    const preview = game.preview(inputs);
    if (preview.kind === "complete") {
      const output = game.play(inputs);
      assert.equal(output.kind, "complete");
      return output;
    }
    /** @type {import("mons-rules").Input | undefined} */
    const input =
      preview.kind === "awaiting-start" && preview.positions[0]
        ? { kind: "position", position: preview.positions[0] }
        : preview.kind === "awaiting-input"
          ? preview.options[0]?.input
          : undefined;
    assert.ok(input);
    inputs.push(input);
  }
  assert.fail("no complete legal move");
}

/** @param {Game} game @param {Match["color"]} color @param {string[]} moves @param {Match["status"]} [status] @returns {Match} */
function record(game, color, moves, status = "active") {
  return canonicalMatch({
    version: 2,
    color,
    emojiId: 1,
    aura: "none",
    gameVariant: game.variant,
    fen: game.toFen(),
    flatMovesString: moves.join("-"),
    status,
    timer: { state: "idle" },
  });
}

function threeTurns() {
  const game = new Game();
  /** @type {Record<Match["color"], string[]>} */
  const moves = { white: [], black: [] };
  /** @type {Partial<Record<Match["color"], Match>>} */
  const snapshots = {};
  /** @type {string[]} */
  const ordered = [];
  while (game.turnNumber < 4) {
    const color = game.activeColor;
    const output = nextMove(game);
    moves[color].push(output.inputFen);
    ordered.push(output.inputFen);
    snapshots[color] = record(game, color, moves[color]);
    assert.ok(ordered.length < 40);
  }
  return {
    game,
    moves,
    snapshots: {
      white: required(snapshots.white),
      black: required(snapshots.black),
    },
    ordered,
  };
}

test("combined snapshots replay the other actor's last move before surrender", () => {
  for (const surrenderedColor of /** @type {const} */ (["white", "black"])) {
    for (const historical of [false, true]) {
      const server = new Game();
      /** @type {Record<Match["color"], string[]>} */
      const moves = { white: [], black: [] };
      while (server.activeColor === surrenderedColor) {
        moves[surrenderedColor].push(nextMove(server).inputFen);
      }
      const before = {
        white: record(server, "white", moves.white),
        black: record(server, "black", moves.black),
      };
      const movingColor = server.activeColor;
      moves[movingColor].push(nextMove(server).inputFen);
      const moving = record(server, movingColor, moves[movingColor]);
      /** @type {Match} */
      const surrendered = {
        ...before[surrenderedColor],
        status: "surrendered",
      };
      for (const batch of [
        [surrendered, moving],
        [moving, surrendered],
      ]) {
        const h = harness({ historical });
        h.receive(before.white);
        h.receive(before.black);
        h.receiveBatch(batch);
        assert.equal(h.game().toFen(), server.toFen());
        assert.deepEqual(h.counts(), {
          white: moves.white.length,
          black: moves.black.length,
        });
        assert.ok(h.surrendered.length > 0);
        assert.ok(
          h.surrendered.every(
            (/** @type {{ fen: string; }} */ value) =>
              value.fen === server.toFen(),
          ),
        );
      }
    }
  }
});

test("combined snapshots stop when replay changes the session", () => {
  const fixture = threeTurns();
  const h = harness({
    onOutput: (_output, current) => current.invalidate("other-match"),
  });
  h.receiveBatch([fixture.snapshots.white, fixture.snapshots.black]);
  assert.equal(h.played.length, 1);
  assert.equal(h.surrendered.length, 0);
  const inactive = harness();
  inactive.receiveBatch(
    [fixture.snapshots.white, fixture.snapshots.black],
    "match",
    () => false,
  );
  assert.equal(inactive.played.length, 0);
});

test("cumulative snapshots drain both colors across three turns in either arrival order", () => {
  const fixture = threeTurns();
  assert.deepEqual(
    { white: fixture.moves.white.length, black: fixture.moves.black.length },
    { white: 12, black: 6 },
  );
  for (const colors of /** @type {const} */ ([
    ["white", "black"],
    ["black", "white"],
  ])) {
    const h = harness();
    h.receive(fixture.snapshots[colors[0]]);
    assert.notEqual(h.game().toFen(), fixture.game.toFen());
    h.receive(fixture.snapshots[colors[1]]);
    assert.equal(h.game().toFen(), fixture.game.toFen());
    assert.deepEqual(h.played, fixture.ordered);
    assert.deepEqual(h.counts(), { white: 12, black: 6 });
  }
});

test("batched moves and takebacks replay every input even when the final FEN is unchanged", () => {
  const game = new Game();
  const originalFen = game.toFen();
  const moves = [nextMove(game).inputFen, nextMove(game).inputFen];
  moves.push(game.takeback().inputFen, game.takeback().inputFen);
  assert.deepEqual(moves.slice(-2), ["z", "z"]);
  assert.equal(game.toFen(), originalFen);
  const h = harness();
  h.receive(record(game, "white", moves));
  assert.deepEqual(h.played, moves);
  assert.deepEqual(h.rendered, moves);
  assert.equal(h.game().toFen(), originalFen);
  assert.deepEqual(h.counts(), { white: 4, black: 0 });
});

test("duplicate and stale snapshots never replay inputs or replace a longer pending prefix", () => {
  const fixture = threeTurns();
  const h = harness();
  h.receive(fixture.snapshots.white);
  assert.equal(h.played.length, 5);
  h.receive({
    ...fixture.snapshots.white,
    flatMovesString: fixture.moves.white.slice(0, 2).join("-"),
  });
  h.receive(fixture.snapshots.black);
  h.receive(fixture.snapshots.white);
  h.receive(fixture.snapshots.black);
  assert.deepEqual(h.played, fixture.ordered);
  assert.equal(h.game().toFen(), fixture.game.toFen());
});

test("divergent history cannot replace already buffered inputs", () => {
  const fixture = threeTurns();
  const h = harness();
  h.receive(fixture.snapshots.white);
  h.receive({
    ...fixture.snapshots.white,
    flatMovesString: `${fixture.moves.white[0]}-invalid`,
  });
  h.receive(fixture.snapshots.black);
  assert.deepEqual(h.played, fixture.ordered);
  assert.equal(h.game().toFen(), fixture.game.toFen());
});

test("surrender waits for buffered histories to finish across colors", () => {
  const fixture = threeTurns();
  const h = harness();
  h.receive({ ...fixture.snapshots.black, status: "surrendered" });
  h.receive(fixture.snapshots.black);
  assert.deepEqual(h.surrendered, []);
  h.receive(fixture.snapshots.white);
  assert.deepEqual(h.played, fixture.ordered);
  assert.deepEqual(h.surrendered, [
    { color: "black", fen: fixture.game.toFen() },
  ]);
});

test("historical view updates the live model without rendering each remote input", () => {
  const fixture = threeTurns();
  const h = harness({ historical: true });
  h.receive(fixture.snapshots.white);
  h.receive(fixture.snapshots.black);
  assert.equal(h.game().toFen(), fixture.game.toFen());
  assert.deepEqual(h.played, fixture.ordered);
  assert.deepEqual(h.rendered, []);
  assert.equal(h.popupReloads(), 2);
});

test("session changes during rendering stop the replay before touching the new session", () => {
  const fixture = threeTurns();
  const h = harness({
    onOutput: (_output, api) => api.invalidate("new-match"),
  });
  h.receive(fixture.snapshots.white);
  assert.equal(h.played.length, 1);
  assert.deepEqual(h.counts(), { white: 1, black: 0 });
  assert.deepEqual(h.timers, []);
  h.receive(fixture.snapshots.black);
  assert.equal(h.played.length, 1);
});

test("installing a recovered game clears old buffered histories before new snapshots arrive", () => {
  const fixture = threeTurns();
  const h = harness();
  h.receive(fixture.snapshots.white);
  assert.equal(h.played.length, 5);
  h.installFresh();
  h.played.length = 0;
  h.receive(fixture.snapshots.black);
  assert.deepEqual(h.played, []);
  h.receive(fixture.snapshots.white);
  assert.deepEqual(h.played, fixture.ordered);
});

test("a model replacement during rendering stops replay and stale timer handling", () => {
  const fixture = threeTurns();
  const h = harness({ onOutput: (_output, api) => api.installFresh() });
  h.receive(fixture.snapshots.white);
  assert.equal(h.played.length, 1);
  assert.equal(h.game().toFen(), new Game().toFen());
  assert.deepEqual(h.counts(), { white: 0, black: 0 });
  assert.deepEqual(h.timers, []);
});

test("a provisional initial snapshot seeds processed counts and is not replayed again", () => {
  const game = new Game();
  const moves = [nextMove(game).inputFen];
  const initial = record(game, "white", moves);
  const h = harness({ connected: false });
  assert.deepEqual(h.contentReady, []);
  h.receive(initial);
  h.receive(initial);
  assert.deepEqual(h.contentReady, [{ canPlay: false, fen: initial.fen }]);
  assert.deepEqual(h.played, []);
  assert.deepEqual(h.counts(), { white: 1, black: 0 });
  moves.push(nextMove(game).inputFen, game.takeback().inputFen);
  h.receive(record(game, "white", moves));
  assert.deepEqual(h.played, moves.slice(1));
  assert.equal(h.game().toFen(), game.toFen());
});

test("an invalid input stops the bounded replay without advancing its cursor", () => {
  const game = new Game();
  const h = harness();
  h.receive(record(game, "white", ["invalid", "z"]));
  assert.deepEqual(h.played, ["invalid"]);
  assert.deepEqual(h.counts(), { white: 0, black: 0 });
  assert.equal(h.game().toFen(), game.toFen());
});

test("trusted hydration seeds both move counts and never replays the verified snapshot", () => {
  const fixture = threeTurns();
  const h = harness({
    connected: false,
    trustedGame: {
      gameModel: fixture.game,
      whiteMovesCount: fixture.moves.white.length,
      blackMovesCount: fixture.moves.black.length,
    },
  });
  h.receiveBatch([fixture.snapshots.white, fixture.snapshots.black]);
  h.receiveBatch([fixture.snapshots.black, fixture.snapshots.white]);
  assert.equal(h.game(), fixture.game);
  assert.deepEqual(h.played, []);
  assert.deepEqual(h.counts(), { white: 12, black: 6 });
  assert.equal(h.initialized(), true);
});

test("trusted hydration initializes both sides even when their histories are empty", () => {
  const game = new Game();
  const h = harness({
    connected: false,
    trustedGame: {
      gameModel: game,
      whiteMovesCount: 0,
      blackMovesCount: 0,
    },
  });
  h.receive(record(game, "white", []));
  assert.deepEqual(h.counts(), { white: 0, black: 0 });
  assert.equal(h.initialized(), true);
  assert.deepEqual(h.played, []);
});
