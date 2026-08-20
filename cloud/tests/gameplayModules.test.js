"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const databaseRules = require("../database.rules.json");
const firebaseAdmin = require("../functions/firebaseAdmin");
const {
  assertInviteMatchesPlayers,
  createMatchRecordRefs,
  inviteMatchesPlayers,
} = require("../functions/gameplay/matchRecords");
const {
  buildOrderedMatchSubmissions,
  buildOrderedMoveHistory,
  requireLaterGameFromMatchData,
  selectLaterGameForRating,
} = require("../functions/gameplay/matchReconstruction");
const {
  createLeaseToken,
  ensureRatingUpdateCompletionMarker,
  tryAcquireRatingUpdateLease,
} = require("../functions/gameplay/ratingLease");
const {
  assertPlayerClaim,
  assertResolvedPlayerClaim,
} = require("../functions/gameplay/playerAuthorization");
const {
  clearMatchTimerMarkers,
  finishMatchTimer,
} = require("../functions/gameplay/matchTimerMarkers");
const wagerMaterials = require("../functions/gameplay/wagerMaterials");
const wagerHelpers = require("../functions/wagerHelpers");

test("automatch REST queries retain their RTDB indexes", () => {
  assert.deepEqual(databaseRules.rules.automatch[".indexOn"], [
    "uid",
    "profileId",
  ]);
});

test("player reads expose gameplay state without exposing wager operations", () => {
  const players = databaseRules.rules.players;
  assert.equal(players[".read"], undefined);
  assert.equal(players.$userId.matches[".read"], true);
  assert.equal(players.$userId.profile[".read"], true);
  assert.equal(players.$userId.mining.frozen[".read"], true);
  assert.equal(players.$userId.mining._wagerOps, undefined);
});

test("timer starts use a protected marker without restricting match writes", () => {
  assert.deepEqual(databaseRules.rules.matchTimerStarts, {
    ".read": false,
    ".write": false,
  });
  assert.equal(
    databaseRules.rules.players.$userId.matches.$matchId.timer[".validate"],
    "newData.isString() && (newData.val() === '' || newData.val() === data.val() || (auth != null && auth.token.admin === true))",
  );
});

test("terminal matches clear both protected timer markers", async () => {
  const updates = [];
  await withFirebaseAdminMethod(
    "database",
    () => ({
      ref: () => ({
        update: async (value) => updates.push(value),
      }),
    }),
    async () => {
      await finishMatchTimer({
        playerId: "player",
        opponentId: "opponent",
        matchId: "match",
      });
      await clearMatchTimerMarkers({
        playerId: "player",
        opponentId: "opponent",
        matchId: "match",
      });
    },
  );
  assert.deepEqual(updates, [
    {
      "players/player/matches/match/timer": "gg",
      "matchTimerStarts/player/match": null,
      "matchTimerStarts/opponent/match": null,
    },
    {
      "matchTimerStarts/player/match": null,
      "matchTimerStarts/opponent/match": null,
    },
  ]);
});

const withFirebaseAdminMethod = async (method, replacement, callback) => {
  const original = firebaseAdmin[method];
  firebaseAdmin[method] = replacement;
  try {
    return await callback();
  } finally {
    firebaseAdmin[method] = original;
  }
};

test("wager helpers preserve their compatibility export surface", () => {
  assert.deepEqual(Object.keys(wagerHelpers), [
    "isMaterialName",
    "normalizeCount",
    "applyMaterialDeltas",
    "updateFrozenMaterials",
    "readUserMiningMaterials",
    "updateUserMiningMaterials",
  ]);
  assert.strictEqual(
    wagerHelpers.isMaterialName,
    wagerMaterials.isMaterialName,
  );
  assert.strictEqual(
    wagerHelpers.normalizeCount,
    wagerMaterials.normalizeCount,
  );
  assert.strictEqual(
    wagerHelpers.applyMaterialDeltas,
    wagerMaterials.applyMaterialDeltas,
  );
});

test("match reconstruction retains timer and rating selection policies", () => {
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
  assert.strictEqual(
    selectLaterGameForRating(mons, { fen: "missing" }, { fen: "opponent" }),
    opponentGame,
  );
  assert.throws(
    () =>
      selectLaterGameForRating(
        mons,
        { fen: "missing" },
        { fen: "also-missing" },
      ),
    (error) =>
      error.code === "internal" &&
      error.message === "Could not validate the game score.",
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

test("match record helpers retain path and participant contracts", async () => {
  const paths = [];
  await withFirebaseAdminMethod(
    "database",
    () => ({
      ref: (path) => {
        paths.push(path);
        return { path };
      },
    }),
    async () => {
      assert.deepEqual(
        createMatchRecordRefs({
          playerId: "player",
          opponentId: "opponent",
          matchId: "match",
          inviteId: "invite",
        }),
        {
          matchRef: { path: "players/player/matches/match" },
          inviteRef: { path: "invites/invite" },
          opponentMatchRef: { path: "players/opponent/matches/match" },
        },
      );
    },
  );
  assert.deepEqual(paths, [
    "players/player/matches/match",
    "players/opponent/matches/match",
    "invites/invite",
  ]);

  assert.equal(
    inviteMatchesPlayers(
      { hostId: "player", guestId: "opponent" },
      "player",
      "opponent",
    ),
    true,
  );
  assert.equal(
    inviteMatchesPlayers(
      { hostId: "opponent", guestId: "player" },
      "player",
      "opponent",
    ),
    true,
  );
  assert.throws(
    () =>
      assertInviteMatchesPlayers(
        { hostId: "other", guestId: "opponent" },
        "player",
        "opponent",
      ),
    (error) =>
      error.code === "permission-denied" &&
      error.message === "Players don't match invite data",
  );
});

test("player authorization preserves strict and unresolved profile policies", () => {
  assert.doesNotThrow(() =>
    assertPlayerClaim({
      uid: "player",
      playerId: "player",
      token: null,
      profileId: null,
    }),
  );
  assert.doesNotThrow(() =>
    assertPlayerClaim({
      uid: "login",
      playerId: "player",
      token: { profileId: "profile" },
      profileId: "profile",
    }),
  );
  assert.throws(
    () =>
      assertPlayerClaim({
        uid: "login",
        playerId: "player",
        token: {},
        profileId: "profile",
      }),
    (error) =>
      error.code === "permission-denied" &&
      error.message ===
        "You don't have permission to perform this action for this player.",
  );
  assert.doesNotThrow(() =>
    assertResolvedPlayerClaim({
      uid: "login",
      playerId: "player",
      token: {},
      profileId: "",
    }),
  );
  assert.throws(
    () =>
      assertResolvedPlayerClaim({
        uid: "login",
        playerId: "player",
        token: { profileId: "other" },
        profileId: "profile",
      }),
    (error) => error.code === "permission-denied",
  );
});

test("rating lease helpers preserve completion and transaction decisions", async () => {
  const completionWrites = [];
  assert.equal(
    await ensureRatingUpdateCompletionMarker({
      once: async () => ({ val: () => false }),
      set: async (value) => completionWrites.push(value),
    }),
    true,
  );
  assert.deepEqual(completionWrites, [true]);
  assert.equal(
    await ensureRatingUpdateCompletionMarker({
      once: async () => ({ val: () => true }),
      set: async () => assert.fail("completed markers are not rewritten"),
    }),
    false,
  );

  const originalNow = Date.now;
  const originalRandom = Math.random;
  Date.now = () => 1_000;
  Math.random = () => 0.5;
  try {
    assert.equal(createLeaseToken("owner"), "owner_1000_i");
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
  }

  const runLeaseAttempt = async (storedData, nowMs = 5_000) => {
    const writes = [];
    const originalDateNow = Date.now;
    Date.now = () => nowMs;
    try {
      const claim = await withFirebaseAdminMethod(
        "firestore",
        () => ({
          runTransaction: async (callback) =>
            callback({
              get: async () => ({
                exists: storedData !== null,
                data: () => storedData,
              }),
              set: (...args) => writes.push(args),
            }),
        }),
        () =>
          tryAcquireRatingUpdateLease({
            ratingUpdateRef: { id: "rating-update" },
            ownerUid: "owner",
            ownerToken: "owner-token",
            inviteId: "invite",
            matchId: "match",
            playerId: "player",
            opponentId: "opponent",
          }),
      );
      return { claim, writes };
    } finally {
      Date.now = originalDateNow;
    }
  };

  assert.deepEqual(await runLeaseAttempt({ status: "done", result: "win" }), {
    claim: { status: "done", data: { status: "done", result: "win" } },
    writes: [],
  });
  assert.deepEqual(
    await runLeaseAttempt({
      status: "processing",
      ownerToken: "other-token",
      leaseExpiresAtMs: 6_000,
    }),
    {
      claim: {
        status: "busy",
        data: {
          status: "processing",
          ownerToken: "other-token",
          leaseExpiresAtMs: 6_000,
        },
      },
      writes: [],
    },
  );
  const acquired = await runLeaseAttempt({
    status: "processing",
    startedAtMs: 2_000,
    ownerToken: "expired-token",
    leaseExpiresAtMs: 4_000,
  });
  assert.deepEqual(acquired.claim, {
    status: "acquired",
    data: {
      status: "processing",
      startedAtMs: 2_000,
      ownerToken: "expired-token",
      leaseExpiresAtMs: 4_000,
    },
  });
  assert.deepEqual(acquired.writes, [
    [
      { id: "rating-update" },
      {
        inviteId: "invite",
        matchId: "match",
        playerId: "player",
        opponentId: "opponent",
        ownerUid: "owner",
        ownerToken: "owner-token",
        status: "processing",
        startedAtMs: 2_000,
        updatedAtMs: 5_000,
        leaseExpiresAtMs: 35_000,
      },
      { merge: true },
    ],
  ]);
});
