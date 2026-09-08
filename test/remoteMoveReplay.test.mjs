import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Game } from "mons-rules";
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
const functionNames = [
  "resetRemoteMoveHistories",
  "rememberRemoteMoveHistory",
  "hasPendingRemoteMoves",
  "drainRemoteMoveHistories",
  "didReceiveMatchUpdate",
  "getProcessedMovesCount",
  "setProcessedMovesCountForColor",
  "setProcessedMovesCounts",
  "movesFensArray",
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
const variableNames = [
  "remoteMoveHistories",
  "remoteMoveHistoriesMatchId",
  "installCurrentGameModel",
];
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
  let whiteProcessedMovesCount = 0;
  let blackProcessedMovesCount = 0;
  let didSetWhiteProcessedMovesCount = false;
  let didSetBlackProcessedMovesCount = false;
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
  function didConnectTo(_match, _uid, _id, hydration) {
    installCurrentGameModel(hydration.gameModel);
  }
  ${variables.join("\n")}
  ${functions.join("\n")}
`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);

function harness({ historical = false, connected = true, onOutput } = {}) {
  let activeMatchId = "match";
  let sessionVersion = 0;
  let popupReloads = 0;
  const played = [];
  const rendered = [];
  const surrendered = [];
  const timers = [];
  const spy = (game) => {
    const play = game.playFen.bind(game);
    game.playFen = (input) => {
      played.push(input);
      return play(input);
    };
    return game;
  };
  const noop = () => {};
  const dependencies = {
    initialGame: spy(new Game()),
    initiallyConnected: connected,
    normalizePersistedMoveHistory: (value) =>
      value == null ? "" : typeof value === "string" ? value : null,
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
    Board: {
      setupPlayerId: noop,
      updateEmojiAndAuraIfNeeded: noop,
      stopMonsBoardAsDisplayAnimations: noop,
    },
    applyOutput: (_inputs, _fen, output, remote) => {
      assert.equal(remote, true);
      rendered.push(output.inputFen);
      onOutput?.(output, api);
    },
    AssistedInputKind: { None: 0 },
    ensureBoardViewInvariants: noop,
    isObservedMatchOpponentSide: () => true,
    applyWagerState: noop,
    syncWagerOutcome: noop,
    triggerMoveHistoryPopupReload: () => popupReloads++,
    updateDisplayedTimerIfNeeded: (_onConnect, match, id) =>
      timers.push({ match, id }),
    setCurrentVariant: noop,
    onSurrender: (color, fen) => surrendered.push({ color, fen }),
    prepareInitialGameHydration: (match) => ({
      kind: "provisional",
      gameModel: spy(Game.fromFen(match.fen)),
    }),
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
  const api = new Function(
    ...Object.keys(dependencies),
    `${outputText}
    return {
      receive: (match, id = "match") => didReceiveMatchUpdate(match, match.color, id),
      game: () => game,
      counts: () => ({ white: whiteProcessedMovesCount, black: blackProcessedMovesCount }),
      install: (nextGame) => { installCurrentGameModel(nextGame); setProcessedMovesCounts(0, 0); isGameOver = false; },
    };
  `,
  )(...Object.values(dependencies));
  return Object.assign(api, {
    played,
    rendered,
    surrendered,
    timers,
    popupReloads: () => popupReloads,
    invalidate: (matchId = activeMatchId) => {
      activeMatchId = matchId;
      sessionVersion++;
    },
    installFresh: () => api.install(spy(new Game())),
  });
}

function nextMove(game) {
  const inputs = [];
  for (let step = 0; step < 8; step++) {
    const preview = game.preview(inputs);
    if (preview.kind === "complete") {
      const output = game.play(inputs);
      assert.equal(output.kind, "complete");
      return output;
    }
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

function record(game, color, moves, status = "") {
  return {
    version: 2,
    color,
    emojiId: 1,
    aura: "",
    gameVariant: game.variant,
    fen: game.toFen(),
    flatMovesString: moves.join("-"),
    status,
    timer: "",
  };
}

function threeTurns() {
  const game = new Game();
  const moves = { white: [], black: [] };
  const snapshots = {};
  const ordered = [];
  while (game.turnNumber < 4) {
    const color = game.activeColor;
    const output = nextMove(game);
    moves[color].push(output.inputFen);
    ordered.push(output.inputFen);
    snapshots[color] = record(game, color, moves[color]);
    assert.ok(ordered.length < 40);
  }
  return { game, moves, snapshots, ordered };
}

test("cumulative snapshots drain both colors across three turns in either arrival order", () => {
  const fixture = threeTurns();
  assert.deepEqual(
    { white: fixture.moves.white.length, black: fixture.moves.black.length },
    { white: 12, black: 6 },
  );
  for (const colors of [
    ["white", "black"],
    ["black", "white"],
  ]) {
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
  h.receive(initial);
  h.receive(initial);
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
