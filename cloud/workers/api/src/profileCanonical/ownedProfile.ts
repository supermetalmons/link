import { parseCanonicalLoginOwnerRow } from "./auth.ts";
import { parseCanonicalProfileRow } from "./profiles.ts";
import {
  CanonicalProfileCorruption,
  type CanonicalLoginOwnerSnapshot,
  type CanonicalProfileSnapshot,
} from "./types.ts";

export type CanonicalOwnedProfileSnapshot<Profile = CanonicalProfileSnapshot> =
  {
    owner: CanonicalLoginOwnerSnapshot;
    profile: Profile;
  };

const CANONICAL_OWNER_COLUMNS = `owner.login_uid AS canonical_owner_login_uid,
  owner.profile_id AS canonical_owner_profile_id,
  owner.revision AS canonical_owner_revision,
  owner.created_at_ms AS canonical_owner_created_at_ms,
  owner.updated_at_ms AS canonical_owner_updated_at_ms,
  mapping.source_profile_id AS canonical_merge_source_profile_id`;

export const CANONICAL_OWNED_PROFILE_COLUMNS = `profile.*,
  ${CANONICAL_OWNER_COLUMNS}`;

export const CANONICAL_OWNED_PROFILE_FROM = `FROM profile_login_owners_canonical AS owner
  LEFT JOIN profile_records_canonical AS profile
    ON profile.profile_id = owner.profile_id
  LEFT JOIN profile_merge_targets_canonical AS mapping
    ON mapping.source_profile_id = owner.profile_id`;

export function prepareCanonicalOwnedProfileRead(
  db: D1Database,
  loginUid: string,
  profileColumns = "profile.*",
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ${profileColumns},
  ${CANONICAL_OWNER_COLUMNS}
       ${CANONICAL_OWNED_PROFILE_FROM}
       WHERE owner.login_uid = ?`,
    )
    .bind(loginUid);
}

export function parseCanonicalOwnedProfileRow(
  row: Record<string, unknown> | null | undefined,
  loginUid: string,
): CanonicalOwnedProfileSnapshot | null {
  return parseCanonicalOwnedProfileRowWith(
    row,
    loginUid,
    parseCanonicalProfileRow,
  );
}

export function parseCanonicalOwnedProfileRowWith<
  Profile extends Pick<CanonicalProfileSnapshot, "profileId" | "state">,
>(
  row: Record<string, unknown> | null | undefined,
  loginUid: string,
  parseProfile: (value: unknown) => Profile,
): CanonicalOwnedProfileSnapshot<Profile> | null {
  if (!row) return null;
  const owner = parseCanonicalLoginOwnerRow({
    login_uid: row.canonical_owner_login_uid,
    profile_id: row.canonical_owner_profile_id,
    revision: row.canonical_owner_revision,
    created_at_ms: row.canonical_owner_created_at_ms,
    updated_at_ms: row.canonical_owner_updated_at_ms,
  });
  const profile = parseProfile(row);
  if (
    owner.loginUid !== loginUid ||
    owner.profileId !== profile.profileId ||
    profile.state !== "active" ||
    row.canonical_merge_source_profile_id !== null
  ) {
    throw new CanonicalProfileCorruption();
  }
  return { owner, profile };
}
