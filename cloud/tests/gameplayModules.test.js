"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const databaseRules = require("../database.rules.json");
const {
  buildOrderedMatchSubmissions,
  buildOrderedMoveHistory,
  requireLaterGameFromMatchData,
} = require("../functions/gameplay/matchReconstruction");

test("automatch REST queries retain their RTDB indexes", () => {
  assert.deepEqual(databaseRules.rules.automatch[".indexOn"], [
    "uid",
    "profileId",
  ]);
  assert.deepEqual(
    databaseRules.rules.telegramProjectionOutbox.automatch[".indexOn"],
    ["updatedAtMs"],
  );
  assert.deepEqual(
    databaseRules.rules.profileGameProjectionOutbox.automatch[".indexOn"],
    ["lastQueuedAtMs"],
  );
  assert.equal(
    databaseRules.rules.profileGameProjectionOutbox.event,
    undefined,
  );
  assert.equal(
    databaseRules.rules.profileGameProjectionOutbox.profile,
    undefined,
  );
});

test("player reads expose gameplay state without exposing retired wager storage", () => {
  const players = databaseRules.rules.players;
  assert.equal(players[".read"], undefined);
  assert.equal(players.$userId.matches[".read"], true);
  assert.equal(players.$userId.profile[".read"], true);
  assert.equal(players.$userId.mining, undefined);
});

test("structural gameplay writes and live match updates require Workers", () => {
  const invites = databaseRules.rules.invites.$inviteId;
  const player = databaseRules.rules.players.$userId;
  assert.equal(invites[".write"], undefined);
  assert.equal(invites.guestId[".write"], undefined);
  assert.equal(invites.hostRematches[".write"], undefined);
  assert.equal(invites.guestRematches[".write"], undefined);
  assert.equal(invites.reactions, undefined);
  assert.equal(invites.wagers, undefined);
  assert.equal(invites.matchesWagerResolutions, undefined);
  assert.equal(player[".write"], undefined);
  assert.match(player.matches.$matchId[".write"], /data\.exists\(\)/);
  assert.match(player.matches.$matchId[".write"], /newData\.exists\(\)/);
  assert.match(player.matches.$matchId[".write"], /auth\.uid === \$userId/);
  assert.match(player.matches.$matchId[".write"], /workerMoveMatchId/);
  assert.match(player.matches.$matchId[".write"], /workerSurrenderMatchId/);
  assert.doesNotMatch(player.matches.$matchId[".write"], /admin|profileId/);
  assert.deepEqual(databaseRules.rules.gameplayMutationReceipts[".indexOn"], [
    "completedAtMs",
  ]);
  assert.deepEqual(
    databaseRules.rules.gameplayMutationReceiptExpirations[".indexOn"],
    ["completedAtMs"],
  );
  assert.equal(databaseRules.rules.gameplayMutationLocks, undefined);
});

test("active timer claims fence scoped match writes while preserving their timer", () => {
  assert.deepEqual(databaseRules.rules.matchTimerClaims, {
    ".read": false,
    ".write": false,
  });
  assert.equal(databaseRules.rules.matchTimerStarts, undefined);
  const matchValidation =
    databaseRules.rules.players.$userId.matches.$matchId[".validate"];
  assert.match(
    matchValidation,
    /newData\.child\('timer'\)\.exists\(\) === data\.child\('timer'\)\.exists\(\)/,
  );
  assert.match(
    matchValidation,
    /newData\.child\('timer'\)\.val\(\) === data\.child\('timer'\)\.val\(\)/,
  );
  assert.match(matchValidation, /matchTimerClaims/);
  assert.match(matchValidation, /expiresAtMs/);
});

test("match reconstruction retains the strict timer selection policy", () => {
  const playerGame = {
    name: "player",
    isLaterThan: (other) => other !== opponentGame,
  };
  const opponentGame = { name: "opponent" };
  const mons = {
    Game: {
      fromFen: (fen) => ({ player: playerGame, opponent: opponentGame })[fen],
    },
  };

  assert.strictEqual(
    requireLaterGameFromMatchData(mons, { fen: "player" }, { fen: "opponent" }),
    opponentGame,
  );
  assert.throws(
    () =>
      requireLaterGameFromMatchData(
        mons,
        { fen: "player" },
        { fen: "missing" },
      ),
    (error) =>
      error.code === "failed-precondition" &&
      error.message === "something is wrong with the game state.",
  );
});

test("match reconstruction preserves color ordering and move parsing", () => {
  const player = {
    color: "black",
    fen: "player-fen",
    flatMovesString: "p1-p2",
  };
  const opponent = {
    color: "white",
    fen: "opponent-fen",
    flatMovesString: "o1-o2",
  };

  assert.deepEqual(buildOrderedMoveHistory(player, opponent), {
    white: ["o1", "o2"],
    black: ["p1", "p2"],
  });
  assert.deepEqual(buildOrderedMatchSubmissions("black", player, opponent), {
    white: { fen: "opponent-fen", moves: ["o1", "o2"] },
    black: { fen: "player-fen", moves: ["p1", "p2"] },
  });
  assert.deepEqual(
    buildOrderedMoveHistory(
      { color: "white", flatMovesString: null },
      { flatMovesString: "" },
    ),
    { white: [], black: [] },
  );
});
