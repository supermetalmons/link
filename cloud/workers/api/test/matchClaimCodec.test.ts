import assert from "node:assert/strict";
import test from "node:test";
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
import {
  decodeEventUpdates,
  encodeEventUpdates,
} from "../src/eventCompatibilityCodec.ts";

const committed = {
  status: "claimed" as const,
  inviteId: "invite-one",
  playerId: "host-login",
  opponentId: "guest-login",
  timer: "7;1000",
  turnNumber: 7,
  claimedAtMs: 1000,
  expiresAtMs: null,
};

test("retained timer claims preserve every JSON root and wire identity", () => {
  for (const value of [
    undefined,
    null,
    false,
    0,
    "",
    true,
    2,
    "legacy",
    [],
    {},
  ]) {
    const retained = readRetainedTimerClaim(value);
    assert.strictEqual(timerClaimWireValue(retained), value);
    if (value !== undefined) {
      assert.deepEqual(readStoredTimerClaim(JSON.stringify(value)), value);
    }
  }
  const source = { ...committed, extension: { retained: [null, 1] } };
  const claim = readRetainedTimerClaim(source);
  assert.strictEqual(claim, source);
  assert.deepEqual(Object.getOwnPropertySymbols(source), []);
  assert.equal(readStoredTimerClaim("1e400"), Infinity);
  assert.throws(() => readStoredTimerClaim("broken-json"), SyntaxError);
});

test("pending claim observations retain exact status and numeric expiry semantics", () => {
  for (const expiresAtMs of [undefined, null, "999", false, {}, []]) {
    const claim = readRetainedTimerClaim({ status: "pending", expiresAtMs });
    assert.equal(timerClaimStatus(claim), "pending");
    assert.equal(pendingTimerClaim(claim), null);
  }
  for (const expiresAtMs of [0, 999, 1000, 1001, NaN, Infinity, -Infinity]) {
    assert.deepEqual(
      pendingTimerClaim(
        readRetainedTimerClaim({ status: "pending", expiresAtMs }),
      ),
      { expiresAtMs },
    );
  }
  assert.equal(
    pendingTimerClaim(
      readRetainedTimerClaim({ status: " pending ", expiresAtMs: 999 }),
    ),
    null,
  );
  assert.equal(
    timerClaimStatus(readRetainedTimerClaim({ status: ["claimed"] })),
    null,
  );
});

test("committed claim recognition retains absent expiry and original extensions", () => {
  const source = { ...committed, extension: { retained: true } };
  const claim = readRetainedTimerClaim(source);
  const view = readCommittedTimerClaim(claim, committed.inviteId);
  assert.ok(view);
  assert.strictEqual(view.document, source);
  assert.equal(view.timer, committed.timer);
  assert.equal(view.claimedAtMs, committed.claimedAtMs);
  assert.equal(isCommittedMatchStateClaim(claim, "other-invite"), false);
  const { expiresAtMs: _expiry, ...withoutExpiry } = source;
  assert.equal(
    isCommittedMatchStateClaim(
      readRetainedTimerClaim(withoutExpiry),
      committed.inviteId,
    ),
    true,
  );
  assert.equal(Object.hasOwn(withoutExpiry, "expiresAtMs"), false);
  for (const invalid of [
    { expiresAtMs: 0 },
    { turnNumber: "7" },
    { claimedAtMs: "1000" },
    { timer: "8;1000" },
    { playerId: committed.opponentId },
  ]) {
    assert.equal(
      isCommittedMatchStateClaim(
        readRetainedTimerClaim({ ...source, ...invalid }),
        committed.inviteId,
      ),
      false,
    );
  }
  assert.deepEqual(createClaimedTimerDocument(committed), committed);
});

test("committed claim checks read timer before status and retain direct null failures", () => {
  for (const value of [undefined, null]) {
    assert.throws(
      () => isCommittedMatchStateClaim(value, committed.inviteId),
      TypeError,
    );
  }
  for (const value of [false, 0, "legacy", []]) {
    assert.equal(
      isCommittedMatchStateClaim(
        readRetainedTimerClaim(value),
        committed.inviteId,
      ),
      false,
    );
  }
  const failure = new Error("timer-first");
  const source = {
    get timer(): never {
      throw failure;
    },
    get status(): never {
      throw new Error("status-must-follow-timer");
    },
  };
  assert.throws(
    () =>
      isCommittedMatchStateClaim(
        readRetainedTimerClaim(source),
        committed.inviteId,
      ),
    (error) => error === failure,
  );
});

test("retained terminal-timer commands preserve their original compatibility value", () => {
  const path = "players/host-login/matches/invite-one/timer";
  for (const value of ["gg", "legacy", null, 7, [], { retained: true }]) {
    const updates = { [path]: value };
    const plan = decodeEventUpdates(updates);
    assert.deepEqual(plan, [
      {
        kind: "match-terminal-timer",
        playerId: "host-login",
        matchId: "invite-one",
        value,
      },
    ]);
    assert.deepEqual(encodeEventUpdates(plan), updates);
  }
});
