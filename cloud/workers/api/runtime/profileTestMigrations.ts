import { applyD1Migrations, type D1Migration } from "cloudflare:test";

const RETIREMENT_MIGRATION = "0009_retire_legacy_profile_projection.sql";

export async function applyRetiredProfileMigrations(
  db: D1Database,
  migrations: D1Migration[],
  importDigest: string,
  options: { activateRatingCompletions?: boolean } = {},
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
  await applyD1Migrations(db, migrations.slice(retirementIndex));
  if (
    options.activateRatingCompletions !== false &&
    migrations.some(
      (migration) => migration.name === "0013_rating_completions.sql",
    )
  ) {
    await db
      .prepare(
        `UPDATE rating_completion_control
       SET source_digest = ?, source_count = 0
       WHERE singleton = 1 AND activated_at_ms IS NULL`,
      )
      .bind(importDigest)
      .run();
    await db
      .prepare(
        `UPDATE rating_completion_control SET activated_at_ms = 1
       WHERE singleton = 1 AND activated_at_ms IS NULL`,
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
