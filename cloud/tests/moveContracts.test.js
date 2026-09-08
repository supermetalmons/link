"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MATCH_MOVE_PATH,
  MAX_MATCH_MOVE_REQUEST_BYTES,
  MAX_MATCH_MOVE_PREVIOUS_STATES,
  countMoveHistory,
  isMoveHistoryPrefix,
  isSubmitMoveRequest,
  isSubmitMoveResponse,
} = require("@mons/shared/game-sessions");
const {
  MAX_MATCH_FEN_BYTES,
  MAX_MATCH_HISTORY_BYTES,
  MAX_MATCH_HISTORY_ENTRIES,
} = require("@mons/shared/match-protocol");

const request = {
  inviteId: "invite",
  matchId: "invite",
  playerId: "player",
  previousFlatMovesString: "",
  flatMovesString: "move",
  fen: "next-fen",
};

test("move contracts accept initial and rematch appends with optional legacy variant", () => {
  assert.equal(MATCH_MOVE_PATH, "/matches/move");
  assert.equal(isSubmitMoveRequest(request), true);
  assert.equal(
    isSubmitMoveRequest({
      ...request,
      matchId: "invite2",
      previousFlatMovesString: "first",
      flatMovesString: "first-next",
      gameVariant: "Classic",
    }),
    true,
  );
});

test("move contracts reject unknown fields and invalid match identities", () => {
  for (const field of [
    "status",
    "timer",
    "emojiId",
    "aura",
    "operationId",
    "workerMoveMatchId",
  ]) {
    assert.equal(isSubmitMoveRequest({ ...request, [field]: "value" }), false);
  }
  for (const field of Object.keys(request)) {
    const missing = { ...request };
    delete missing[field];
    assert.equal(isSubmitMoveRequest(missing), false);
    assert.equal(isSubmitMoveRequest({ ...request, [field]: null }), false);
  }
  for (const field of ["inviteId", "matchId", "playerId"]) {
    for (const value of ["", " key", "key ", "unsafe/key", "a".repeat(769)]) {
      assert.equal(isSubmitMoveRequest({ ...request, [field]: value }), false);
    }
  }
  assert.equal(
    isSubmitMoveRequest({ ...request, playerId: "a".repeat(129) }),
    false,
  );
  assert.equal(isSubmitMoveRequest({ ...request, matchId: "other" }), false);
  assert.equal(isSubmitMoveRequest({ ...request, matchId: "invite01" }), false);
});

test("move contracts require a nonempty appended move chain", () => {
  for (const flatMovesString of [
    "",
    "previous",
    "previous-",
    "previousmore",
    "other-next",
    "prefix-previous-next",
  ]) {
    assert.equal(
      isSubmitMoveRequest({
        ...request,
        previousFlatMovesString: "previous",
        flatMovesString,
      }),
      false,
    );
  }
  assert.equal(isSubmitMoveRequest({ ...request, flatMovesString: "" }), false);
  assert.equal(isSubmitMoveRequest({ ...request, fen: "" }), false);
});

test("move contracts enforce UTF-8 byte and history-entry limits", () => {
  assert.equal(
    isSubmitMoveRequest({
      ...request,
      fen: "é".repeat(MAX_MATCH_FEN_BYTES / 2),
    }),
    true,
  );
  assert.equal(
    isSubmitMoveRequest({
      ...request,
      fen: "é".repeat(MAX_MATCH_FEN_BYTES / 2 + 1),
    }),
    false,
  );
  assert.equal(
    isSubmitMoveRequest({
      ...request,
      flatMovesString: "x".repeat(MAX_MATCH_HISTORY_BYTES),
    }),
    true,
  );
  assert.equal(
    isSubmitMoveRequest({
      ...request,
      flatMovesString: "x".repeat(MAX_MATCH_HISTORY_BYTES + 1),
    }),
    false,
  );
  assert.equal(
    isSubmitMoveRequest({
      ...request,
      previousFlatMovesString: "x".repeat(MAX_MATCH_HISTORY_BYTES + 1),
    }),
    false,
  );
  assert.equal(
    isSubmitMoveRequest({
      ...request,
      flatMovesString: Array(MAX_MATCH_HISTORY_ENTRIES).fill("x").join("-"),
    }),
    true,
  );
  assert.equal(
    isSubmitMoveRequest({
      ...request,
      flatMovesString: Array(MAX_MATCH_HISTORY_ENTRIES + 1)
        .fill("x")
        .join("-"),
    }),
    false,
  );
  for (const gameVariant of [undefined, null, "", "é".repeat(129)]) {
    assert.equal(isSubmitMoveRequest({ ...request, gameVariant }), false);
  }
  assert.equal(
    isSubmitMoveRequest({ ...request, gameVariant: "é".repeat(128) }),
    true,
  );
});

test("bounded move envelope accommodates escaped histories and FEN at protocol limits", () => {
  const previousFlatMovesString = "\u0000".repeat(MAX_MATCH_HISTORY_BYTES - 2);
  const large = {
    ...request,
    previousFlatMovesString,
    flatMovesString: `${previousFlatMovesString}-x`,
    fen: "\u0000".repeat(MAX_MATCH_FEN_BYTES),
    gameVariant: "\u0000".repeat(256),
  };
  assert.equal(isSubmitMoveRequest(large), true);
  const bytes = Buffer.byteLength(JSON.stringify(large));
  assert.ok(bytes > 4096);
  assert.ok(bytes < MAX_MATCH_MOVE_REQUEST_BYTES);
});

test("move responses acknowledge only an exact identity and known outcome", () => {
  const response = {
    ok: true,
    inviteId: "invite",
    matchId: "invite",
    actorUid: "player",
    outcome: "applied",
  };
  assert.equal(isSubmitMoveResponse(response), true);
  assert.equal(
    isSubmitMoveResponse({ ...response, outcome: "already-applied" }),
    true,
  );
  for (const value of [
    null,
    {},
    { ...response, ok: false },
    { ...response, extra: true },
    { ...response, actorUid: "" },
    { ...response, matchId: "other" },
    { ...response, outcome: "queued" },
  ]) {
    assert.equal(isSubmitMoveResponse(value), false);
  }
});

test("history helpers distinguish complete entries and retain takebacks as progress", () => {
  assert.equal(countMoveHistory(""), 0);
  assert.equal(countMoveHistory("a-z-a"), 3);
  for (const [prefix, history, expected] of [
    ["", "", true],
    ["", "a", true],
    ["a", "a", true],
    ["a", "a-z-a", true],
    ["a-z", "a-z-a", true],
    ["a", "ab-c", false],
    ["a-b", "a-bc", false],
    ["a-b", "a-c", false],
    ["a-b", "a", false],
  ])
    assert.equal(isMoveHistoryPrefix(prefix, history), expected);
});

test("checkpoint requests include one exact state before each cumulative input", () => {
  const cumulative = {
    ...request,
    previousFlatMovesString: "confirmed",
    flatMovesString: "confirmed-a-z-next",
    previousStates: [
      { moveCount: 1, fen: "base" },
      { moveCount: 2, fen: "after-a" },
      { moveCount: 3, fen: "base" },
    ],
  };
  assert.equal(isSubmitMoveRequest(cumulative), true);
  assert.equal(
    isSubmitMoveRequest({
      ...request,
      previousStates: [{ moveCount: 0, fen: "base" }],
    }),
    true,
  );
  for (const previousStates of [
    undefined,
    null,
    {},
    [],
    Array(3),
    [{ moveCount: 1, fen: "base" }],
    cumulative.previousStates.slice(1),
    [...cumulative.previousStates, { moveCount: 4, fen: "target" }],
    cumulative.previousStates.map((state) => ({
      ...state,
      moveCount: state.moveCount + 1,
    })),
    [...cumulative.previousStates].reverse(),
  ])
    assert.equal(isSubmitMoveRequest({ ...cumulative, previousStates }), false);
});

test("checkpoint states reject extra fields, invalid counts, empty FEN and oversized FEN", () => {
  for (const state of [
    undefined,
    null,
    [],
    {},
    { moveCount: 0 },
    { fen: "base" },
    { moveCount: 0, fen: "base", extra: true },
    { moveCount: "0", fen: "base" },
    { moveCount: -1, fen: "base" },
    { moveCount: 0.5, fen: "base" },
    { moveCount: NaN, fen: "base" },
    { moveCount: Infinity, fen: "base" },
    { moveCount: 0, fen: "" },
    { moveCount: 0, fen: "é".repeat(MAX_MATCH_FEN_BYTES / 2 + 1) },
  ])
    assert.equal(
      isSubmitMoveRequest({ ...request, previousStates: [state] }),
      false,
    );
  assert.equal(
    isSubmitMoveRequest({
      ...request,
      previousStates: [
        { moveCount: 0, fen: "é".repeat(MAX_MATCH_FEN_BYTES / 2) },
      ],
    }),
    true,
  );
  for (const flatMovesString of ["-", "a-", "-a", "a--b"]) {
    assert.equal(
      isSubmitMoveRequest({
        ...request,
        flatMovesString,
        previousStates: flatMovesString
          .split("-")
          .map((_move, moveCount) => ({ moveCount, fen: "base" })),
      }),
      false,
    );
  }
});

test("checkpoint batches enforce count and whole serialized envelope limits", () => {
  assert.equal(MAX_MATCH_MOVE_PREVIOUS_STATES, 64);
  const cumulative = {
    ...request,
    flatMovesString: Array(MAX_MATCH_MOVE_PREVIOUS_STATES)
      .fill("move")
      .join("-"),
    previousStates: Array.from(
      { length: MAX_MATCH_MOVE_PREVIOUS_STATES },
      (_value, moveCount) => ({ moveCount, fen: "base" }),
    ),
  };
  assert.equal(isSubmitMoveRequest(cumulative), true);
  assert.equal(
    isSubmitMoveRequest({
      ...cumulative,
      flatMovesString: `${cumulative.flatMovesString}-extra`,
      previousStates: [
        ...cumulative.previousStates,
        { moveCount: 64, fen: "base" },
      ],
    }),
    false,
  );
  const large = {
    ...cumulative,
    previousStates: cumulative.previousStates.map((state) => ({
      ...state,
      fen: "\u0000".repeat(MAX_MATCH_FEN_BYTES),
    })),
  };
  assert.ok(
    Buffer.byteLength(JSON.stringify(large)) > MAX_MATCH_MOVE_REQUEST_BYTES,
  );
  assert.equal(isSubmitMoveRequest(large), false);
});

test("superseded acknowledgements require only bounded current FEN and history", () => {
  const superseded = {
    ok: true,
    inviteId: "invite",
    matchId: "invite",
    actorUid: "player",
    outcome: "superseded",
    fen: "current-fen",
    flatMovesString: "move-next",
  };
  assert.equal(isSubmitMoveResponse(superseded), true);
  for (const value of [
    { ...superseded, fen: "" },
    { ...superseded, flatMovesString: "" },
    { ...superseded, fen: "x".repeat(MAX_MATCH_FEN_BYTES + 1) },
    { ...superseded, flatMovesString: "x".repeat(MAX_MATCH_HISTORY_BYTES + 1) },
    {
      ...superseded,
      flatMovesString: Array(MAX_MATCH_HISTORY_ENTRIES + 1)
        .fill("x")
        .join("-"),
    },
    { ...superseded, outcome: "applied" },
    { ...superseded, outcome: "already-applied" },
    { ...superseded, extra: true },
  ])
    assert.equal(isSubmitMoveResponse(value), false);
  for (const field of Object.keys(superseded)) {
    const missing = { ...superseded };
    delete missing[field];
    assert.equal(isSubmitMoveResponse(missing), false);
  }
});
