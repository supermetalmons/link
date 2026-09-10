import type { D1Migration } from "cloudflare:test";

export async function resetMatchPresentationTestState(
  db: D1Database,
  migrations: D1Migration[],
  capture = false,
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
  if (capture) {
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
}
