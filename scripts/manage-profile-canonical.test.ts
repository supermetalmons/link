import assert from "node:assert/strict";
import test from "node:test";
import {
  manageProfileCanonical,
  parseArgs,
  type Control,
  type ControlState,
} from "./manage-profile-canonical.ts";

test("profile canonical control accepts only one explicit operation", () => {
  for (const operation of ["status", "freeze", "resume"]) {
    assert.equal(parseArgs([`--${operation}`]), operation);
  }
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(["--freeze", "--status"]));
  assert.throws(() => parseArgs(["--begin-import"]));
  assert.throws(() => parseArgs(["--unknown"]));
});

test("profile canonical control follows the maintenance lifecycle", () => {
  let control: Control = { state: "active" };
  const logs: string[] = [];
  const dependencies = {
    log: (message: string) => logs.push(message),
    readControl: () => control,
    updateState: (expected: ControlState, next: ControlState) => {
      assert.equal(control.state, expected);
      control = { state: next };
    },
  };
  manageProfileCanonical("freeze", dependencies);
  manageProfileCanonical("resume", dependencies);
  manageProfileCanonical("freeze", dependencies);
  manageProfileCanonical("resume", dependencies);
  assert.equal(control.state, "active");
  assert.equal(logs.length, 4);
  assert.deepEqual(JSON.parse(logs[0]), {
    operation: "freeze",
    state: "frozen",
  });
});

test("profile canonical control treats repeated target states as idempotent", () => {
  let control: Control = { state: "active" };
  const dependencies = {
    log: () => undefined,
    readControl: () => control,
    updateState: () => assert.fail("must not update"),
  };
  manageProfileCanonical("resume", dependencies);
  control = { state: "frozen" };
  manageProfileCanonical("freeze", dependencies);
});
