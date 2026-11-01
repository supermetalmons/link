"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_GAME_SESSION_GAME_VARIANT_BYTES,
  isGameSessionMatch,
  isHistoricalMatchPair,
  isReadHistoricalMatchRequest,
  isReadHistoricalMatchResponse,
  normalizeHistoricalMatchRecord,
} = require("@mons/shared/game-sessions");
const {
  createInviteCandidatesFromMatchId,
  getLatestApprovedRematchIndex,
  parseInviteMatchIndex,
  parseRematchIndices,
} = require("@mons/shared/rematches");

/** @param {string} color */
const match = (color) => ({
  schemaVersion: 1,
  version: 2,
  color,
  emojiId: color === "white" ? 1 : 2,
  aura: "none",
  gameVariant: "Classic",
  fen: "fen",
  status: "surrendered",
  flatMovesString: "move",
  timer: { state: "idle" },
});

const pair = {
  matchId: "invite-1",
  hostPlayerId: "host",
  guestPlayerId: "guest",
  hostMatch: match("white"),
  guestMatch: match("black"),
};

test("validates exact historical match contracts", () => {
  assert.equal(isHistoricalMatchPair(pair), true);
  assert.equal(isReadHistoricalMatchResponse({ ok: true, pair }), true);
  assert.equal(
    isReadHistoricalMatchResponse({ ok: true, pair, extra: 1 }),
    false,
  );
  assert.equal(
    isReadHistoricalMatchRequest({
      inviteId: "invite-1",
      matchId: "invite-11",
    }),
    true,
  );
  assert.equal(
    isReadHistoricalMatchRequest({ inviteId: "invite-1", matchId: "other" }),
    false,
  );
  assert.equal(
    isReadHistoricalMatchRequest({
      inviteId: "invite-1",
      matchId: "invite-101",
    }),
    false,
  );
  assert.equal(
    isHistoricalMatchPair({ ...pair, hostMatch: null, guestMatch: null }),
    false,
  );
  assert.equal(
    isHistoricalMatchPair({
      ...pair,
      hostMatch: {
        ...pair.hostMatch,
        gameVariant: "x".repeat(MAX_GAME_SESSION_GAME_VARIANT_BYTES + 1),
      },
    }),
    false,
  );
  assert.equal(
    isHistoricalMatchPair({
      ...pair,
      hostMatch: { ...pair.hostMatch, fen: "" },
    }),
    true,
  );
  assert.equal(isGameSessionMatch({ ...pair.hostMatch, fen: "" }), false);
  const archived = normalizeHistoricalMatchRecord(pair.hostMatch);
  assert.deepEqual(archived, pair.hostMatch);
  assert.notStrictEqual(archived, pair.hostMatch);
  assert.deepEqual(
    normalizeHistoricalMatchRecord({
      ...pair.hostMatch,
      sessionCreation: null,
      reaction: null,
    }),
    pair.hostMatch,
  );
  for (const patch of [
    { schemaVersion: undefined },
    { version: undefined },
    { emojiId: "3" },
    { aura: "" },
    { aura: "x".repeat(33) },
    { gameVariant: "x".repeat(MAX_GAME_SESSION_GAME_VARIANT_BYTES + 1) },
    { status: "" },
    { status: "x".repeat(2_000) },
    { timer: "" },
    { timer: "x".repeat(2_000) },
  ])
    assert.equal(
      normalizeHistoricalMatchRecord({ ...pair.hostMatch, ...patch }),
      null,
    );
});

test("accepts only canonical rematch indices", () => {
  assert.deepEqual(
    parseRematchIndices({
      state: "open",
      indices: [1, Number.MAX_SAFE_INTEGER],
    }),
    [1, Number.MAX_SAFE_INTEGER],
  );
  for (const value of [
    "1;01;2junk",
    { state: "open", indices: [1, 1] },
    { state: "open", indices: [2, 1] },
    { state: "open", indices: [1, Number.MAX_SAFE_INTEGER + 1] },
  ])
    assert.throws(
      () => Reflect.apply(parseRematchIndices, undefined, [value]),
      /invalid-rematch-series/,
    );
  assert.equal(parseInviteMatchIndex("invite", "invite1"), 1);
  assert.equal(parseInviteMatchIndex("invite", "invite01"), null);
  assert.equal(
    parseInviteMatchIndex("invite", `invite${Number.MAX_SAFE_INTEGER + 1}`),
    null,
  );
  assert.deepEqual(createInviteCandidatesFromMatchId("invite01"), ["invite0"]);
});

test("finds the latest mutually approved rematch", () => {
  assert.equal(
    getLatestApprovedRematchIndex({
      hostRematches: { state: "open", indices: [1, 2] },
      guestRematches: { state: "open", indices: [1] },
    }),
    1,
  );
});
