import assert from "node:assert/strict";
import test from "node:test";
import { STATE_EFFECTS_FIELD } from "../src/stateCompatibility.ts";
import {
  StateRepositoryFailure,
  StateRepositoryPermissionDenied,
} from "../test/stateRepositoryTestTypes.ts";

test("historical effect keys and repository errors retain their published values", () => {
  assert.equal(STATE_EFFECTS_FIELD, "rtdbEffects");
  assert.equal(
    new StateRepositoryFailure().message,
    "firebase-rtdb-unavailable",
  );
  const denied = new StateRepositoryPermissionDenied();
  assert.ok(denied instanceof StateRepositoryFailure);
  assert.equal(denied.message, "firebase-rtdb-permission-denied");
});
