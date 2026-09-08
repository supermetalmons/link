"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isSurrenderMatchRequest,
  isSurrenderMatchResponse,
} = require("@mons/shared/game-sessions");

const request = { inviteId: "invite", matchId: "invite", playerId: "player" };

test("surrender contracts identify a match and actor without accepting mutable fields", () => {
  assert.equal(isSurrenderMatchRequest(request), true);
  assert.equal(
    isSurrenderMatchRequest({ ...request, matchId: "invite2" }),
    true,
  );
  for (const field of [
    "fen",
    "status",
    "timer",
    "aura",
    "operationId",
    "workerSurrenderMatchId",
  ]) {
    assert.equal(
      isSurrenderMatchRequest({ ...request, [field]: "value" }),
      false,
    );
  }
  for (const field of Object.keys(request)) {
    for (const value of [
      null,
      "",
      " key",
      "key ",
      "unsafe/key",
      "a".repeat(769),
    ]) {
      assert.equal(
        isSurrenderMatchRequest({ ...request, [field]: value }),
        false,
      );
    }
    const missing = { ...request };
    delete missing[field];
    assert.equal(isSurrenderMatchRequest(missing), false);
  }
  assert.equal(
    isSurrenderMatchRequest({ ...request, playerId: "a".repeat(129) }),
    false,
  );
  assert.equal(
    isSurrenderMatchRequest({ ...request, matchId: "unrelated" }),
    false,
  );
  assert.equal(
    isSurrenderMatchRequest({ ...request, matchId: "invite01" }),
    false,
  );
});

test("surrender responses require the exact acknowledged match and actor shape", () => {
  const response = {
    ok: true,
    inviteId: "invite",
    matchId: "invite",
    actorUid: "player",
  };
  assert.equal(isSurrenderMatchResponse(response), true);
  for (const value of [
    null,
    {},
    { ...response, ok: false },
    { ...response, extra: true },
    { ...response, actorUid: "" },
    { ...response, matchId: "unrelated" },
  ]) {
    assert.equal(isSurrenderMatchResponse(value), false);
  }
});
