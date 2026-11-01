import assert from "node:assert/strict";
import test from "node:test";
import { formatMatchTimer, type ClaimedTimerWrite } from "@mons/shared/timers";
import {
  createClaimedTimerDocument,
  pendingTimerClaim,
  readCommittedTimerClaim,
  readRetainedTimerClaim,
  readStoredTimerClaim,
  timerClaimStatus,
  timerClaimWireValue,
} from "../src/matchClaimCodec.ts";
import { isCommittedMatchStateClaim } from "../src/matchStateLogic.ts";
import { parseEventEffect } from "../../../runtime/eventCommandCodec.js";

const committed: ClaimedTimerWrite = {
  schemaVersion: 1,
  status: "claimed",
  inviteId: "invite",
  playerId: "host",
  opponentId: "guest",
  timer: formatMatchTimer(7, 1000),
  turnNumber: 7,
  claimedAtMs: 1001,
  expiresAtMs: null,
};

test("claim codecs accept only complete status-specific records", () => {
  assert.equal(readRetainedTimerClaim(null), null);
  for (const value of [
    undefined,
    false,
    0,
    "",
    [],
    {},
    { status: "claimed" },
    { ...committed, extra: true },
    { ...committed, schemaVersion: 2 },
  ])
    assert.throws(
      () => readRetainedTimerClaim(value),
      /match-state-invalid-claim/,
    );
  assert.deepEqual(readStoredTimerClaim(JSON.stringify(committed)), committed);
  assert.equal(timerClaimWireValue(committed), committed);
  assert.throws(
    () => readStoredTimerClaim("null"),
    /match-state-invalid-claim/,
  );
});

test("pending claims preserve an explicit expiry and reject contradictory timestamps", () => {
  const pending = readRetainedTimerClaim({
    ...committed,
    status: "pending",
    claimedAtMs: null,
    expiresAtMs: 1200,
  });
  assert.equal(timerClaimStatus(pending), "pending");
  assert.equal(pendingTimerClaim(pending)?.expiresAtMs, 1200);
  assert.equal(pendingTimerClaim(committed), null);
  for (const expiresAtMs of [undefined, null, "1200", -1, Infinity])
    assert.throws(
      () =>
        readRetainedTimerClaim({
          ...committed,
          status: "pending",
          claimedAtMs: null,
          expiresAtMs,
        }),
      /match-state-invalid-claim/,
    );
});

test("committed claim recognition requires exact identity and matching turn metadata", () => {
  const view = readCommittedTimerClaim(committed, "invite");
  assert.ok(view);
  assert.deepEqual(view.document, committed);
  assert.equal(isCommittedMatchStateClaim(committed, "other"), false);
  assert.equal(isCommittedMatchStateClaim(null, "invite"), false);
  assert.deepEqual(createClaimedTimerDocument(committed), committed);
  for (const patch of [
    { expiresAtMs: 0 },
    { turnNumber: 8 },
    { claimedAtMs: "1000" },
    { playerId: "guest" },
  ])
    assert.throws(
      () => readRetainedTimerClaim({ ...committed, ...patch }),
      /match-state-invalid-claim/,
    );
});

test("event terminal effects require the explicit finished timer state", () => {
  const target = {
    kind: "match-terminal-timer",
    playerId: "host",
    matchId: "invite",
  };
  assert.deepEqual(
    parseEventEffect({ ...target, value: { state: "finished" } }),
    { ...target, value: { state: "finished" } },
  );
  for (const value of ["gg", "unknown", null, 7, [], { state: "idle" }])
    assert.throws(
      () => parseEventEffect({ ...target, value }),
      /invalid-canonical-event-command/,
    );
});
