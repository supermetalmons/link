import {
  CanonicalProfileCorruption,
  parseCanonicalLoginOwnerRow,
  parseCanonicalProfileRow,
  type CanonicalLoginOwnerSnapshot,
  type CanonicalProfileSnapshot,
} from "./profileCanonicalD1.ts";

export type CanonicalProfileMutationSnapshot = {
  owner: CanonicalLoginOwnerSnapshot;
  profile: CanonicalProfileSnapshot;
};

export async function readCanonicalProfileMutationByLogin(
  db: D1Database,
  loginUid: string,
): Promise<CanonicalProfileMutationSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT profile.*,
              owner.login_uid AS mutation_owner_login_uid,
              owner.profile_id AS mutation_owner_profile_id,
              owner.revision AS mutation_owner_revision,
              owner.created_at_ms AS mutation_owner_created_at_ms,
              owner.updated_at_ms AS mutation_owner_updated_at_ms,
              mapping.source_profile_id AS mutation_merge_source_profile_id
       FROM profile_login_owners AS owner
       LEFT JOIN profile_records AS profile
         ON profile.profile_id = owner.profile_id
       LEFT JOIN profile_merge_targets AS mapping
         ON mapping.source_profile_id = owner.profile_id
       WHERE owner.login_uid = ?`,
    )
    .bind(loginUid)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const owner = parseCanonicalLoginOwnerRow({
    login_uid: row.mutation_owner_login_uid,
    profile_id: row.mutation_owner_profile_id,
    revision: row.mutation_owner_revision,
    created_at_ms: row.mutation_owner_created_at_ms,
    updated_at_ms: row.mutation_owner_updated_at_ms,
  });
  const profile = parseCanonicalProfileRow(row);
  if (
    owner.loginUid !== loginUid ||
    owner.profileId !== profile.profileId ||
    profile.state !== "active" ||
    row.mutation_merge_source_profile_id !== null
  ) {
    throw new CanonicalProfileCorruption();
  }
  return { owner, profile };
}
