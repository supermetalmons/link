import type { D1Migration } from "cloudflare:test";

export async function resetMatchPresentationTestState(
  db: D1Database,
  migrations: D1Migration[],
  phase: boolean | "durable" = false,
): Promise<void> {
  const migration = migrations.find((entry) =>
    entry.name.includes("0021_match_presentations"),
  );
  if (!migration) throw new Error("missing-match-presentation-test-migration");
  const sourceExceptions = migrations.find((entry) =>
    entry.name.includes("0022_match_presentation_source_exceptions"),
  );
  const insertGuards = migrations.find((entry) =>
    entry.name.includes("0023_match_presentation_insert_guards"),
  );
  const cleanup = migrations.find(({ name }) =>
    name.endsWith("_retire_canonical_source_tables.sql"),
  );
  const cleaned =
    cleanup &&
    (await db
      .prepare("SELECT name FROM d1_migrations WHERE name = ?")
      .bind(cleanup.name)
      .first());
  if (cleaned) {
    const deleteGuard = migration.queries.find((query) =>
      query.includes("CREATE TRIGGER match_presentation_control_delete_guard"),
    );
    if (!deleteGuard)
      throw new Error("missing-presentation-control-delete-guard");
    await db.batch([
      db.prepare("DROP TRIGGER match_presentation_control_delete_guard"),
      db.prepare("DELETE FROM match_presentation_control"),
      db.prepare(
        "INSERT INTO match_presentation_control (singleton, phase) VALUES (1, 'legacy')",
      ),
      db.prepare(deleteGuard),
      db.prepare("DELETE FROM match_presentation_registration_guards"),
    ]);
  } else
    await db.batch([
      ...(sourceExceptions
        ? [db.prepare("DROP TABLE match_presentation_source_exceptions")]
        : []),
      db.prepare("DROP TRIGGER match_presentation_manual_completion_guard"),
      db.prepare("DROP TRIGGER match_presentation_event_publication_guard"),
      db.prepare("DROP TABLE match_presentation_registrations"),
      db.prepare("DROP TABLE match_presentation_registration_guards"),
      db.prepare("DROP TABLE match_presentation_control"),
      ...migration.queries.map((query) => db.prepare(query)),
      ...(sourceExceptions?.queries.map((query) => db.prepare(query)) || []),
      ...(insertGuards?.queries.map((query) => db.prepare(query)) || []),
    ]);
  const canonical = migrations.find((entry) => entry.name.startsWith("0030_"));
  if (canonical) {
    const resetTables = [
      "match_presentation_registrations_canonical",
      "match_presentation_source_exceptions_canonical",
    ];
    for (const table of resetTables) {
      const exists = await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .bind(table)
        .first();
      if (!exists) continue;
      const trigger = `${table}_delete_guard`;
      const definition = canonical.queries.find((query) =>
        query.includes(`CREATE TRIGGER ${trigger} `),
      );
      if (!definition)
        throw new Error("missing-canonical-presentation-delete-guard");
      await db.batch([
        db.prepare(`DROP TRIGGER ${trigger}`),
        db.prepare(`DELETE FROM ${table}`),
        db.prepare(definition),
      ]);
    }
  }
  if (phase) {
    await db
      .prepare(
        `UPDATE match_presentation_control
         SET phase = 'capture',
             candidate_version_id = '00000000-0000-4000-8000-000000000001',
             migration_id = '00000000-0000-4000-8000-000000000002',
             capture_started_at_ms = 1
         WHERE singleton = 1`,
      )
      .run();
  }
  if (phase === "durable") await activateDurableMatchPresentationTestState(db);
}

export async function activateDurableMatchPresentationTestState(
  db: D1Database,
): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE match_presentation_control
      SET phase = 'capture',
          candidate_version_id = '00000000-0000-4000-8000-000000000001',
          migration_id = '00000000-0000-4000-8000-000000000002',
          capture_started_at_ms = 1
      WHERE singleton = 1 AND phase = 'legacy'`),
    db
      .prepare(
        `UPDATE match_presentation_control
      SET phase = 'durable', source_digest = ?, source_count = 0,
          verification_digest = ?, verified_at_ms = 2, activated_at_ms = 3
      WHERE singleton = 1 AND phase = 'capture'`,
      )
      .bind("a".repeat(64), "b".repeat(64)),
  ]);
}
