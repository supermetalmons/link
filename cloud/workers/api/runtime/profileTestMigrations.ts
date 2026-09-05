import { applyD1Migrations, type D1Migration } from "cloudflare:test";

const RETIREMENT_MIGRATION = "0009_retire_legacy_profile_projection.sql";
const WAGER_FINALIZATION = "0014_finalize_wager_reservations.sql";

type ProfileMigrationOptions = {
  activateRatingCompletions?: boolean;
  legacyRatingCompletions?: Array<{ inviteId: string; matchId: string }>;
};

export async function applyRetiredProfileMigrations(
  db: D1Database,
  migrations: D1Migration[],
  importDigest: string,
  options: ProfileMigrationOptions = {},
): Promise<void> {
  const retirementIndex = migrations.findIndex(
    (migration) => migration.name === RETIREMENT_MIGRATION,
  );
  if (retirementIndex < 1 || !/^[a-f0-9]{64}$/.test(importDigest)) {
    throw new TypeError("invalid-profile-retirement-migrations");
  }
  await applyD1Migrations(db, migrations.slice(0, retirementIndex));
  await db.batch([
    db.prepare(
      `UPDATE profile_canonical_control
       SET state = 'importing'
       WHERE singleton = 1 AND state = 'firestore'`,
    ),
    db
      .prepare(
        `UPDATE profile_canonical_control
         SET import_digest = ?, import_plan_version = 1
         WHERE singleton = 1 AND state = 'importing'`,
      )
      .bind(importDigest),
    db.prepare(
      `UPDATE profile_canonical_control
       SET state = 'frozen', imported_at_ms = 1
       WHERE singleton = 1 AND state = 'importing'`,
    ),
  ]);
  const finalizationIndex = migrations.findIndex(
    (migration) => migration.name === WAGER_FINALIZATION,
  );
  await applyD1Migrations(
    db,
    migrations.slice(
      retirementIndex,
      finalizationIndex < 0 ? undefined : finalizationIndex,
    ),
  );
  if (
    options.activateRatingCompletions !== false &&
    migrations.some(
      (migration) => migration.name === "0013_rating_completions.sql",
    )
  ) {
    await db
      .prepare(
        `UPDATE rating_completion_control
       SET source_digest = ?, source_count = ?
       WHERE singleton = 1 AND activated_at_ms IS NULL`,
      )
      .bind(importDigest, options.legacyRatingCompletions?.length || 0)
      .run();
    for (const completion of options.legacyRatingCompletions || []) {
      await db
        .prepare(
          `INSERT INTO legacy_rating_completions
           (invite_id, match_id, imported_at_ms) VALUES (?, ?, 1)`,
        )
        .bind(completion.inviteId, completion.matchId)
        .run();
    }
    await db
      .prepare(
        `UPDATE rating_completion_control SET activated_at_ms = 1
       WHERE singleton = 1 AND activated_at_ms IS NULL`,
      )
      .run();
  }
  if (finalizationIndex >= 0) {
    await db.batch([
      db.prepare(
        `UPDATE wager_reservation_runtime_control
         SET storage_mode = 'frozen', previous_storage_mode = 'firebase',
             freeze_generation = 1 WHERE singleton = 1`,
      ),
      db.prepare(
        `UPDATE wager_reservation_runtime_control
         SET import_attempt_id = 'schema-test', import_started_at_ms = 1000000
         WHERE singleton = 1`,
      ),
      db
        .prepare(
          `UPDATE wager_reservation_runtime_control
           SET verified_import_generation = 1, import_attempt_id = NULL,
               import_started_at_ms = NULL, source_digest = ?,
               source_balance_count = 0, source_operation_count = 0,
               source_first_exported_at_ms = 1000000,
               source_exported_at_ms = 2000000, queues_paused_at_ms = 1000000,
               bridge_deployed_at_ms = 900000, bridge_version_id = 'schema-test'
           WHERE singleton = 1`,
        )
        .bind(importDigest),
      db.prepare(
        `UPDATE wager_reservation_runtime_control
         SET storage_mode = 'd1', previous_storage_mode = NULL,
             activated_at_ms = 2000000 WHERE singleton = 1`,
      ),
      db.prepare(
        `UPDATE wager_reservation_runtime_control
         SET storage_mode = 'frozen', previous_storage_mode = 'd1',
             freeze_generation = 2, verified_import_generation = NULL
         WHERE singleton = 1`,
      ),
      db
        .prepare(
          `UPDATE profile_link_catchup_import
           SET activated_at_ms = 1, verified_at_ms = 1, job_count = 0,
               source_digest = ?, import_digest = ?, owners_digest = ?,
               activated_version_id = 'schema-test'
           WHERE singleton = 1`,
        )
        .bind(importDigest, importDigest, importDigest),
    ]);
    await applyD1Migrations(db, migrations.slice(finalizationIndex));
    await db
      .prepare(
        `UPDATE wager_reservation_runtime_control
         SET storage_mode = 'd1' WHERE singleton = 1`,
      )
      .run();
  }
  await db
    .prepare(
      `UPDATE profile_canonical_control
       SET state = 'active'
       WHERE singleton = 1 AND state = 'frozen'`,
    )
    .run();
}
