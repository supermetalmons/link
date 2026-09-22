import assert from "node:assert/strict";
import test from "node:test";
import {
  STATE_EFFECTS_FIELD,
  STATE_SERVER_TIMESTAMP,
  evaluateStateValueMarker,
  stateIncrement,
} from "../src/stateCompatibility.ts";
import {
  StateRepositoryFailure,
  StateRepositoryPermissionDenied,
} from "../test/stateRepositoryTestTypes.ts";

test("neutral state operations preserve stored server-value bytes and effect keys", () => {
  assert.equal(STATE_EFFECTS_FIELD, "rtdbEffects");
  assert.equal(JSON.stringify(STATE_SERVER_TIMESTAMP), '{".sv":"timestamp"}');
  assert.equal(JSON.stringify(stateIncrement(2)), '{".sv":{"increment":2}}');
  assert.equal(
    JSON.stringify(stateIncrement(-0.5)),
    '{".sv":{"increment":-0.5}}',
  );
  assert.throws(() => stateIncrement(Infinity), TypeError);
  assert.throws(() => stateIncrement(NaN), TypeError);
});

test("stored value markers retain timestamp and numeric increment behavior", () => {
  assert.deepEqual(evaluateStateValueMarker("timestamp", 99, 123), {
    ok: true,
    value: 123,
  });
  assert.deepEqual(evaluateStateValueMarker({ increment: -0.5 }, 2, 123), {
    ok: true,
    value: 1.5,
  });
  for (const current of [null, undefined, "2", false, NaN, Infinity]) {
    assert.deepEqual(evaluateStateValueMarker({ increment: 2 }, current, 123), {
      ok: true,
      value: 2,
    });
  }
});

test("malformed markers and increment overflow remain distinct", () => {
  for (const marker of [
    null,
    "other",
    [],
    {},
    { increment: "1" },
    { increment: NaN },
    { increment: Infinity },
    { increment: 1, extra: true },
  ]) {
    assert.deepEqual(evaluateStateValueMarker(marker, 2, 123), {
      ok: false,
      reason: "invalid-marker",
    });
  }
  assert.deepEqual(
    evaluateStateValueMarker(
      { increment: Number.MAX_VALUE },
      Number.MAX_VALUE,
      123,
    ),
    { ok: false, reason: "increment-overflow" },
  );
});

test("repository errors retain their published compatibility messages", () => {
  assert.equal(
    new StateRepositoryFailure().message,
    "firebase-rtdb-unavailable",
  );
  const denied = new StateRepositoryPermissionDenied();
  assert.ok(denied instanceof StateRepositoryFailure);
  assert.equal(denied.message, "firebase-rtdb-permission-denied");
});
