import assert from "node:assert/strict";
import test from "node:test";
import {
  hasVerifiedImport,
  manageEvents,
  parseArgs,
  type EventControl,
  type EventWriteAdmissionStatus,
  type ManagementDependencies,
  type PendingEventTransitionStatus,
} from "./manage-events.ts";

const sourceDigest = "a".repeat(64);
const pendingTransition: PendingEventTransitionStatus = {
  transitionId: "et_pending-one",
  eventId: "event-one",
  expectedRevision: 2,
  attempts: 4,
  lastError: "effect-failure",
  createdAtMs: 100,
  updatedAtMs: 800,
  applicationLeaseExpiresAtMs: null,
};

function control(
  storageMode: EventControl["storageMode"],
  previousStorageMode: EventControl["previousStorageMode"],
): EventControl {
  const freezeGeneration = storageMode === "firebase" ? 0 : 1;
  return {
    storageMode,
    previousStorageMode,
    freezeGeneration,
    verifiedImportGeneration:
      storageMode === "frozen" && previousStorageMode === "firebase"
        ? freezeGeneration
        : null,
    sourceDigest,
    sourceEventCount: 3,
    sourceSelectionCount: 4,
    sourceAssignedPrizeCount: 2,
    sourceExportedAtMs: 900,
    cutoverAtMs: null,
  };
}

function dependencies(
  initial: EventControl,
  {
    admissions = 0,
    leases = 0,
    transitions = [],
  }: {
    admissions?: number | EventWriteAdmissionStatus[];
    leases?: number;
    transitions?: PendingEventTransitionStatus[];
  } = {},
) {
  let current = initial;
  let admissionRows = Array.isArray(admissions)
    ? structuredClone(admissions)
    : Array.from({ length: admissions }, (_, index) => ({
        admissionId: `admission-${index + 1}`,
        admittedStorageMode: "firebase" as const,
        createdAtMs: 1,
        expiresAtMs: 2,
        expired: true,
      }));
  let updates = 0;
  const pendingTransitions = structuredClone(transitions);
  const logs: string[] = [];
  const value: ManagementDependencies = {
    activeLeases: () => leases,
    listPendingTransitions: () => structuredClone(pendingTransitions),
    listWriteAdmissions: (nowMs) =>
      admissionRows.map((admission) => ({
        ...admission,
        expired: admission.expiresAtMs <= nowMs,
      })),
    log: (message) => logs.push(message),
    now: () => 1_000,
    readControl: () => current,
    recoverStaleAdmission: (admission, nowMs) => {
      const index = admissionRows.findIndex(
        (candidate) =>
          candidate.admissionId === admission.admissionId &&
          candidate.admittedStorageMode === admission.admittedStorageMode &&
          candidate.createdAtMs === admission.createdAtMs &&
          candidate.expiresAtMs === admission.expiresAtMs &&
          candidate.expiresAtMs <= nowMs,
      );
      if (index < 0) return false;
      admissionRows.splice(index, 1);
      return true;
    },
    updateControl: ({
      cutoverAtMs,
      expected,
      nextPreviousStorageMode,
      nextStorageMode,
    }) => {
      assert.deepEqual(current, expected);
      current = {
        ...current,
        storageMode: nextStorageMode,
        previousStorageMode: nextPreviousStorageMode,
        freezeGeneration:
          current.storageMode !== "frozen" && nextStorageMode === "frozen"
            ? current.freezeGeneration + 1
            : current.freezeGeneration,
        verifiedImportGeneration:
          current.storageMode !== "frozen" && nextStorageMode === "frozen"
            ? null
            : current.storageMode === "frozen" &&
                current.previousStorageMode === "firebase" &&
                nextStorageMode === "firebase"
              ? null
              : current.verifiedImportGeneration,
        cutoverAtMs:
          cutoverAtMs === undefined ? current.cutoverAtMs : cutoverAtMs,
      };
      updates += 1;
    },
    writeAdmissions: () => admissionRows.length,
  };
  return {
    value,
    get control() {
      return current;
    },
    get logs() {
      return logs;
    },
    get admissions() {
      return admissionRows;
    },
    get updates() {
      return updates;
    },
  };
}

test("event management operations are explicit", () => {
  for (const operation of [
    "status",
    "freeze",
    "return-to-firebase",
    "activate-d1",
    "resume-d1",
  ]) {
    assert.equal(parseArgs([`--${operation}`]), operation);
  }
  assert.deepEqual(
    parseArgs(["--recover-stale-admission", "ewa_expired-one"]),
    {
      kind: "recover-stale-admission",
      admissionId: "ewa_expired-one",
    },
  );
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(["--freeze", "--activate-d1"]));
  assert.throws(() => parseArgs(["--recover-stale-admission"]));
  assert.throws(() => parseArgs(["--dead-letter-transition", "et_poison-one"]));
  assert.throws(() =>
    parseArgs(["--recover-stale-admission", "invalid/admission"]),
  );
  assert.throws(() => parseArgs(["--delete-firebase"]));
});

test("Firebase mode freezes and can return before activation", () => {
  const state = dependencies(control("firebase", null));
  manageEvents("freeze", state.value);
  assert.equal(state.control.storageMode, "frozen");
  assert.equal(state.control.previousStorageMode, "firebase");
  assert.equal(state.control.freezeGeneration, 1);
  assert.equal(state.control.verifiedImportGeneration, null);
  manageEvents("freeze", state.value);
  assert.equal(state.updates, 1);
  manageEvents("return-to-firebase", state.value);
  assert.equal(state.control.storageMode, "firebase");
  assert.equal(state.control.previousStorageMode, null);
  assert.equal(state.updates, 2);
});

test("verified final import activates D1 and records cutover time", () => {
  const state = dependencies(control("frozen", "firebase"));
  manageEvents("activate-d1", state.value);
  assert.equal(state.control.storageMode, "d1");
  assert.equal(state.control.previousStorageMode, null);
  assert.equal(state.control.cutoverAtMs, 1_000);
  assert.equal(state.updates, 1);
  manageEvents("activate-d1", state.value);
  assert.equal(state.updates, 1);
});

test("D1 mode supports maintenance freeze and explicit resume", () => {
  const active = control("d1", null);
  active.cutoverAtMs = 800;
  const state = dependencies(active);
  manageEvents("freeze", state.value);
  assert.equal(state.control.storageMode, "frozen");
  assert.equal(state.control.previousStorageMode, "d1");
  manageEvents("resume-d1", state.value);
  assert.equal(state.control.storageMode, "d1");
  assert.equal(state.control.previousStorageMode, null);
  assert.equal(state.control.cutoverAtMs, 800);
});

test("safety transitions do not depend on event data verification", () => {
  const firebase = dependencies(control("firebase", null));
  assert.doesNotThrow(() => manageEvents("freeze", firebase.value));
  assert.equal(firebase.control.storageMode, "frozen");
  assert.doesNotThrow(() => manageEvents("return-to-firebase", firebase.value));
  assert.equal(firebase.control.storageMode, "firebase");

  const active = control("d1", null);
  active.cutoverAtMs = 800;
  const d1 = dependencies(active);
  assert.doesNotThrow(() => manageEvents("activate-d1", d1.value));
  assert.equal(d1.updates, 0);
});

test("activation rejects stale verification, active admissions, and active leases", () => {
  const invalid = control("frozen", "firebase");
  invalid.verifiedImportGeneration = null;
  assert.equal(hasVerifiedImport(invalid), false);
  assert.throws(
    () => manageEvents("activate-d1", dependencies(invalid).value),
    /verification failed/,
  );
  assert.throws(
    () =>
      manageEvents(
        "activate-d1",
        dependencies(control("frozen", "firebase"), { admissions: 1 }).value,
      ),
    /write admissions/,
  );
  assert.throws(
    () =>
      manageEvents(
        "activate-d1",
        dependencies(control("frozen", "firebase"), { leases: 1 }).value,
      ),
    /active leases/,
  );
});

test("re-freezing Firebase invalidates prior final verification", () => {
  const state = dependencies(control("frozen", "firebase"));
  manageEvents("return-to-firebase", state.value);
  manageEvents("freeze", state.value);
  assert.equal(state.control.freezeGeneration, 2);
  assert.equal(state.control.verifiedImportGeneration, null);
  assert.throws(
    () => manageEvents("activate-d1", state.value),
    /verification failed/,
  );
});

test("write admissions prevent freezing regardless of expiry", () => {
  const state = dependencies(control("firebase", null), { admissions: 1 });
  assert.throws(() => manageEvents("freeze", state.value), /write admissions/);
  assert.equal(state.updates, 0);
});

test("stale admission recovery is named, expired, and leaves other fences", () => {
  const state = dependencies(control("firebase", null), {
    admissions: [
      {
        admissionId: "ewa_expired-one",
        admittedStorageMode: "firebase",
        createdAtMs: 100,
        expiresAtMs: 900,
        expired: true,
      },
      {
        admissionId: "ewa_active-two",
        admittedStorageMode: "firebase",
        createdAtMs: 900,
        expiresAtMs: 1_100,
        expired: false,
      },
    ],
  });
  assert.throws(
    () =>
      manageEvents(
        { kind: "recover-stale-admission", admissionId: "missing" },
        state.value,
      ),
    /not found/,
  );
  assert.throws(
    () =>
      manageEvents(
        { kind: "recover-stale-admission", admissionId: "ewa_active-two" },
        state.value,
      ),
    /has not expired/,
  );
  manageEvents(
    { kind: "recover-stale-admission", admissionId: "ewa_expired-one" },
    state.value,
  );
  assert.deepEqual(
    state.admissions.map((admission) => admission.admissionId),
    ["ewa_active-two"],
  );
  assert.throws(() => manageEvents("freeze", state.value), /write admissions/);
  const output = JSON.parse(state.logs[0]);
  assert.equal(output.operation, "recover-stale-admission");
  assert.equal(output.recoveredAdmissionId, "ewa_expired-one");
  assert.equal(output.writeAdmissions, 1);
  assert.deepEqual(output.writeAdmissionRows, [
    {
      admissionId: "ewa_active-two",
      admittedStorageMode: "firebase",
      createdAtMs: 900,
      expiresAtMs: 1_100,
      expired: false,
    },
  ]);
});

test("status is read-only and does not expose event payloads", () => {
  const state = dependencies(control("firebase", null), {
    admissions: [
      {
        admissionId: "ewa_expired-status",
        admittedStorageMode: "firebase",
        createdAtMs: 100,
        expiresAtMs: 900,
        expired: true,
      },
    ],
    transitions: [pendingTransition],
  });
  manageEvents("status", state.value);
  assert.equal(state.updates, 0);
  const output = JSON.parse(state.logs[0]);
  assert.equal(output.operation, "status");
  assert.equal(output.sourceDigest, sourceDigest);
  assert.equal(output.writeAdmissions, 1);
  assert.deepEqual(output.writeAdmissionRows, [
    {
      admissionId: "ewa_expired-status",
      admittedStorageMode: "firebase",
      createdAtMs: 100,
      expiresAtMs: 900,
      expired: true,
    },
  ]);
  assert.deepEqual(output.pendingTransitions, [pendingTransition]);
  assert.equal(output.d1ActiveLeases, 0);
  assert.equal(Object.hasOwn(output, "activeLeases"), false);
  assert.equal(Object.hasOwn(output, "events"), false);
  assert.equal(Object.hasOwn(output, "verification"), false);
});
