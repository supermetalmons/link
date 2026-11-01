export async function seedProfileArchiveFixture(
  db: D1Database,
  profileId: string,
  value: Record<string, unknown>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO profile_records (
    profile_id, state, payload_json, legacy_fields_json, created_at_ms, updated_at_ms,
    rating_sort_present, mana_points_sort_present, nonce_sort_present,
    dust_sort_present, slime_sort_present, gum_sort_present, metal_sort_present, ice_sort_present,
    win_present, emoji_present
  ) VALUES (?, 'active', '{}', ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
  ON CONFLICT(profile_id) DO UPDATE SET legacy_fields_json = excluded.legacy_fields_json`,
    )
    .bind(profileId, JSON.stringify(value))
    .run();
}

export async function readProfileArchiveFixture(
  db: D1Database,
  profileId: string,
): Promise<string | null> {
  return db
    .prepare(
      "SELECT legacy_fields_json FROM profile_records WHERE profile_id = ?",
    )
    .bind(profileId)
    .first<string>("legacy_fields_json");
}
