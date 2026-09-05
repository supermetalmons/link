import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import {
  EventD1Conflict,
  readEventRuntimeControl,
  type EventStorageMode,
} from "../src/eventD1.ts";

export async function applyEventTestMigrations(
  db: D1Database,
  migrations: D1Migration[],
): Promise<void> {
  const finalization = migrations.findIndex((migration) =>
    migration.name.startsWith("0003_"),
  );
  if (finalization < 0) throw new Error("event-finalization-migration-missing");
  await applyD1Migrations(db, migrations.slice(0, finalization));
  await db.batch([
    db.prepare(
      `UPDATE event_runtime_control
       SET storage_mode = 'frozen', previous_storage_mode = 'firebase',
           freeze_generation = 1, updated_at_ms = 2
       WHERE singleton = 1 AND storage_mode = 'firebase'`,
    ),
    db
      .prepare(
        `UPDATE event_runtime_control
       SET source_digest = ?, source_event_count = 0,
           source_selection_count = 0, source_assignment_count = 0,
           source_exported_at_ms = 2, verified_import_generation = 1,
           updated_at_ms = 3 WHERE singleton = 1`,
      )
      .bind("a".repeat(64)),
    db.prepare(
      `UPDATE event_runtime_control
       SET storage_mode = 'd1', previous_storage_mode = NULL,
           cutover_at_ms = 4, updated_at_ms = 4 WHERE singleton = 1`,
    ),
    db.prepare(
      `UPDATE event_runtime_control
       SET storage_mode = 'frozen', previous_storage_mode = 'd1',
           freeze_generation = 2, verified_import_generation = NULL,
           updated_at_ms = 5 WHERE singleton = 1`,
    ),
  ]);
  await applyD1Migrations(db, migrations.slice(finalization));
  await transitionEventStorageMode(db, {
    expected: { storageMode: "frozen" },
    next: { storageMode: "d1" },
    nowMs: 6,
  });
}

export async function transitionEventStorageMode(
  db: D1Database,
  input: {
    expected: { storageMode: EventStorageMode };
    next: { storageMode: EventStorageMode };
    nowMs: number;
  },
) {
  const before = await readEventRuntimeControl(db);
  const result = await db
    .prepare(
      `UPDATE event_runtime_control
     SET storage_mode = ?, freeze_generation = freeze_generation + ?,
         updated_at_ms = ?
     WHERE singleton = 1 AND storage_mode = ? AND freeze_generation = ?`,
    )
    .bind(
      input.next.storageMode,
      Number(
        input.next.storageMode === "frozen" && before.storageMode !== "frozen",
      ),
      input.nowMs,
      input.expected.storageMode,
      before.freezeGeneration,
    )
    .run();
  if (result.meta.changes !== 1) throw new EventD1Conflict();
  return readEventRuntimeControl(db);
}
