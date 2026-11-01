import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applicationWriteFenceSql } from "../cloud/runtime/application-fence.js";
import {
  buildRetirementArmBatch,
  buildRetirementFinalizeBatch,
  executeAdmissionRetirement,
  inspectAdmissionRetirement,
  parseAdmissionRetirementManifest,
  retirementDigest,
  RETIREMENT_BINDINGS,
  RETIREMENT_MIGRATIONS,
  RETIREMENT_TARGETS,
  type RetirementBinding,
  type RetirementDependencies,
} from "./operator/applicationAdmissionRetirement.ts";
import {
  admissionRetirementSchema,
  parseAdmissionRetirementArgs,
} from "./retire-application-admissions.ts";
import type { MaintenanceStatement } from "./operator/guardedMaintenance.ts";
import type { RemoteD1Transport } from "./operator/remoteMaintenanceBinding.ts";

function fixture(t: test.TestContext) {
  const manifest = parseAdmissionRetirementManifest({
    schemaVersion: 1,
    kind: "exact-http-admission-retirement",
    retirementId: "a0000000-0000-4000-8000-000000000001",
    accountId: "e25f90fc073ea309b54b8b5144bf28e0",
    generation: 3,
    dataEpoch: 1,
    armedAtMs: 1793527200000,
    targets: RETIREMENT_TARGETS.map(([operation_id, started_at_ms]) => ({
      operation_id,
      generation: 3,
      data_epoch: 1,
      kind: "http",
      started_at_ms,
      status: "running",
      failure_code: null,
      parent_operation_id: null,
    })),
    databases: RETIREMENT_BINDINGS.map((binding, index) => ({
      binding,
      databaseId: `${index + 1}0000000-0000-4000-8000-000000000001`,
    })),
  });
  const databases = new Map<RetirementBinding, DatabaseSync>(),
    batches: Array<{
      binding: RetirementBinding;
      statements: readonly MaintenanceStatement[];
    }> = [];
  for (const binding of RETIREMENT_BINDINGS) {
    const db = new DatabaseSync(":memory:");
    databases.set(binding, db);
    t.after(() => db.close());
    db.exec(
      readFileSync(
        resolve(
          "cloud/workers/api/migrations/0028_application_data_control.sql",
        ),
        "utf8",
      ),
    );
    db.exec(
      "UPDATE application_data_control SET generation = 3, data_epoch = 1; CREATE TABLE business_probe (id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO business_probe VALUES (1, 0)",
    );
    db.exec(applicationWriteFenceSql("business_probe"));
    db.exec(
      readFileSync(
        resolve("cloud/workers/api", RETIREMENT_MIGRATIONS[binding]),
        "utf8",
      ),
    );
  }
  const central = databases.get("PROFILE_GAMES_DB")!;
  for (const row of manifest.targets)
    central
      .prepare(
        "INSERT INTO application_data_admissions VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.operation_id,
        row.generation,
        row.data_epoch,
        row.kind,
        row.started_at_ms,
        row.status,
        row.failure_code,
        row.parent_operation_id,
      );
  const faults = {
    before: null as RetirementBinding | null,
    after: null as RetirementBinding | null,
  };
  function batch(
    binding: RetirementBinding,
    statements: readonly MaintenanceStatement[],
  ) {
    const db = databases.get(binding)!;
    db.exec("BEGIN");
    try {
      const output = statements.map((statement) => {
        const rows = db.prepare(statement.sql).all(...statement.bindings);
        return {
          success: true,
          results: rows,
          meta: {
            changes: /^SELECT\s/i.test(statement.sql)
              ? 0
              : Number(db.prepare("SELECT changes() AS count").get()!.count),
          },
        };
      });
      db.exec("COMMIT");
      return output;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const transports = new Map<RetirementBinding, RemoteD1Transport>();
  for (const binding of RETIREMENT_BINDINGS)
    transports.set(binding, {
      async readControl() {
        return central.prepare("SELECT * FROM application_data_control").all();
      },
      async readRows(target, statement) {
        assert.equal(target, binding);
        return databases
          .get(binding)!
          .prepare(statement.sql)
          .all(...statement.bindings);
      },
      async atomicBatch(target, statements) {
        assert.equal(target, binding);
        batches.push({ binding, statements });
        if (faults.before === binding) {
          faults.before = null;
          throw Error("unconfirmed-before-dispatch");
        }
        const result = batch(binding, statements);
        if (faults.after === binding) {
          faults.after = null;
          throw Error("lost-response-after-commit");
        }
        return result;
      },
    });
  const dependencies: RetirementDependencies = {
    async transport(binding) {
      return transports.get(binding)!;
    },
    expectedSchema: admissionRetirementSchema,
    now: () => manifest.armedAtMs + 1000,
  };
  return { manifest, databases, central, batches, faults, dependencies, batch };
}
function oldWrite(operationId: string): MaintenanceStatement[] {
  return [
    {
      sql: "INSERT INTO application_write_context VALUES (1, 3, 1, ?, NULL)",
      bindings: [operationId],
    },
    {
      sql: "UPDATE business_probe SET value = value + 1 WHERE id = 1",
      bindings: [],
    },
    {
      sql: "DELETE FROM application_write_context WHERE singleton = 1",
      bindings: [],
    },
  ];
}

test("scope rejects any substituted identity, status, generation, target order or aliased database", (t) => {
  const f = fixture(t);
  for (const mutate of [
    (x: typeof f.manifest) => {
      x.targets[0]!.operation_id = "b0000000-0000-4000-8000-000000000002";
    },
    (x: typeof f.manifest) => {
      Object.assign(x.targets[0]!, { status: "blocked" });
    },
    (x: typeof f.manifest) => {
      Object.assign(x, { generation: 4 });
    },
    (x: typeof f.manifest) => {
      x.targets.reverse();
    },
    (x: typeof f.manifest) => {
      x.databases[0]!.databaseId = x.databases[1]!.databaseId;
    },
  ]) {
    const value = structuredClone(f.manifest);
    mutate(value);
    assert.throws(() => parseAdmissionRetirementManifest(value));
  }
  assert.throws(() => parseAdmissionRetirementArgs(["--wipe"]));
  assert.throws(() =>
    parseAdmissionRetirementArgs([
      "--finalize",
      "--manifest",
      "relative",
      "--manifest-sha256",
      "a".repeat(64),
      "--directory",
      "/tmp/proof",
    ]),
  );
});

test("late writes from old code fail in every armed database while unrelated work continues", async (t) => {
  const f = fixture(t),
    root = f.manifest.targets[0]!.operation_id;
  for (const binding of RETIREMENT_BINDINGS) f.batch(binding, oldWrite(root));
  await executeAdmissionRetirement("arm-central", f.manifest, f.dependencies);
  assert.throws(
    () => f.batch("PROFILE_GAMES_DB", oldWrite(root)),
    /application-admission-retired/,
  );
  await executeAdmissionRetirement("arm-replicas", f.manifest, f.dependencies);
  for (const binding of RETIREMENT_BINDINGS) {
    assert.throws(
      () => f.batch(binding, oldWrite(root)),
      /application-admission-retired/,
    );
    f.batch(binding, oldWrite("unrelated-operation"));
    assert.equal(
      f.databases
        .get(binding)!
        .prepare("SELECT value FROM business_probe")
        .get()!.value,
      2,
    );
    assert.throws(
      () =>
        f.databases
          .get(binding)!
          .exec("DELETE FROM application_admission_retirements"),
      /immutable/,
    );
  }
  assert.equal(
    f.central
      .prepare("SELECT COUNT(*) AS count FROM application_data_admissions")
      .get()!.count,
    5,
  );
});

test("RPC-first races and orphan RPCs atomically reject arming; arm-first rejects child and ID reuse", async (t) => {
  const f = fixture(t),
    root = f.manifest.targets[0]!.operation_id;
  f.central
    .prepare(
      "INSERT INTO application_data_admissions VALUES ('child',3,1,'rpc',1,'running',NULL,?)",
    )
    .run(root);
  await assert.rejects(
    executeAdmissionRetirement("arm-central", f.manifest, f.dependencies),
  );
  assert.equal(
    f.central
      .prepare(
        "SELECT COUNT(*) AS count FROM application_admission_retirements",
      )
      .get()!.count,
    0,
  );
  f.central.exec(
    "UPDATE application_data_admissions SET parent_operation_id='missing-parent' WHERE operation_id='child'",
  );
  await assert.rejects(
    executeAdmissionRetirement("arm-central", f.manifest, f.dependencies),
  );
  f.central.exec(
    "DELETE FROM application_data_admissions WHERE operation_id='child'",
  );
  await executeAdmissionRetirement("arm-central", f.manifest, f.dependencies);
  assert.throws(
    () =>
      f.central
        .prepare(
          "INSERT INTO application_data_admissions VALUES ('late-child',3,1,'rpc',1,'running',NULL,?)",
        )
        .run(root),
    /application-admission-retired/,
  );
  assert.throws(
    () =>
      f.central
        .prepare("DELETE FROM application_data_admissions WHERE operation_id=?")
        .run(root),
    /receipt-required/,
  );
  assert.throws(
    () =>
      f.central
        .prepare(
          "UPDATE application_data_admissions SET status='blocked',failure_code='operation-failed' WHERE operation_id=?",
        )
        .run(root),
    /immutable/,
  );
  assert.throws(
    () =>
      f.central
        .prepare(
          "INSERT OR REPLACE INTO application_data_admissions VALUES (?,3,1,'http',1,'running',NULL,NULL)",
        )
        .run(root),
    /application-admission-retired/,
  );
});

test("source drift and batch failure leave no partial tombstones", (t) => {
  const f = fixture(t);
  f.central
    .prepare(
      "UPDATE application_data_admissions SET started_at_ms=2 WHERE operation_id=?",
    )
    .run(f.manifest.targets[4]!.operation_id);
  assert.throws(() =>
    f.batch(
      "PROFILE_GAMES_DB",
      buildRetirementArmBatch(f.manifest, "PROFILE_GAMES_DB"),
    ),
  );
  assert.equal(
    f.central
      .prepare(
        "SELECT COUNT(*) AS count FROM application_admission_retirements",
      )
      .get()!.count,
    0,
  );
});

test("partial replica installation stays fenced and resumes without replaying confirmed writes", async (t) => {
  const f = fixture(t);
  await executeAdmissionRetirement("arm-central", f.manifest, f.dependencies);
  f.faults.before = "AUTH_STATE_DB";
  await assert.rejects(
    executeAdmissionRetirement("arm-replicas", f.manifest, f.dependencies),
  );
  assert.equal(
    f.databases
      .get("PROFILE_DB")!
      .prepare(
        "SELECT COUNT(*) AS count FROM application_admission_retirements",
      )
      .get()!.count,
    5,
  );
  const prior = f.batches.filter((x) => x.binding === "PROFILE_DB").length;
  await executeAdmissionRetirement("arm-replicas", f.manifest, f.dependencies);
  assert.equal(
    f.batches.filter((x) => x.binding === "PROFILE_DB").length,
    prior,
  );
  await executeAdmissionRetirement("finalize", f.manifest, f.dependencies);
  assert.equal(
    f.central
      .prepare("SELECT COUNT(*) AS count FROM application_data_admissions")
      .get()!.count,
    0,
  );
});

test("lost responses reconcile by immutable readback and duplicate finalization does not write", async (t) => {
  const f = fixture(t);
  f.faults.after = "PROFILE_GAMES_DB";
  assert.equal(
    (
      await executeAdmissionRetirement(
        "arm-central",
        f.manifest,
        f.dependencies,
      )
    ).reconciledAfterUncertainResponse,
    true,
  );
  await executeAdmissionRetirement("arm-replicas", f.manifest, f.dependencies);
  f.central.exec(
    "INSERT INTO application_data_admissions VALUES ('unrelated-http',3,1,'http',1,'running',NULL,NULL); CREATE TABLE preserved_receipts (id TEXT PRIMARY KEY, value TEXT); INSERT INTO preserved_receipts VALUES ('financial-and-auth','unchanged')",
  );
  f.faults.after = "PROFILE_GAMES_DB";
  assert.equal(
    (await executeAdmissionRetirement("finalize", f.manifest, f.dependencies))
      .reconciledAfterUncertainResponse,
    true,
  );
  const count = f.batches.length;
  await executeAdmissionRetirement("finalize", f.manifest, f.dependencies);
  assert.equal(f.batches.length, count);
  assert.deepEqual(
    f.central
      .prepare("SELECT operation_id FROM application_data_admissions")
      .all()
      .map((x) => x.operation_id),
    ["unrelated-http"],
  );
  assert.equal(
    f.central.prepare("SELECT value FROM preserved_receipts").get()!.value,
    "unchanged",
  );
  const receipt = f.central
    .prepare("SELECT * FROM application_admission_retirement_receipts")
    .get()!;
  assert.equal(receipt.successful_completion_claimed, 0);
  assert.equal(receipt.invocation_termination_claimed, 0);
  assert.equal(receipt.accepted_independent_work_preserved, 1);
  assert.throws(
    () =>
      f.central.exec(
        "UPDATE application_admission_retirement_receipts SET successful_completion_claimed=1",
      ),
    /immutable/,
  );
  assert.throws(
    () =>
      f.central.exec("DELETE FROM application_admission_retirement_receipts"),
    /immutable/,
  );
});

test("finalization rollback preserves source rows and has no receipt when a new unrelated RPC races", async (t) => {
  const f = fixture(t);
  await executeAdmissionRetirement("arm-central", f.manifest, f.dependencies);
  await executeAdmissionRetirement("arm-replicas", f.manifest, f.dependencies);
  const snapshots = await inspectAdmissionRetirement(
      f.manifest,
      f.dependencies,
    ),
    batch = buildRetirementFinalizeBatch(
      f.manifest,
      snapshots,
      f.manifest.armedAtMs + 1,
    );
  f.central.exec(
    "INSERT INTO application_data_admissions VALUES ('other-root',3,1,'http',1,'running',NULL,NULL); INSERT INTO application_data_admissions VALUES ('other-rpc',3,1,'rpc',1,'running',NULL,'other-root')",
  );
  assert.throws(() => f.batch("PROFILE_GAMES_DB", batch));
  assert.equal(
    f.central
      .prepare(
        "SELECT COUNT(*) AS count FROM application_admission_retirement_receipts",
      )
      .get()!.count,
    0,
  );
  assert.equal(
    f.central
      .prepare(
        "SELECT COUNT(*) AS count FROM application_data_admissions WHERE kind='http'",
      )
      .get()!.count,
    6,
  );
  f.central.exec(
    "DELETE FROM application_data_admissions WHERE operation_id='other-rpc'",
  );
  await executeAdmissionRetirement("finalize", f.manifest, f.dependencies);
});

test("schema replacement or conflicting existing tombstone fails closed", async (t) => {
  const f = fixture(t);
  f.databases
    .get("TELEGRAM_DB")!
    .exec("DROP TRIGGER application_retired_write_context_guard");
  await assert.rejects(
    executeAdmissionRetirement("arm-central", f.manifest, f.dependencies),
    /schema-mismatch/,
  );
  assert.equal(f.batches.length, 0);
  assert.equal(retirementDigest(f.manifest).length, 64);
});
