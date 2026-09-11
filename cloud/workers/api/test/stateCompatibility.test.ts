import assert from "node:assert/strict";
import test from "node:test";
import {
  STATE_EFFECTS_FIELD,
  STATE_SERVER_TIMESTAMP,
  stateIncrement,
} from "../src/stateCompatibility.ts";
import {
  StateRepositoryFailure,
  StateRepositoryPermissionDenied,
} from "../src/stateRepositoryTypes.ts";

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

test("repository errors retain their published compatibility messages", () => {
  assert.equal(
    new StateRepositoryFailure().message,
    "firebase-rtdb-unavailable",
  );
  const denied = new StateRepositoryPermissionDenied();
  assert.ok(denied instanceof StateRepositoryFailure);
  assert.equal(denied.message, "firebase-rtdb-permission-denied");
});
