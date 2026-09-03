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
  assert.deepEqual(
    databaseRules.rules.profileGameProjectionOutbox.profile[".indexOn"],
    ["lastQueuedAtMs"],
  );
});

test("player reads expose gameplay state without exposing wager operations", () => {
  const players = databaseRules.rules.players;
  assert.equal(players[".read"], undefined);
  assert.equal(players.$userId.matches[".read"], true);
  assert.equal(players.$userId.profile[".read"], true);
  assert.equal(players.$userId.mining.frozen[".read"], true);
  assert.equal(players.$userId.mining._wagerOps, undefined);
});

test("structural gameplay writes are Worker-owned while live match updates remain", () => {
  const invites = databaseRules.rules.invites.$inviteId;
  const player = databaseRules.rules.players.$userId;
  assert.equal(invites[".write"], undefined);
  assert.equal(invites.guestId[".write"], undefined);
  assert.equal(invites.hostRematches[".write"], undefined);
  assert.equal(invites.guestRematches[".write"], undefined);
  assert.match(invites.reactions.$playerId[".write"], /auth != null/);
  assert.equal(player[".write"], undefined);
  assert.match(player.matches.$matchId[".write"], /data\.exists\(\)/);
  assert.match(player.matches.$matchId[".write"], /newData\.exists\(\)/);
  assert.deepEqual(databaseRules.rules.gameplayMutationReceipts[".indexOn"], [
    "completedAtMs",
  ]);
  assert.deepEqual(
    databaseRules.rules.gameplayMutationReceiptExpirations[".indexOn"],
    ["completedAtMs"],
  );
  assert.equal(databaseRules.rules.gameplayMutationLocks, undefined);
});

test("timer coordination roots are protected and fence live match writes", () => {
  assert.deepEqual(databaseRules.rules.matchTimerClaims, {
    ".read": false,
    ".write": false,
  });
  assert.deepEqual(databaseRules.rules.matchTimerStarts, {
    ".read": false,
    ".write": false,
  });
  assert.equal(
    databaseRules.rules.players.$userId.matches.$matchId.timer[".validate"],
    "newData.isString() && (newData.val() === '' || newData.val() === data.val() || (auth != null && auth.token.admin === true))",
  );
  const matchValidation =
    databaseRules.rules.players.$userId.matches.$matchId[".validate"];
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
