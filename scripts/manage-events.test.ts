import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  manageEvents,
  parseArgs,
  type EventControl,
  type EventWriteAdmissionStatus,
  type ManagementDependencies,
  type PendingEventTransitionStatus,
} from "./manage-events.ts";

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

function control(storageMode: EventControl["storageMode"]): EventControl {
  return { storageMode, freezeGeneration: 1 };
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
        freezeGeneration: initial.freezeGeneration,
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
          candidate.freezeGeneration === admission.freezeGeneration &&
          candidate.createdAtMs === admission.createdAtMs &&
          candidate.expiresAtMs === admission.expiresAtMs &&
          candidate.expiresAtMs <= nowMs,
      );
      if (index < 0) return false;
      admissionRows.splice(index, 1);
      return true;
    },
    updateControl: ({ expected, nextStorageMode }) => {
      assert.deepEqual(current, expected);
      current = {
        storageMode: nextStorageMode,
        freezeGeneration:
          current.freezeGeneration + Number(nextStorageMode === "frozen"),
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
  for (const operation of ["status", "freeze", "resume-d1"]) {
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

test("D1 mode supports maintenance freeze and explicit resume", () => {
  const state = dependencies(control("d1"));
  manageEvents("freeze", state.value);
  assert.equal(state.control.storageMode, "frozen");
  assert.equal(state.control.freezeGeneration, 2);
  manageEvents("freeze", state.value);
  assert.equal(state.updates, 1);
  manageEvents("resume-d1", state.value);
  assert.equal(state.control.storageMode, "d1");
  assert.equal(state.control.freezeGeneration, 2);
  manageEvents("resume-d1", state.value);
  assert.equal(state.updates, 2);
});

test("retired activation and Firebase controls are rejected", () => {
  assert.throws(() => parseArgs(["--activate-d1"]));
  assert.throws(() => parseArgs(["--return-to-firebase"]));
});

test("resume rejects remaining admissions", () => {
  const state = dependencies(control("frozen"), { admissions: 1 });
  assert.throws(
    () => manageEvents("resume-d1", state.value),
    /write admissions/,
  );
  assert.equal(state.updates, 0);
});

test("write admissions prevent freezing regardless of expiry", () => {
  const state = dependencies(control("d1"), { admissions: 1 });
  assert.throws(() => manageEvents("freeze", state.value), /write admissions/);
  assert.equal(state.updates, 0);
});

test("stale admission recovery is named, expired, and leaves other fences", () => {
  const state = dependencies(control("d1"), {
    admissions: [
      {
        admissionId: "ewa_expired-one",
        freezeGeneration: 1,
        createdAtMs: 100,
        expiresAtMs: 900,
        expired: true,
      },
      {
        admissionId: "ewa_active-two",
        freezeGeneration: 1,
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
      freezeGeneration: 1,
      createdAtMs: 900,
      expiresAtMs: 1_100,
      expired: false,
    },
  ]);
});

test("status is read-only and does not expose event payloads", () => {
  const state = dependencies(control("d1"), {
    admissions: [
      {
        admissionId: "ewa_expired-status",
        freezeGeneration: 1,
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
  assert.equal(output.freezeGeneration, 1);
  assert.equal(output.writeAdmissions, 1);
  assert.deepEqual(output.writeAdmissionRows, [
    {
      admissionId: "ewa_expired-status",
      freezeGeneration: 1,
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

const eventMigration = (name: string) =>
  readFileSync(
    new URL(`../cloud/workers/api/event-migrations/${name}`, import.meta.url),
    "utf8",
  );
const finalizeEventStorage = eventMigration("0003_finalize_event_storage.sql");

function historicalEventDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(eventMigration("0001_event_store.sql"));
  db.exec(eventMigration("0002_event_store_safety.sql"));
  return db;
}

function activateHistoricalEventStorage(db: DatabaseSync) {
  db.exec(`UPDATE event_runtime_control
    SET storage_mode = 'frozen', previous_storage_mode = 'firebase',
      freeze_generation = 1, updated_at_ms = 2;
    UPDATE event_runtime_control SET source_digest = '${"a".repeat(64)}',
      source_event_count = 0, source_selection_count = 0, source_assignment_count = 0,
      source_exported_at_ms = 2, verified_import_generation = 1, updated_at_ms = 3;
    UPDATE event_runtime_control SET storage_mode = 'd1', previous_storage_mode = NULL,
      cutover_at_ms = 4, updated_at_ms = 4;`);
}

function freezeHistoricalEventStorage(db: DatabaseSync) {
  db.exec(`UPDATE event_runtime_control
    SET storage_mode = 'frozen', previous_storage_mode = 'd1',
      freeze_generation = freeze_generation + 1, verified_import_generation = NULL,
      updated_at_ms = 5;`);
}

test("event finalization rejects unfinished, active, and undrained stores", () => {
  const setups: Array<(db: DatabaseSync) => void> = [
    () => {},
    (db) =>
      db.exec(`UPDATE event_runtime_control SET storage_mode = 'frozen',
      previous_storage_mode = 'firebase', freeze_generation = 1, updated_at_ms = 2`),
    (db) => activateHistoricalEventStorage(db),
    (db) => {
      activateHistoricalEventStorage(db);
      freezeHistoricalEventStorage(db);
      db.exec("UPDATE event_runtime_control SET cutover_at_ms = NULL");
    },
    (db) => {
      activateHistoricalEventStorage(db);
      freezeHistoricalEventStorage(db);
      db.exec(
        "INSERT INTO event_write_admissions VALUES ('admission', 'd1', 1, 2)",
      );
    },
    (db) => {
      activateHistoricalEventStorage(db);
      freezeHistoricalEventStorage(db);
      const now = Date.now();
      db.prepare(
        "INSERT INTO event_leases VALUES ('lease', 'lock', 'owner', ?, ?, ?)",
      ).run(now, now, now + 60_000);
    },
  ];
  for (const setup of setups) {
    const db = historicalEventDatabase();
    try {
      setup(db);
      assert.throws(() => db.exec(finalizeEventStorage), /CHECK constraint/);
      assert.ok(
        db
          .prepare("SELECT previous_storage_mode FROM event_runtime_control")
          .get(),
      );
    } finally {
      db.close();
    }
  }
});

test("event finalization preserves canonical and pending recovery records", () => {
  const db = historicalEventDatabase();
  try {
    activateHistoricalEventStorage(db);
    const payload = JSON.stringify({ preserved: "event-payload" });
    db.prepare(
      "INSERT INTO event_records VALUES ('event-one', 'active', 1, 2, 3, NULL, ?)",
    ).run(payload);
    db.prepare(
      "INSERT INTO profile_event_prizes VALUES ('profile-one', 'event-one', ?, 2)",
    ).run(JSON.stringify({ prizeId: "retired-prize" }));
    db.prepare(
      "INSERT INTO event_transition_intents VALUES ('transition-one', 'event-one', 3, 'pending', ?, 1, NULL, 1, 2)",
    ).run(
      JSON.stringify({
        rtdbEffects: { "invites/invite-one": { retained: true } },
      }),
    );
    const records = db.prepare("SELECT * FROM event_records").all();
    const prizes = db.prepare("SELECT * FROM profile_event_prizes").all();
    const intents = db.prepare("SELECT * FROM event_transition_intents").all();
    freezeHistoricalEventStorage(db);
    db.exec(finalizeEventStorage);
    assert.deepEqual(db.prepare("SELECT * FROM event_records").all(), records);
    assert.deepEqual(
      db.prepare("SELECT * FROM profile_event_prizes").all(),
      prizes,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM event_transition_intents").all(),
      intents,
    );
    assert.deepEqual(
      { ...db.prepare("SELECT * FROM event_runtime_control").get() },
      {
        singleton: 1,
        storage_mode: "frozen",
        freeze_generation: 2,
        updated_at_ms: 5,
      },
    );
    assert.throws(() =>
      db.exec("UPDATE event_runtime_control SET storage_mode = 'firebase'"),
    );
    assert.throws(() =>
      db.exec("INSERT INTO event_write_admissions VALUES ('blocked', 2, 1, 2)"),
    );
    db.exec("UPDATE event_runtime_control SET storage_mode = 'd1'");
    db.exec("INSERT INTO event_write_admissions VALUES ('current', 2, 1, 2)");
    assert.throws(
      () =>
        db.exec(
          "UPDATE event_runtime_control SET storage_mode = 'frozen', freeze_generation = 3",
        ),
      /admissions are active/,
    );
    db.exec("DELETE FROM event_write_admissions");
    db.exec(
      "UPDATE event_runtime_control SET storage_mode = 'frozen', freeze_generation = 3",
    );
    db.exec("UPDATE event_runtime_control SET storage_mode = 'd1'");
    assert.throws(
      () =>
        db.exec("INSERT INTO event_write_admissions VALUES ('stale', 2, 1, 2)"),
      /writes are disabled/,
    );
  } finally {
    db.close();
  }
});
