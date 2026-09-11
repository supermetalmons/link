import { applyD1Migrations, type D1Migration } from "cloudflare:test";

export async function applyStrictMatchStateTestMigrations(
  db: D1Database,
  migrations: D1Migration[],
): Promise<void> {
  await applyD1Migrations(db, migrations);
  await db
    .prepare(
      `UPDATE match_state_control SET backend = 'durable', state = 'active', epoch = 2,
       candidate_version_id = '11111111-1111-4111-8111-111111111111',
       import_id = '22222222-2222-4222-8222-222222222222',
       source_digest = ?, verified_digest = ?, fence_digest = ?,
       source_record_count = 0, source_claim_count = 0, source_bundle_count = 0,
       verified_at_ms = 1, activated_at_ms = 1 WHERE singleton = 1`,
    )
    .bind("a".repeat(64), "a".repeat(64), "b".repeat(64))
    .run();
}
