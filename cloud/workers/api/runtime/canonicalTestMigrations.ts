import { applyD1Migrations, type D1Migration } from "cloudflare:test";

const CLEANUP_SUFFIX = "_retire_canonical_source_tables.sql";
export const TIMER_RETIREMENT_MIGRATION =
  "0039_retire_canonical_timer_starts.sql";

export function preTimerRetirementTestMigrations(
  migrations: D1Migration[],
): D1Migration[] {
  const index = migrations.findIndex(
    ({ name }) => name === TIMER_RETIREMENT_MIGRATION,
  );
  return index < 0 ? migrations : migrations.slice(0, index);
}

async function activateTimerRetirementTestAuthority(
  db: D1Database,
): Promise<void> {
  const control = await db
    .prepare(
      "SELECT backend,state,epoch FROM match_state_control WHERE singleton = 1",
    )
    .first<{ backend: string; state: string; epoch: number }>();
  if (
    control?.backend === "durable" &&
    control.state === "active" &&
    control.epoch > 0
  )
    return;
  if (
    control?.backend !== "rtdb" ||
    control.state !== "active" ||
    control.epoch !== 1
  )
    throw new Error("timer-retirement-test-authority-conflict");
  await db
    .prepare(
      `UPDATE match_state_control SET backend = 'durable', state = 'active', epoch = 2,
    candidate_version_id = '11111111-1111-4111-8111-111111111111',
    import_id = '22222222-2222-4222-8222-222222222222',
    source_digest = ?, verified_digest = ?, fence_digest = ?,
    source_record_count = 0, source_claim_count = 0, source_bundle_count = 0,
    verified_at_ms = 1, activated_at_ms = 1 WHERE singleton = 1 AND backend = 'rtdb' AND epoch = 1`,
    )
    .bind("a".repeat(64), "a".repeat(64), "b".repeat(64))
    .run();
}

export function preCleanupTestMigrations(
  migrations: D1Migration[],
): D1Migration[] {
  const index = migrations.findIndex(({ name }) =>
    name.endsWith(CLEANUP_SUFFIX),
  );
  return index < 0 ? migrations : migrations.slice(0, index);
}

export async function applyPreCleanupTestMigrations(
  db: D1Database,
  migrations: D1Migration[],
): Promise<void> {
  await applyD1Migrations(db, preCleanupTestMigrations(migrations));
}

export async function activateCanonicalTestControl(
  db: D1Database,
): Promise<void> {
  const row = await db
    .prepare(
      "SELECT generation, data_epoch, phase FROM application_data_control WHERE singleton = 1",
    )
    .first<{ generation: number; data_epoch: number; phase: string }>();
  if (
    !row ||
    row.phase !== "active" ||
    (row.generation !== 1 && row.generation !== 3) ||
    (row.data_epoch !== 0 && row.data_epoch !== 1) ||
    (row.generation === 3 && row.data_epoch !== 1)
  )
    throw new Error("canonical-test-control-conflict");
  if (row.generation === 3) return;
  const result = await db
    .prepare(
      "UPDATE application_data_control SET generation = 3, data_epoch = 1 WHERE singleton = 1 AND generation = 1 AND data_epoch = ? AND phase = 'active'",
    )
    .bind(row.data_epoch)
    .run();
  if (result.meta.changes !== 1)
    throw new Error("canonical-test-control-conflict");
}

export async function applyCanonicalCleanupTestMigrations(
  db: D1Database,
  migrations: D1Migration[],
): Promise<void> {
  const index = migrations.findIndex(({ name }) =>
    name.endsWith(CLEANUP_SUFFIX),
  );
  if (index < 0) return;
  await activateCanonicalTestControl(db);
  if (migrations.some(({ name }) => name === TIMER_RETIREMENT_MIGRATION)) {
    const applied = await db
      .prepare("SELECT name FROM d1_migrations WHERE name = ?")
      .bind(TIMER_RETIREMENT_MIGRATION)
      .first();
    if (!applied) await activateTimerRetirementTestAuthority(db);
  }
  await applyD1Migrations(db, migrations.slice(index));
}

export async function applyCanonicalTestMigrations(
  db: D1Database,
  migrations: D1Migration[],
): Promise<void> {
  await applyPreCleanupTestMigrations(db, migrations);
  await applyCanonicalCleanupTestMigrations(db, migrations);
}
