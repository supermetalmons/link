import assert from "node:assert/strict";
import test from "node:test";
import {
  hasVerifiedImport,
  manageWagerReservations,
  parseArgs,
  parseDeployment,
  type Admission,
  type Control,
  type Dependencies,
} from "./manage-wager-reservations.ts";

function control(overrides: Partial<Control> = {}): Control {
  return {
    storageMode: "firebase",
    previousStorageMode: null,
    freezeGeneration: 0,
    activatedAtMs: null,
    verifiedImportGeneration: null,
    importAttemptId: null,
    importStartedAtMs: null,
    sourceDigest: null,
    sourceBalanceCount: null,
    sourceOperationCount: null,
    sourceFirstExportedAtMs: null,
    sourceExportedAtMs: null,
    queuesPausedAtMs: null,
    bridgeDeployedAtMs: null,
    bridgeVersionId: null,
    updatedAtMs: 1,
    ...overrides,
  };
}

function verifiedControl(): Control {
  return control({
    storageMode: "frozen",
    previousStorageMode: "firebase",
    freezeGeneration: 1,
    verifiedImportGeneration: 1,
    sourceDigest: "a".repeat(64),
    sourceBalanceCount: 2,
    sourceOperationCount: 4,
    sourceFirstExportedAtMs: 1_000_000,
    sourceExportedAtMs: 1_400_000,
    queuesPausedAtMs: 10_000,
    bridgeDeployedAtMs: 1_000,
    bridgeVersionId: "bridge-version",
  });
}

function harness(initial = control()) {
  const state = {
    control: initial,
    canonical: "frozen",
    admissions: [] as Admission[],
    activeLeases: 0,
    updates: 0,
    recovered: [] as string[],
    logs: [] as string[],
    deployment: { versionId: "bridge-version", deployedAtMs: 1_000 },
  };
  const dependencies: Dependencies = {
    now: () => 2_000_000,
    log: (value) => state.logs.push(value),
    readControl: () => structuredClone(state.control),
    readCanonicalState: () => state.canonical,
    readAdmissions: () => state.admissions,
    activeGameplayLeases: () => state.activeLeases,
    readDeployment: () => state.deployment,
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
    recoverImport: (control) => {
      assert.equal(control.importAttemptId, state.control.importAttemptId);
      state.control.importAttemptId = null;
      state.control.importStartedAtMs = null;
      state.control.verifiedImportGeneration = null;
      state.control.sourceDigest = null;
      return true;
    },
  };
  return { state, dependencies };
}

function admission(overrides: Partial<Admission> = {}): Admission {
  return {
    admissionId: "wr_request",
    storageMode: "firebase",
    freezeGeneration: 0,
    kind: "settlement",
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    uncertain: true,
    ...overrides,
  };
}

test("management requires one explicit operation and both recovery attestations", () => {
  assert.equal(parseArgs(["--freeze"]), "freeze");
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
    ["--recover-admission", "wr_request"],
    [
      "--recover-admission",
      "bad/id",
      "--confirm-request-finished",
      "--confirm-source-reconciled",
    ],
  ])
    assert.throws(() => parseArgs(args));
});

test("freeze closes storage while existing uncertain admissions remain visible", () => {
  const { state, dependencies } = harness();
  state.admissions.push(admission());
  manageWagerReservations("freeze", dependencies);
  assert.equal(state.control.storageMode, "frozen");
  assert.equal(state.control.previousStorageMode, "firebase");
  assert.equal(state.control.freezeGeneration, 1);
  assert.equal(state.admissions.length, 1);
  assert.equal(JSON.parse(state.logs[0]).uncertainAdmissions, 1);
  manageWagerReservations("freeze", dependencies);
  assert.equal(state.updates, 1);
});

test("canonical maintenance is required before storage changes", () => {
  const { state, dependencies } = harness();
  state.canonical = "active";
  assert.throws(
    () => manageWagerReservations("freeze", dependencies),
    /canonical/,
  );
  assert.equal(state.updates, 0);
  assert.doesNotThrow(() => manageWagerReservations("status", dependencies));
});

test("activation requires import proof, all admissions drained and no gameplay leases", () => {
  for (const change of [
    (state: ReturnType<typeof harness>["state"]) => {
      state.control.verifiedImportGeneration = 0;
    },
    (state: ReturnType<typeof harness>["state"]) => {
      state.admissions.push(admission());
    },
    (state: ReturnType<typeof harness>["state"]) => {
      state.activeLeases = 1;
    },
    (state: ReturnType<typeof harness>["state"]) => {
      state.deployment.versionId = "different-version";
    },
  ]) {
    const { state, dependencies } = harness(verifiedControl());
    change(state);
    assert.throws(() => manageWagerReservations("activate-d1", dependencies));
    assert.equal(state.updates, 0);
  }
  const { state, dependencies } = harness(verifiedControl());
  manageWagerReservations("activate-d1", dependencies);
  assert.equal(state.control.storageMode, "d1");
  assert.equal(state.control.activatedAtMs, 2_000_000);
  assert.throws(() =>
    manageWagerReservations("return-to-firebase", dependencies),
  );
  manageWagerReservations("freeze", dependencies);
  assert.equal(state.control.previousStorageMode, "d1");
  assert.equal(state.control.verifiedImportGeneration, null);
  manageWagerReservations("resume-d1", dependencies);
  assert.equal(state.control.activatedAtMs, 2_000_000);
  assert.equal(state.control.storageMode, "d1");
});

test("proof validation enforces source quiet interval and queue drain independently", () => {
  const verified = verifiedControl();
  assert.equal(hasVerifiedImport(verified, 2_000_000), true);
  assert.equal(
    hasVerifiedImport(
      { ...verified, sourceFirstExportedAtMs: 1_200_000 },
      2_000_000,
    ),
    false,
  );
  assert.equal(
    hasVerifiedImport({ ...verified, queuesPausedAtMs: 600_000 }, 2_000_000),
    false,
  );
  assert.equal(
    hasVerifiedImport(
      { ...verified, sourceExportedAtMs: 3_000_000 },
      2_000_000,
    ),
    false,
  );
});

test("admission recovery is individual, expired, and requires both stores frozen", () => {
  const { state, dependencies } = harness(verifiedControl());
  state.admissions = [
    admission(),
    admission({ admissionId: "still-running", expiresAtMs: 3_000_000 }),
  ];
  assert.throws(
    () =>
      manageWagerReservations(
        { kind: "recover-admission", admissionId: "still-running" },
        dependencies,
      ),
    /not expired/,
  );
  manageWagerReservations(
    { kind: "recover-admission", admissionId: "wr_request" },
    dependencies,
  );
  assert.deepEqual(state.recovered, ["wr_request"]);
  assert.equal(state.admissions.length, 1);
  state.control.storageMode = "firebase";
  state.control.previousStorageMode = null;
  assert.throws(
    () =>
      manageWagerReservations(
        { kind: "recover-admission", admissionId: "still-running" },
        dependencies,
      ),
    /freeze wager/,
  );
});

test("preactivation abort leaves imported rows inert and invalidates the proof", () => {
  const { state, dependencies } = harness(verifiedControl());
  manageWagerReservations("return-to-firebase", dependencies);
  assert.equal(state.control.storageMode, "firebase");
  assert.equal(state.control.verifiedImportGeneration, null);
  assert.equal(state.control.activatedAtMs, null);
});

test("deployment evidence selects the newest deployment and rejects split traffic", () => {
  assert.deepEqual(
    parseDeployment([
      {
        created_on: "2026-09-05T00:00:01.000Z",
        versions: [{ version_id: "new", percentage: 100 }],
      },
      {
        created_on: "2026-09-05T00:00:00.000Z",
        versions: [{ version_id: "old", percentage: 100 }],
      },
    ]),
    { versionId: "new", deployedAtMs: Date.parse("2026-09-05T00:00:01.000Z") },
  );
  assert.throws(() =>
    parseDeployment([
      {
        created_on: "2026-09-05T00:00:01Z",
        versions: [
          { version_id: "new", percentage: 50 },
          { version_id: "old", percentage: 50 },
        ],
      },
    ]),
  );
});

test("interrupted import recovery requires an explicit stopped runner and invalidates its proof", () => {
  assert.deepEqual(
    parseArgs([
      "--recover-import",
      "import-attempt",
      "--confirm-import-stopped",
    ]),
    { kind: "recover-import", importAttemptId: "import-attempt" },
  );
  assert.throws(() => parseArgs(["--recover-import", "import-attempt"]));
  const { state, dependencies } = harness(verifiedControl());
  state.control.importAttemptId = "import-attempt";
  state.control.importStartedAtMs = 1_000;
  assert.throws(
    () => manageWagerReservations("return-to-firebase", dependencies),
    /still active/,
  );
  assert.throws(
    () => manageWagerReservations("activate-d1", dependencies),
    /still active/,
  );
  assert.throws(
    () =>
      manageWagerReservations(
        { kind: "recover-import", importAttemptId: "different-attempt" },
        dependencies,
      ),
    /not found/,
  );
  state.admissions.push(admission());
  assert.throws(
    () =>
      manageWagerReservations(
        { kind: "recover-import", importAttemptId: "import-attempt" },
        dependencies,
      ),
    /not drained/,
  );
  state.admissions = [];
  manageWagerReservations(
    { kind: "recover-import", importAttemptId: "import-attempt" },
    dependencies,
  );
  assert.equal(state.control.importAttemptId, null);
  assert.equal(state.control.verifiedImportGeneration, null);
  assert.equal(state.control.sourceDigest, null);
});

export { control, verifiedControl };
