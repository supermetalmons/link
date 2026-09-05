import assert from "node:assert/strict";
import test from "node:test";
import {
  manageWagerReservations,
  parseArgs,
  parseControl,
  type Admission,
  type Control,
  type Dependencies,
} from "./manage-wager-reservations.ts";

function harness(storageMode: Control["storageMode"] = "d1") {
  const state = {
    control: { storageMode, freezeGeneration: 2, updatedAtMs: 1 },
    canonical: "frozen",
    admissions: [] as Admission[],
    activeLeases: 0,
    updates: 0,
    recovered: [] as string[],
    logs: [] as string[],
  };
  const dependencies: Dependencies = {
    now: () => 2_000_000,
    log: (value) => state.logs.push(value),
    readControl: () => structuredClone(state.control),
    readCanonicalState: () => state.canonical,
    readAdmissions: () => state.admissions,
    activeGameplayLeases: () => state.activeLeases,
    updateControl: (expected, next) => {
      assert.deepEqual(expected, state.control);
      state.control = structuredClone(next);
      state.updates++;
    },
    recoverAdmission: (admission) => {
      state.recovered.push(admission.admissionId);
      state.admissions = state.admissions.filter(
        (entry) => entry.admissionId !== admission.admissionId,
      );
      return true;
    },
  };
  return { state, dependencies };
}

function admission(overrides: Partial<Admission> = {}): Admission {
  return {
    admissionId: "wr_request",
    freezeGeneration: 2,
    kind: "settlement",
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    uncertain: true,
    ...overrides,
  };
}

test("management accepts permanent operations and rejects migration commands", () => {
  assert.equal(parseArgs(["--freeze"]), "freeze");
  assert.equal(parseArgs(["--resume-d1"]), "resume-d1");
  assert.deepEqual(
    parseArgs([
      "--recover-admission",
      "wr_request",
      "--confirm-request-finished",
      "--confirm-source-reconciled",
    ]),
    { kind: "recover-admission", admissionId: "wr_request" },
  );
  for (const args of [
    [],
    ["--freeze", "--status"],
    ["--resume"],
    ["--activate-d1"],
    ["--return-to-firebase"],
    ["--recover-import", "attempt", "--confirm-import-stopped"],
    ["--recover-admission", "wr_request"],
    [
      "--recover-admission",
      "bad/id",
      "--confirm-request-finished",
      "--confirm-source-reconciled",
    ],
  ])
    assert.throws(() => parseArgs(args));
  assert.throws(() =>
    parseControl({
      storage_mode: "firebase",
      freeze_generation: 0,
      updated_at_ms: 1,
    }),
  );
});

test("freeze advances the fence once and reports retained uncertain admissions", () => {
  const { state, dependencies } = harness();
  state.admissions.push(admission());
  manageWagerReservations("freeze", dependencies);
  assert.equal(state.control.storageMode, "frozen");
  assert.equal(state.control.freezeGeneration, 3);
  assert.equal(state.admissions.length, 1);
  assert.equal(JSON.parse(state.logs[0]).uncertainAdmissions, 1);
  manageWagerReservations("freeze", dependencies);
  assert.equal(state.updates, 1);
});

test("canonical maintenance is required before storage changes but status remains available", () => {
  const { state, dependencies } = harness();
  state.canonical = "active";
  assert.throws(
    () => manageWagerReservations("freeze", dependencies),
    /canonical/,
  );
  assert.equal(state.updates, 0);
  assert.doesNotThrow(() => manageWagerReservations("status", dependencies));
});

test("resume requires admissions and gameplay leases drained and preserves the generation", () => {
  const { state, dependencies } = harness("frozen");
  state.admissions.push(admission());
  assert.throws(
    () => manageWagerReservations("resume-d1", dependencies),
    /writers are not drained/,
  );
  state.admissions = [];
  state.activeLeases = 1;
  assert.throws(
    () => manageWagerReservations("resume-d1", dependencies),
    /leases are not drained/,
  );
  state.activeLeases = 0;
  manageWagerReservations("resume-d1", dependencies);
  assert.deepEqual(state.control, {
    storageMode: "d1",
    freezeGeneration: 2,
    updatedAtMs: 2_000_000,
  });
  manageWagerReservations("resume-d1", dependencies);
  assert.equal(state.updates, 1);
});

test("recovery removes only a named expired admission while both stores are frozen", () => {
  const { state, dependencies } = harness("frozen");
  state.admissions = [
    admission(),
    admission({ admissionId: "running", expiresAtMs: 3_000_000 }),
  ];
  assert.throws(
    () =>
      manageWagerReservations(
        { kind: "recover-admission", admissionId: "running" },
        dependencies,
      ),
    /not expired/,
  );
  assert.throws(
    () =>
      manageWagerReservations(
        { kind: "recover-admission", admissionId: "missing" },
        dependencies,
      ),
    /not found/,
  );
  manageWagerReservations(
    { kind: "recover-admission", admissionId: "wr_request" },
    dependencies,
  );
  assert.deepEqual(state.recovered, ["wr_request"]);
  assert.equal(state.admissions.length, 1);
  state.control.storageMode = "d1";
  assert.throws(
    () =>
      manageWagerReservations(
        { kind: "recover-admission", admissionId: "running" },
        dependencies,
      ),
    /freeze wager/,
  );
});

test("control and recovery conflicts do not report successful maintenance", () => {
  const frozen = harness("frozen");
  assert.throws(
    () =>
      manageWagerReservations("resume-d1", {
        ...frozen.dependencies,
        updateControl: () => undefined,
      }),
    /conflicted/,
  );
  frozen.state.admissions.push(admission());
  assert.throws(
    () =>
      manageWagerReservations(
        { kind: "recover-admission", admissionId: "wr_request" },
        { ...frozen.dependencies, recoverAdmission: () => false },
      ),
    /conflicted/,
  );
});
