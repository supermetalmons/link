import { required } from "./fixtures/canonicalData.mjs";
import { canonicalMatch } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";
import { Game } from "mons-rules";

registerTypeScriptTestHooks();

const { createRemoteMoveSyncController } =
  await import("../src/game/remoteMoveSyncController.ts");

const whiteMoves = ["l10,5;l9,4", "l9,4;l8,5"];
/** @param {import("@mons/shared/game-sessions").GameSessionMatch["color"]} color @param {string} [flatMovesString] @param {import("@mons/shared/game-sessions").GameSessionMatch["status"]} [status] */
const match = (color, flatMovesString = "", status = "active") =>
  canonicalMatch({ color, flatMovesString, status });

/**
 * @typedef {{game: Game; matchId: string; session: number; isGameOver: boolean}} ReplayContext
 * @param {(output: import("mons-rules").InputResolution, controller: ReturnType<typeof createRemoteMoveSyncController>, context: ReplayContext) => void} [onReplayOutput]
 */
function harness(onReplayOutput = () => {}) {
  const context = {
    game: new Game(),
    matchId: "match",
    session: 0,
    isGameOver: false,
  };
  /**
   * @type {string[]}
   */
  const outputs = [];
  /** @type {ReturnType<typeof createRemoteMoveSyncController>} */
  const controller = createRemoteMoveSyncController({
    getGame: () => context.game,
    getActiveMatchId: () => context.matchId,
    createSessionGuard: () => {
      const session = context.session;
      return () => session === context.session;
    },
    isGameOver: () => context.isGameOver,
    onReplayOutput: (output) => {
      outputs.push(output.inputFen);
      onReplayOutput(output, controller, context);
    },
  });
  return { controller, context, outputs };
}

function unverifiedSnapshot() {
  const server = new Game();
  for (const move of whiteMoves) {
    assert.equal(server.playFen(move).kind, "complete");
  }
  const snapshot = Game.fromFen(server.toFen());
  assert.equal(required(snapshot).historyVerified, false);
  return required(snapshot);
}

test("zero seeded counts initialize each side independently", () => {
  const { controller } = harness();
  assert.equal(controller.hasInitializedBothSides(), false);
  controller.setProcessedCount("white", 0);
  assert.equal(controller.hasInitializedBothSides(), false);
  controller.setProcessedCount("black", 0);
  assert.equal(controller.hasInitializedBothSides(), true);
  controller.resetProgress();
  assert.equal(controller.hasInitializedBothSides(), false);
  controller.setProcessedCounts(0, 0);
  assert.equal(controller.hasInitializedBothSides(), true);
});

test("clearing histories retains counters, initialization and pending verification", () => {
  const { controller } = harness();
  const snapshot = unverifiedSnapshot();
  controller.setProcessedCounts(2, 0);
  controller.remember(match("white", "old-pending-input"), "old");
  assert.equal(
    controller.verifyHistory(snapshot, "match", whiteMoves.join("-"), "white"),
    false,
  );
  controller.clearHistories();
  assert.equal(controller.hasPendingMoves(), false);
  assert.equal(controller.getProcessedCount("white"), 2);
  assert.equal(controller.getProcessedCount("black"), 0);
  assert.equal(controller.hasInitializedBothSides(), true);
  assert.equal(controller.verifyHistory(snapshot, "match", "", "black"), true);
  assert.equal(required(snapshot).historyVerified, true);
  assert.equal(
    controller.remember(match("white", whiteMoves.join("-")), "old"),
    true,
  );
});

test("resetting progress retains buffered moves but clears verification and initialization", () => {
  const { controller, outputs } = harness();
  const snapshot = unverifiedSnapshot();
  controller.remember(match("white", whiteMoves.join("-")), "match");
  controller.setProcessedCounts(2, 0);
  controller.verifyHistory(snapshot, "match", whiteMoves.join("-"), "white");
  assert.equal(controller.hasPendingMoves(), false);
  controller.resetProgress();
  assert.equal(controller.hasPendingMoves(), true);
  assert.equal(controller.hasInitializedBothSides(), false);
  assert.equal(controller.getProcessedCount("white"), 0);
  assert.equal(controller.getProcessedCount("black"), 0);
  assert.equal(controller.verifyHistory(snapshot, "match", "", "black"), false);
  assert.equal(required(snapshot).historyVerified, false);
  assert.equal(controller.drain("match", true), true);
  assert.deepEqual(outputs, whiteMoves);
  assert.equal(controller.hasInitializedBothSides(), false);
  assert.equal(controller.hasPendingMoves(), false);
});

test("changing the buffered match clears histories without resetting progress", () => {
  const { controller } = harness();
  controller.remember(match("white", "", "surrendered"), "old");
  controller.setProcessedCounts(2, 1);
  controller.remember(match("black", ""), "new");
  assert.equal(controller.getSurrenderedMatchWhenDrained(), undefined);
  assert.equal(controller.getProcessedCount("white"), 2);
  assert.equal(controller.getProcessedCount("black"), 1);
  assert.equal(controller.hasInitializedBothSides(), true);
  assert.equal(controller.remember(match("white", "different"), "new"), true);
});

test("verification succeeds only after both histories describe the supplied snapshot", () => {
  const { controller } = harness();
  const snapshot = unverifiedSnapshot();
  assert.equal(
    controller.verifyHistory(snapshot, "match", whiteMoves[0], "white"),
    false,
  );
  assert.equal(controller.verifyHistory(snapshot, "match", "", "black"), false);
  assert.equal(required(snapshot).historyVerified, false);
  assert.equal(
    controller.verifyHistory(snapshot, "match", whiteMoves.join("-"), "white"),
    true,
  );
  assert.equal(required(snapshot).historyVerified, true);
  assert.equal(controller.verifyHistory(snapshot, "match", "", "black"), false);
  assert.equal(controller.hasInitializedBothSides(), false);
});

test("verification changes match identity only after receiving a valid history", () => {
  const { controller } = harness();
  const snapshot = unverifiedSnapshot();
  controller.verifyHistory(snapshot, "match", whiteMoves.join("-"), "white");
  assert.equal(controller.verifyHistory(snapshot, "other", {}, "black"), false);
  assert.equal(controller.verifyHistory(snapshot, "match", "", "black"), true);
  const nextSnapshot = unverifiedSnapshot();
  controller.verifyHistory(
    nextSnapshot,
    "match",
    whiteMoves.join("-"),
    "white",
  );
  assert.equal(
    controller.verifyHistory(nextSnapshot, "other", "", "black"),
    false,
  );
  assert.equal(
    controller.verifyHistory(
      nextSnapshot,
      "other",
      whiteMoves.join("-"),
      "white",
    ),
    true,
  );
});

test("binding a verified game clears pending sides and skips verification for that match", () => {
  const { controller } = harness();
  const snapshot = unverifiedSnapshot();
  controller.verifyHistory(snapshot, "match", whiteMoves.join("-"), "white");
  controller.bindVerifiedGame("match");
  assert.equal(
    controller.verifyHistory(
      Object.defineProperties(new Game(), {
        historyVerified: { value: true },
        verifyHistory: { value: () => assert.fail("already verified") },
      }),
      "match",
      "ignored",
      "black",
    ),
    false,
  );
  assert.equal(controller.verifyHistory(snapshot, "match", "", "black"), false);
  assert.equal(
    controller.verifyHistory(snapshot, "match", whiteMoves.join("-"), "white"),
    true,
  );
});

test("explicit empty histories and embedded empty tokens remain available to verification", () => {
  for (const empty of [""]) {
    const { controller } = harness();
    /** @type {Array<Parameters<Game["verifyHistory"]>[0]>} */
    const calls = [];
    const game = Object.defineProperties(new Game(), {
      historyVerified: { value: false },
      verifyHistory: {
        value: (
          /** @type {Parameters<Game["verifyHistory"]>[0]} */ histories,
        ) => {
          calls.push(histories);
          return false;
        },
      },
    });
    assert.equal(
      controller.verifyHistory(game, "match", "first--third-", "white"),
      false,
    );
    assert.equal(
      controller.verifyHistory(game, "match", empty, "black"),
      false,
    );
    assert.deepEqual(calls, [{ white: ["first", "", "third", ""], black: [] }]);
  }
});

test("remember rejects malformed snapshots before changing a buffered match", () => {
  const { controller } = harness();
  controller.remember(match("white", "", "surrendered"), "match");
  for (const invalid of [
    { ...match("white"), flatMovesString: {} },
    { ...match("white"), flatMovesString: 0 },
    { ...match("white"), flatMovesString: null },
    { ...match("white"), flatMovesString: undefined },
    { ...match("white"), color: "other" },
  ]) {
    assert.equal(
      Reflect.apply(controller.remember, controller, [invalid, "other"]),
      false,
    );
    assert.equal(
      required(controller.getSurrenderedMatchWhenDrained()).color,
      "white",
    );
  }
  for (const empty of [""]) {
    assert.equal(controller.remember(match("black", empty), "match"), true);
    assert.equal(controller.hasPendingMoves(), false);
  }
});

test("surrender remains sticky on accepted updates and follows first observed color order", () => {
  for (const first of /** @type {const} */ (["white", "black"])) {
    const { controller } = harness();
    const second = first === "white" ? "black" : "white";
    const original = match(first, "", "surrendered");
    controller.remember(original, "match");
    Reflect.set(original, "status", "");
    controller.remember(match(second, "", "surrendered"), "match");
    controller.remember(match(first), "match");
    assert.equal(
      required(controller.getSurrenderedMatchWhenDrained()).color,
      first,
    );
    assert.equal(
      required(controller.getSurrenderedMatchWhenDrained()).status,
      "surrendered",
    );
  }
});

test("a drain advances its cursor before output effects and leaves new buffered work for the next drain", () => {
  const { controller, outputs } = harness((_output, sync) => {
    assert.equal(sync.getProcessedCount("white"), outputs.length);
    sync.remember(match("white", whiteMoves.join("-")), "match");
  });
  controller.remember(match("white", whiteMoves[0]), "match");
  assert.equal(controller.drain("match", true), true);
  assert.deepEqual(outputs, whiteMoves.slice(0, 1));
  assert.equal(controller.hasPendingMoves(), true);
  assert.equal(controller.drain("match", true), true);
  assert.deepEqual(outputs, whiteMoves);
  assert.equal(controller.hasPendingMoves(), false);
});

test("an empty embedded input stops replay without skipping its cursor or releasing surrender", () => {
  const { controller, outputs } = harness();
  controller.remember(
    match("white", `${whiteMoves[0]}--${whiteMoves[1]}`, "surrendered"),
    "match",
  );
  assert.equal(controller.drain("match", true), true);
  assert.deepEqual(outputs, whiteMoves.slice(0, 1));
  assert.equal(controller.getProcessedCount("white"), 1);
  assert.equal(controller.hasPendingMoves(), true);
  assert.equal(controller.getSurrenderedMatchWhenDrained(), undefined);
  assert.equal(controller.drain("match", true), false);
  assert.equal(controller.getProcessedCount("white"), 1);
});

for (const change of ["session", "match", "model", "game-over", "winner"]) {
  test(`a ${change} change during replay stops before the next buffered input`, () => {
    const { controller, outputs } = harness((_output, _sync, context) => {
      if (change === "session") context.session++;
      if (change === "match") context.matchId = "next";
      if (change === "model") context.game = new Game();
      if (change === "game-over") context.isGameOver = true;
      if (change === "winner")
        Object.defineProperty(context.game, "winner", { value: "white" });
    });
    controller.remember(match("white", whiteMoves.join("-")), "match");
    assert.equal(controller.drain("match", true), true);
    assert.deepEqual(outputs, whiteMoves.slice(0, 1));
    assert.equal(controller.getProcessedCount("white"), 1);
  });
}

test("a historical drain advances the model without output effects", () => {
  const { controller, context, outputs } = harness();
  controller.remember(match("white", whiteMoves.join("-")), "match");
  assert.equal(controller.drain("match", false), true);
  assert.equal(context.game.toFen(), required(unverifiedSnapshot()).toFen());
  assert.deepEqual(outputs, []);
  assert.equal(controller.getProcessedCount("white"), 2);
});
