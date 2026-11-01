import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import {
  applicationWriteBatch,
  applicationWriteFenceSql,
} from "../src/applicationDataControl.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
  TEST_AUTH_STATE_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS: D1Migration[];
  TEST_TELEGRAM_D1_MIGRATIONS: D1Migration[];
};
const groups = [
  ["PROFILE_GAMES_DB", testEnv.TEST_D1_MIGRATIONS, "0028", "0040"],
  ["PROFILE_DB", testEnv.TEST_PROFILE_D1_MIGRATIONS, "0020", "0024"],
  ["AUTH_STATE_DB", testEnv.TEST_AUTH_STATE_D1_MIGRATIONS, "0005", "0008"],
  ["EVENT_DB", testEnv.TEST_EVENT_D1_MIGRATIONS, "0009", "0013"],
  [
    "EVENT_PRIZE_WITHDRAWALS_DB",
    testEnv.TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS,
    "0007",
    "0010",
  ],
  ["TELEGRAM_DB", testEnv.TEST_TELEGRAM_D1_MIGRATIONS, "0005", "0008"],
] as const;
type Row = Record<string, string | number | null>;
type FixtureTable =
  | "application_data_admissions"
  | "application_admission_retirements"
  | "application_admission_retirement_receipts";

function insert(
  db: D1Database,
  table: FixtureTable,
  row: Row,
  replace = false,
) {
  return db
    .prepare(
      `INSERT ${replace ? "OR REPLACE " : ""}INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(
        row,
      )
        .map(() => "?")
        .join(", ")})`,
    )
    .bind(...Object.values(row));
}

function fixture(name: string) {
  const originals = Array.from({ length: 5 }, (_, index) => ({
    operation_id: `synthetic-${name}-${index}`,
    generation: 3,
    data_epoch: 1,
    kind: "http",
    started_at_ms: index + 1,
    status: "running",
    failure_code: null,
    parent_operation_id: null,
  }));
  const retirementId = `synthetic-retirement-${name}`;
  const tombstones = originals.map((row) => ({
    operation_id: row.operation_id,
    generation: row.generation,
    data_epoch: row.data_epoch,
    retirement_id: retirementId,
    manifest_digest: "a".repeat(64),
    original_row_json: JSON.stringify(row),
    original_row_digest: "b".repeat(64),
    armed_at_ms: 10,
  }));
  const receipt = {
    retirement_id: retirementId,
    manifest_digest: "a".repeat(64),
    original_rows_json: JSON.stringify(originals),
    replica_proof_json: JSON.stringify(
      Array.from({ length: 6 }, (_, replica) => ({
        syntheticReplica: replica,
      })),
    ),
    replica_proof_digest: "c".repeat(64),
    outcome: "application-write-authority-retired-outcome-unknown",
    accepted_independent_work_preserved: 1,
    successful_completion_claimed: 0,
    invocation_termination_claimed: 0,
    completed_at_ms: 20,
  };
  return { originals, tombstones, receipt };
}

function probeWrite(db: D1Database, operationId: string, probeId: string) {
  return applicationWriteBatch(
    db,
    { kind: "business", generation: 3, dataEpoch: 1, operationId },
    [
      db
        .prepare(
          "INSERT INTO retirement_business_probe (id, value) VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET value = value + 1",
        )
        .bind(probeId),
    ],
  );
}

describe("application admission retirement native guards", () => {
  beforeAll(async () => {
    const fences = applicationWriteFenceSql("retirement_business_probe").match(
      /CREATE TRIGGER[\s\S]*?END;/g,
    );
    expect(fences).toHaveLength(3);
    for (const [binding, migrations, control, retirement] of groups) {
      const selected = [
        `${control}_application_data_control.sql`,
        `${retirement}_application_admission_retirements.sql`,
      ].map((name) => {
        const migration = migrations.find((entry) => entry.name === name);
        if (!migration) throw new Error(`missing-test-migration:${name}`);
        return migration;
      });
      const db = env[binding];
      await applyD1Migrations(db, selected);
      await db.batch([
        db.prepare(
          "UPDATE application_data_control SET generation = 3, data_epoch = 1 WHERE singleton = 1",
        ),
        db.prepare(
          "CREATE TABLE retirement_business_probe (id TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT",
        ),
        ...fences!.map((sql) => db.prepare(sql)),
      ]);
    }
  });

  for (const [binding] of groups) {
    it(`${binding} fences held writes atomically and preserves unrelated work and immutable markers`, async () => {
      const db = env[binding];
      const { originals, tombstones } = fixture(`boundary-${binding}`);
      const root = originals[0]!.operation_id;
      const heldWrite = probeWrite(db, root, root);
      await db.batch(heldWrite);
      await db.batch(
        tombstones.map((row) =>
          insert(db, "application_admission_retirements", row),
        ),
      );
      await expect(
        db.batch([...probeWrite(db, "unrelated-writer", root), ...heldWrite]),
      ).rejects.toThrow("application-admission-retired");
      expect(
        await db
          .prepare("SELECT value FROM retirement_business_probe WHERE id = ?")
          .bind(root)
          .first("value"),
      ).toBe(1);
      expect(
        await db
          .prepare("SELECT COUNT(*) AS count FROM application_write_context")
          .first("count"),
      ).toBe(0);
      await db.batch(probeWrite(db, "unrelated-writer", root));
      expect(
        await db
          .prepare("SELECT value FROM retirement_business_probe WHERE id = ?")
          .bind(root)
          .first("value"),
      ).toBe(2);
      for (const sql of [
        "UPDATE application_admission_retirements SET armed_at_ms = armed_at_ms WHERE operation_id = ?",
        "DELETE FROM application_admission_retirements WHERE operation_id = ?",
      ])
        await expect(db.prepare(sql).bind(root).run()).rejects.toThrow(
          "application-retirement-immutable",
        );
      for (const replace of [false, true])
        await expect(
          insert(
            db,
            "application_admission_retirements",
            {
              ...tombstones[0]!,
              original_row_digest: "d".repeat(64),
            },
            replace,
          ).run(),
        ).rejects.toThrow("application-retirement-conflict");
      expect(
        (
          await db
            .prepare(
              "SELECT * FROM application_admission_retirements WHERE retirement_id = ? ORDER BY operation_id",
            )
            .bind(tombstones[0]!.retirement_id)
            .all()
        ).results,
      ).toEqual(tombstones);
    });
  }

  it("rejects retired children, ID reuse and source changes while unrelated admissions can finish", async () => {
    const db = env.PROFILE_GAMES_DB;
    const { originals, tombstones } = fixture("admission-guards");
    const root = originals[0]!;
    await db.batch([
      ...originals.map((row) => insert(db, "application_data_admissions", row)),
      ...tombstones.map((row) =>
        insert(db, "application_admission_retirements", row),
      ),
    ]);
    for (const replace of [false, true])
      await expect(
        insert(db, "application_data_admissions", root, replace).run(),
      ).rejects.toThrow("application-admission-retired");
    await expect(
      insert(db, "application_data_admissions", {
        ...root,
        operation_id: "synthetic-late-child",
        kind: "rpc",
        parent_operation_id: root.operation_id,
      }).run(),
    ).rejects.toThrow("application-admission-retired");
    await expect(
      db
        .prepare(
          "UPDATE application_data_admissions SET status = 'blocked', failure_code = 'operation-failed' WHERE operation_id = ?",
        )
        .bind(root.operation_id)
        .run(),
    ).rejects.toThrow("application-retired-admission-immutable");
    await expect(
      db
        .prepare(
          "DELETE FROM application_data_admissions WHERE operation_id = ?",
        )
        .bind(root.operation_id)
        .run(),
    ).rejects.toThrow("application-retirement-receipt-required");
    await db.batch([
      insert(db, "application_data_admissions", {
        ...root,
        operation_id: "synthetic-unrelated-parent",
      }),
      insert(db, "application_data_admissions", {
        ...root,
        operation_id: "synthetic-unrelated-child",
        kind: "rpc",
        parent_operation_id: "synthetic-unrelated-parent",
      }),
      db.prepare(
        "UPDATE application_data_admissions SET status = 'blocked', failure_code = 'operation-failed' WHERE operation_id = 'synthetic-unrelated-parent'",
      ),
      db.prepare(
        "DELETE FROM application_data_admissions WHERE operation_id IN ('synthetic-unrelated-parent', 'synthetic-unrelated-child')",
      ),
    ]);
    expect(
      (
        await db
          .prepare(
            "SELECT * FROM application_data_admissions WHERE operation_id LIKE 'synthetic-admission-guards-%' ORDER BY operation_id",
          )
          .all()
      ).results,
    ).toEqual(originals);
  });

  it("does not authorize deletion with a mismatched receipt identity or archived source field", async () => {
    const db = env.PROFILE_GAMES_DB;
    const mismatches: Row = {
      operation_id: "another-original",
      generation: 4,
      data_epoch: 0,
      kind: "rpc",
      started_at_ms: 99,
      status: "blocked",
      failure_code: "operation-failed",
      parent_operation_id: "another-parent",
    };
    for (const field of [
      "manifest_digest",
      "retirement_id",
      ...Object.keys(mismatches),
    ]) {
      const { originals, tombstones, receipt } = fixture(`mismatch-${field}`);
      const changed =
        field === "manifest_digest" || field === "retirement_id"
          ? { ...receipt, [field]: "d".repeat(64) }
          : {
              ...receipt,
              original_rows_json: JSON.stringify(
                originals.map((row, index) =>
                  index === 0 ? { ...row, [field]: mismatches[field] } : row,
                ),
              ),
            };
      await db.batch([
        ...originals.map((row) =>
          insert(db, "application_data_admissions", row),
        ),
        ...tombstones.map((row) =>
          insert(db, "application_admission_retirements", row),
        ),
        insert(db, "application_admission_retirement_receipts", changed),
      ]);
      await expect(
        db
          .prepare(
            "DELETE FROM application_data_admissions WHERE operation_id = ?",
          )
          .bind(originals[0]!.operation_id)
          .run(),
        field,
      ).rejects.toThrow("application-retirement-receipt-required");
      expect(
        await db
          .prepare(
            "SELECT * FROM application_data_admissions WHERE operation_id = ?",
          )
          .bind(originals[0]!.operation_id)
          .first(),
      ).toEqual(originals[0]);
    }
  });

  it("rejects malformed receipts and claims of successful completion or termination", async () => {
    const db = env.PROFILE_GAMES_DB;
    const { originals, tombstones, receipt } = fixture("malformed-receipt");
    await db.batch([
      ...originals.map((row) => insert(db, "application_data_admissions", row)),
      ...tombstones.map((row) =>
        insert(db, "application_admission_retirements", row),
      ),
    ]);
    for (const [field, value] of [
      ["manifest_digest", "invalid"],
      ["original_rows_json", "not-json"],
      ["original_rows_json", "[]"],
      ["replica_proof_json", "not-json"],
      ["replica_proof_json", "[]"],
      ["replica_proof_digest", "invalid"],
      ["outcome", "completed"],
      ["accepted_independent_work_preserved", 0],
      ["successful_completion_claimed", 1],
      ["invocation_termination_claimed", 1],
      ["completed_at_ms", 0],
    ] as const)
      await expect(
        insert(db, "application_admission_retirement_receipts", {
          ...receipt,
          [field]: value,
        }).run(),
        field,
      ).rejects.toThrow();
    expect(
      await db
        .prepare(
          "SELECT * FROM application_admission_retirement_receipts WHERE retirement_id = ?",
        )
        .bind(receipt.retirement_id)
        .first(),
    ).toBeNull();
    await expect(
      db
        .prepare(
          "DELETE FROM application_data_admissions WHERE operation_id = ?",
        )
        .bind(originals[0]!.operation_id)
        .run(),
    ).rejects.toThrow("application-retirement-receipt-required");
  });

  it("atomically archives exact originals, preserves unrelated work and retains all guards after deletion", async () => {
    const db = env.PROFILE_GAMES_DB;
    const { originals, tombstones, receipt } = fixture("atomic-receipt");
    const root = originals[0]!;
    const unrelated = {
      ...root,
      operation_id: "synthetic-preserved-admission",
    };
    await db.batch(
      [...originals, unrelated].map((row) =>
        insert(db, "application_data_admissions", row),
      ),
    );
    for (const [binding] of groups)
      await env[binding].batch(
        tombstones.map((row) =>
          insert(env[binding], "application_admission_retirements", row),
        ),
      );
    const deletion = db
      .prepare(
        "DELETE FROM application_data_admissions WHERE operation_id IN (?, ?, ?, ?, ?)",
      )
      .bind(...originals.map((row) => row.operation_id));
    await expect(
      db.batch([
        insert(db, "application_admission_retirement_receipts", receipt),
        deletion,
        db.prepare(
          "INSERT INTO application_admission_retirement_guards VALUES (0)",
        ),
      ]),
    ).rejects.toThrow("CHECK constraint failed");
    expect(
      (
        await db
          .prepare(
            "SELECT * FROM application_data_admissions WHERE operation_id LIKE 'synthetic-atomic-receipt-%' ORDER BY operation_id",
          )
          .all()
      ).results,
    ).toEqual(originals);
    expect(
      await db
        .prepare(
          "SELECT * FROM application_admission_retirement_receipts WHERE retirement_id = ?",
        )
        .bind(receipt.retirement_id)
        .first(),
    ).toBeNull();
    await db.batch([
      insert(db, "application_admission_retirement_receipts", receipt),
      deletion,
    ]);
    expect(
      (
        await db
          .prepare(
            "SELECT * FROM application_data_admissions WHERE operation_id LIKE 'synthetic-atomic-receipt-%'",
          )
          .all()
      ).results,
    ).toEqual([]);
    expect(
      await db
        .prepare(
          "SELECT * FROM application_data_admissions WHERE operation_id = ?",
        )
        .bind(unrelated.operation_id)
        .first(),
    ).toEqual(unrelated);
    for (const [binding] of groups) {
      const replica = env[binding];
      await expect(
        replica.batch(
          probeWrite(replica, root.operation_id, root.operation_id),
        ),
      ).rejects.toThrow("application-admission-retired");
      await replica.batch(
        probeWrite(replica, unrelated.operation_id, root.operation_id),
      );
      expect(
        (
          await replica
            .prepare(
              "SELECT * FROM application_admission_retirements WHERE retirement_id = ? ORDER BY operation_id",
            )
            .bind(receipt.retirement_id)
            .all()
        ).results,
      ).toEqual(tombstones);
    }
    await expect(
      insert(db, "application_data_admissions", root).run(),
    ).rejects.toThrow("application-admission-retired");
    await expect(
      insert(db, "application_data_admissions", {
        ...root,
        operation_id: "synthetic-post-delete-child",
        kind: "rpc",
        parent_operation_id: root.operation_id,
      }).run(),
    ).rejects.toThrow("application-admission-retired");
    for (const sql of [
      "UPDATE application_admission_retirement_receipts SET completed_at_ms = completed_at_ms WHERE retirement_id = ?",
      "DELETE FROM application_admission_retirement_receipts WHERE retirement_id = ?",
    ])
      await expect(
        db.prepare(sql).bind(receipt.retirement_id).run(),
      ).rejects.toThrow("application-retirement-receipt-immutable");
    for (const replace of [false, true])
      await expect(
        insert(
          db,
          "application_admission_retirement_receipts",
          { ...receipt, completed_at_ms: 99 },
          replace,
        ).run(),
      ).rejects.toThrow("application-retirement-receipt-conflict");
    expect(
      await db
        .prepare(
          "SELECT * FROM application_admission_retirement_receipts WHERE retirement_id = ?",
        )
        .bind(receipt.retirement_id)
        .first(),
    ).toEqual(receipt);
  });
});
