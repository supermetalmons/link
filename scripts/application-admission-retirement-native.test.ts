import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { admissionRetirementSchema } from "./retire-application-admissions.ts";
import {
  buildRetirementFinalizeBatch,
  executeAdmissionRetirement,
  inspectAdmissionRetirement,
  parseAdmissionRetirementManifest,
  RETIREMENT_BINDINGS,
  RETIREMENT_TARGETS,
  type RetirementBinding,
  type RetirementDependencies,
} from "./operator/applicationAdmissionRetirement.ts";
import type {
  MaintenanceResult,
  MaintenanceStatement,
} from "./operator/guardedMaintenance.ts";

type NativeStatement = {
  bind(...values: (string | number | null)[]): NativeStatement;
  all(): Promise<MaintenanceResult>;
};
type NativeDatabase = {
  prepare(sql: string): NativeStatement;
  batch(statements: NativeStatement[]): Promise<MaintenanceResult[]>;
  withSession(constraint: "first-primary"): {
    prepare(sql: string): NativeStatement;
  };
};

test(
  "native D1 atomically fences, rolls back receipt plus deletion, and preserves unrelated work",
  { timeout: 60000 },
  async (t) => {
    const databases = RETIREMENT_BINDINGS.map((binding, index) => ({
      binding,
      databaseId: `${index + 1}0000000-0000-4000-8000-000000000001`,
    }));
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script:
          "export default { fetch() { return new Response('local-test'); } }",
        compatibilityDate: "2026-08-09",
        log: new Log(LogLevel.NONE),
        d1Databases: Object.fromEntries(
          databases.map((row) => [row.binding, { id: row.databaseId }]),
        ),
        d1Persist: false,
      }),
    );
    t.after(() => runtime.dispose());
    const bindings =
      await runtime.getBindings<Record<RetirementBinding, NativeDatabase>>();
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(
      readFileSync(
        "cloud/workers/api/migrations/0028_application_data_control.sql",
        "utf8",
      ),
    );
    const base = sqlite
      .prepare(
        "SELECT type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name",
      )
      .all();
    sqlite.close();
    for (const binding of RETIREMENT_BINDINGS) {
      const db = bindings[binding];
      await db.batch(base.map((row) => db.prepare(String(row.sql))));
      await db.batch([
        db.prepare(
          "INSERT INTO application_data_control VALUES (1,3,1,'active',NULL)",
        ),
      ]);
      const schema = admissionRetirementSchema(binding).sort(
        (a, b) => (a.type === "table" ? 0 : 1) - (b.type === "table" ? 0 : 1),
      );
      await db.batch(schema.map((row) => db.prepare(row.sql)));
    }
    const manifest = parseAdmissionRetirementManifest({
      schemaVersion: 1,
      kind: "exact-http-admission-retirement",
      retirementId: "a0000000-0000-4000-8000-000000000002",
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
      databases,
    });
    const pg = bindings.PROFILE_GAMES_DB;
    await pg.batch(
      manifest.targets.map((row) =>
        pg
          .prepare(
            "INSERT INTO application_data_admissions VALUES (?,3,1,'http',?,'running',NULL,NULL)",
          )
          .bind(row.operation_id, row.started_at_ms),
      ),
    );
    let batches = 0;
    const dependencies: RetirementDependencies = {
      expectedSchema: admissionRetirementSchema,
      now: () => manifest.armedAtMs + 1,
      async transport(binding) {
        const db = bindings[binding];
        return {
          async readControl() {
            return (
              await pg
                .withSession("first-primary")
                .prepare("SELECT * FROM application_data_control")
                .all()
            ).results;
          },
          async readRows(target, statement) {
            assert.equal(target, binding);
            return (
              await db
                .withSession("first-primary")
                .prepare(statement.sql)
                .bind(...statement.bindings)
                .all()
            ).results;
          },
          async atomicBatch(target, statements) {
            assert.equal(target, binding);
            batches++;
            return db.batch(
              statements.map((row) =>
                db.prepare(row.sql).bind(...row.bindings),
              ),
            );
          },
        };
      },
    };
    await executeAdmissionRetirement("arm-central", manifest, dependencies);
    const root = manifest.targets[0]!.operation_id;
    await assert.rejects(
      pg.batch([
        pg
          .prepare(
            "INSERT INTO application_data_admissions VALUES ('late-child',3,1,'rpc',1,'running',NULL,?)",
          )
          .bind(root),
      ]),
      /application-admission-retired/,
    );
    await executeAdmissionRetirement("arm-replicas", manifest, dependencies);
    for (const binding of RETIREMENT_BINDINGS)
      await assert.rejects(
        bindings[binding].batch([
          bindings[binding]
            .prepare(
              "INSERT INTO application_write_context VALUES (1,3,1,?,NULL)",
            )
            .bind(root),
        ]),
        /application-admission-retired/,
      );
    await pg.batch([
      pg.prepare(
        "INSERT INTO application_data_admissions VALUES ('ordinary-http',3,1,'http',1,'running',NULL,NULL)",
      ),
    ]);
    const snapshots = await inspectAdmissionRetirement(manifest, dependencies),
      batch: MaintenanceStatement[] = [
        ...buildRetirementFinalizeBatch(
          manifest,
          snapshots,
          manifest.armedAtMs + 1,
        ),
        {
          sql: "INSERT INTO application_admission_retirement_guards VALUES (0)",
          bindings: [],
        },
      ];
    await assert.rejects(
      pg.batch(batch.map((row) => pg.prepare(row.sql).bind(...row.bindings))),
    );
    assert.equal(
      (
        await pg
          .prepare("SELECT COUNT(*) AS count FROM application_data_admissions")
          .all()
      ).results[0]!.count,
      6,
    );
    assert.equal(
      (
        await pg
          .prepare(
            "SELECT COUNT(*) AS count FROM application_admission_retirement_receipts",
          )
          .all()
      ).results[0]!.count,
      0,
    );
    await executeAdmissionRetirement("finalize", manifest, dependencies);
    assert.deepEqual(
      (
        await pg
          .prepare("SELECT operation_id FROM application_data_admissions")
          .all()
      ).results,
      [{ operation_id: "ordinary-http" }],
    );
    const prior = batches;
    await executeAdmissionRetirement("finalize", manifest, dependencies);
    assert.equal(batches, prior);
  },
);
