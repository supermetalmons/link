import assert from "node:assert/strict";
import test from "node:test";
import {
  manageProfileCanonical,
  parseArgs,
  type Control,
  type ControlState,
} from "./manage-profile-canonical.ts";

test("profile canonical control accepts only one explicit operation", () => {
  for (const operation of ["status", "begin-import", "freeze", "resume"]) {
    assert.equal(parseArgs([`--${operation}`]), operation);
  }
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(["--begin-import", "--status"]));
  assert.throws(() => parseArgs(["--unknown"]));
});

test("profile canonical control follows the exact lifecycle", () => {
  let control: Control = { state: "firestore", importedAtMs: null };
  const logs: string[] = [];
  const dependencies = {
    log: (message: string) => logs.push(message),
    readControl: () => control,
    updateState: (expected: ControlState, next: ControlState) => {
      assert.equal(control.state, expected);
      control = {
        state: next,
        importedAtMs: next === "active" || next === "frozen" ? 1 : null,
      };
    },
  };
  manageProfileCanonical("begin-import", dependencies);
  control = { state: "frozen", importedAtMs: 1 };
  manageProfileCanonical("resume", dependencies);
  manageProfileCanonical("freeze", dependencies);
  manageProfileCanonical("resume", dependencies);
  manageProfileCanonical("freeze", dependencies);
  manageProfileCanonical("resume", dependencies);
  assert.equal(control.state, "active");
  assert.equal(logs.length, 6);
});

test("profile canonical control rejects skipped transitions", () => {
  let control: Control = { state: "firestore", importedAtMs: null };
  const dependencies = {
    log: () => undefined,
    readControl: () => control,
    updateState: () => assert.fail("must not update"),
  };
  assert.throws(() => manageProfileCanonical("resume", dependencies));
  control = { state: "importing", importedAtMs: null };
  assert.throws(() => manageProfileCanonical("freeze", dependencies));
});
