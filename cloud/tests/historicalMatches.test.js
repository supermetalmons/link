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
  getHistoricalMatchIds,
  getLatestApprovedRematchIndex,
  parseInviteMatchIndex,
  parseRematchIndices,
} = require("@mons/shared/rematches");

const match = (color) => ({
  version: 2,
  color,
  emojiId: color === "white" ? 1 : 2,
  aura: "",
  gameVariant: "Classic",
  fen: "fen",
  status: "surrendered",
  flatMovesString: "move",
  timer: "",
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
  assert.deepEqual(
    normalizeHistoricalMatchRecord({
      ...pair.hostMatch,
      version: undefined,
      emojiId: "3",
      aura: "x".repeat(33),
      gameVariant: "x".repeat(MAX_GAME_SESSION_GAME_VARIANT_BYTES + 1),
      status: "x".repeat(2_000),
      timer: "x".repeat(2_000),
    }),
    {
      ...pair.hostMatch,
      version: 2,
      emojiId: 3,
      aura: "",
      gameVariant: "Classic",
      status: "",
      timer: "",
    },
  );
});

test("accepts only canonical rematch indices", () => {
  assert.deepEqual(
    parseRematchIndices(
      `1;01;2junk;${Number.MAX_SAFE_INTEGER};${Number.MAX_SAFE_INTEGER + 1}`,
    ),
    [1, Number.MAX_SAFE_INTEGER],
  );
  assert.equal(parseInviteMatchIndex("invite", "invite1"), 1);
  assert.equal(parseInviteMatchIndex("invite", "invite01"), null);
  assert.equal(
    parseInviteMatchIndex("invite", `invite${Number.MAX_SAFE_INTEGER + 1}`),
    null,
  );
  assert.deepEqual(createInviteCandidatesFromMatchId("invite01"), ["invite0"]);
});

test("derives only matches that have become historical", () => {
  assert.deepEqual(
    getHistoricalMatchIds("invite", {
      hostRematches: "1",
      guestRematches: "1",
    }),
    ["invite"],
  );
  assert.deepEqual(
    getHistoricalMatchIds("invite", {
      hostRematches: "1;2",
      guestRematches: "1;2",
    }),
    ["invite", "invite1"],
  );
  assert.deepEqual(
    getHistoricalMatchIds("invite", {
      hostRematches: "1;2x",
      guestRematches: "1;2",
    }),
    ["invite", "invite1", "invite2"],
  );
  assert.deepEqual(
    getHistoricalMatchIds("invite", {
      hostRematches: "1;2x",
      guestRematches: "1",
    }),
    ["invite", "invite1"],
  );
  assert.deepEqual(getHistoricalMatchIds("invite", { hostRematches: "1" }), [
    "invite",
  ]);
  assert.equal(
    getLatestApprovedRematchIndex({
      hostRematches: "1;2",
      guestRematches: "1",
    }),
    1,
  );
  assert.deepEqual(getHistoricalMatchIds("invite", {}), []);
  assert.deepEqual(getHistoricalMatchIds("invite", { hostRematches: "x" }), [
    "invite",
  ]);
});
