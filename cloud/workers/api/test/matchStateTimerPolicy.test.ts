import { timerClaimFixture } from "./matchClaimFixture.ts";
import {
  matchDocumentFixture,
  matchRecordFixture,
} from "./matchRecordFixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { MATCH_TIMER_TERMINAL, formatMatchTimer } from "@mons/shared/timers";
import type { MatchTimerRecord } from "../src/matchTimer.ts";
import {
  buildMatchStateTimerStartCandidate,
  decideMatchStateTimerClaim,
  decideMatchStateTimerStartCommit,
  prepareMatchStateTimerStart,
  type TimerPair,
} from "../src/matchStateTimerPolicy.ts";
import type { MatchStateClaimTimerRequest } from "../src/matchStateTypes.ts";

const nowMs = 200_000;
const request: MatchStateClaimTimerRequest = {
  inviteId: "invite-one",
  matchId: "invite-one",
  epoch: 1,
  playerId: "host-login",
  opponentId: "guest-login",
};
const marker = { timer: formatMatchTimer(7, nowMs), turnNumber: 7 };

function timerPair(
  playerFields: Partial<MatchTimerRecord> = {},
  opponentFields: Partial<MatchTimerRecord> = {},
): TimerPair {
  const base: MatchTimerRecord = {
    color: "white",
    fen: "initial",
    flatMovesString: "",
    status: "",
    timer: "",
  };
  const player = { ...base, ...playerFields };
  const opponent: MatchTimerRecord = {
    ...base,
    color: "black",
    ...opponentFields,
  };
  return {
    pair: {
      ...request,
      revision: 4,
      playerMatch: matchDocumentFixture({
        ...player,
        version: 2,
        extra: { retained: ["legacy", null] },
      }),
      opponentMatch: matchDocumentFixture({ ...opponent, version: 2 }),
      claim: null,
    },
    player,
    opponent,
    game: {
      activeColor: "black",
      historyValid: true,
      turnNumber: 7,
      winner: undefined,
    },
  };
}

test("timer start creates the current deadline for missing, older, or invalid timers", () => {
  for (const timer of ["", formatMatchTimer(6, nowMs - 1000), "malformed"]) {
    const current = timerPair({ timer });
    const before = structuredClone(current);
    const prepared = prepareMatchStateTimerStart(current);
    assert.deepEqual(buildMatchStateTimerStartCandidate(prepared, nowMs), {
      timer: formatMatchTimer(7, nowMs + 90_500),
      turnNumber: 7,
    });
    assert.deepEqual(current, before);
  }
});

test("timer start preserves an existing current-turn deadline when the clock advances", () => {
  const current = timerPair({ timer: marker.timer });
  const before = structuredClone(current);
  const prepared = prepareMatchStateTimerStart(current);
  assert.deepEqual(
    buildMatchStateTimerStartCandidate(prepared, nowMs + 5000),
    marker,
  );
  assert.deepEqual(current, before);
});

test("timer start rejects a stored timer ahead of the current turn", () => {
  const current = timerPair({ timer: formatMatchTimer(8, nowMs) });
  const before = structuredClone(current);
  assert.throws(() => prepareMatchStateTimerStart(current), {
    status: 409,
    code: "failed-precondition",
    message: "game state changed.",
  });
  assert.deepEqual(current, before);
});

test("timer start accepts concurrent timer changes and preserves non-timer fields", () => {
  const initial = timerPair();
  const fresh = timerPair(
    { timer: marker.timer },
    { timer: formatMatchTimer(6, nowMs - 1000) },
  );
  const before = structuredClone(fresh);
  const decision = decideMatchStateTimerStartCommit(initial, fresh, marker);
  assert.equal(decision.changed, false);
  assert.equal(decision.timer, marker.timer);
  assert.deepEqual(decision.playerMatch, fresh.pair.playerMatch);
  assert.deepEqual(fresh, before);

  const first = decideMatchStateTimerStartCommit(initial, initial, marker);
  assert.equal(first.changed, true);
  assert.deepEqual(first.playerMatch, {
    ...matchRecordFixture(initial.pair.playerMatch),
    timer: marker.timer,
  });
  assert.equal(initial.player.timer, "");
  assert.equal(matchRecordFixture(initial.pair.playerMatch)?.timer, "");
});

test("timer start rejects changed FEN or history from either player", () => {
  for (const fields of [{ fen: "advanced" }, { flatMovesString: "a" }]) {
    for (const fresh of [timerPair(fields), timerPair({}, fields)]) {
      assert.throws(
        () => decideMatchStateTimerStartCommit(timerPair(), fresh, marker),
        {
          status: 409,
          code: "failed-precondition",
          message: "game state changed.",
        },
      );
    }
  }
});

test("timer start distinguishes ahead markers from malformed or mismatched markers", () => {
  const current = timerPair();
  for (const timer of [formatMatchTimer(8, nowMs), "malformed"]) {
    assert.throws(
      () =>
        decideMatchStateTimerStartCommit(current, current, {
          timer,
          turnNumber: 8,
        }),
      {
        status: 409,
        code: "failed-precondition",
        message: "game state changed.",
      },
    );
  }
  for (const invalid of [
    { timer: "malformed", turnNumber: 7 },
    { timer: formatMatchTimer(6, nowMs), turnNumber: 7 },
    { timer: formatMatchTimer(6, nowMs), turnNumber: 6 },
  ]) {
    assert.throws(
      () => decideMatchStateTimerStartCommit(current, current, invalid),
      {
        status: 503,
        code: "unavailable",
        message: "gameplay-service-unavailable",
      },
    );
  }
});

test("timer decisions preserve terminal, history, then turn error precedence", () => {
  const current = timerPair({ timer: marker.timer });
  current.game.historyValid = false;
  current.game.activeColor = "white";
  current.game.winner = "white";
  const start = () =>
    decideMatchStateTimerStartCommit(timerPair(), current, marker);
  const prepare = () => prepareMatchStateTimerStart(current);
  const claim = () => decideMatchStateTimerClaim(current, request, nowMs);
  for (const decide of [prepare, start, claim]) {
    assert.throws(decide, { message: "game is already over." });
  }
  current.game.winner = undefined;
  for (const decide of [prepare, start, claim]) {
    assert.throws(decide, { message: "something is wrong with the moves." });
  }
  current.game.historyValid = true;
  for (const decide of [prepare, start])
    assert.throws(decide, { message: "can't start a timer on your own turn." });
  assert.throws(claim, {
    message: "can't claim timer victory on your own turn.",
  });
});

test("timer claim accepts the exact deadline and preserves unrelated state", () => {
  const current = timerPair({ timer: marker.timer });
  const before = structuredClone(current);
  assert.throws(() => decideMatchStateTimerClaim(current, request, nowMs - 1), {
    status: 409,
    code: "failed-precondition",
    message: "can't claim yet, 1 ms remaining",
  });
  const decision = decideMatchStateTimerClaim(current, request, nowMs);
  assert.equal(decision.changed, true);
  assert.equal(decision.claimedAtMs, nowMs);
  assert.deepEqual(decision.playerMatch, {
    ...matchRecordFixture(current.pair.playerMatch),
    timer: MATCH_TIMER_TERMINAL,
  });
  assert.deepEqual(decision.claim, {
    status: "claimed",
    playerId: request.playerId,
    opponentId: request.opponentId,
    inviteId: request.inviteId,
    timer: marker.timer,
    turnNumber: marker.turnNumber,
    claimedAtMs: nowMs,
    expiresAtMs: null,
  });
  assert.deepEqual(current, before);
});

test("timer claim honors pending fences until their exact expiry", () => {
  const current = timerPair({ timer: marker.timer });
  current.pair.claim = timerClaimFixture({
    status: "pending",
    expiresAtMs: nowMs + 1,
  });
  assert.throws(() => decideMatchStateTimerClaim(current, request, nowMs), {
    message: "game state changed.",
  });
  assert.equal(
    decideMatchStateTimerClaim(current, request, nowMs + 1).changed,
    true,
  );
});

test("terminal claim replay retains the committed timestamp and original timer", () => {
  const initial = timerPair({ timer: marker.timer });
  const first = decideMatchStateTimerClaim(initial, request, nowMs);
  const replay = timerPair({ timer: MATCH_TIMER_TERMINAL });
  replay.pair.claim = first.claim;
  replay.game.activeColor = "white";
  replay.game.historyValid = false;
  replay.game.winner = "white";
  const before = structuredClone(replay);

  const decision = decideMatchStateTimerClaim(replay, request, nowMs + 5000);
  assert.equal(decision.changed, false);
  assert.equal(decision.claimedAtMs, nowMs);
  assert.deepEqual(decision.claim, first.claim);
  assert.deepEqual(decision.playerMatch, replay.pair.playerMatch);
  assert.deepEqual(replay, before);
});
