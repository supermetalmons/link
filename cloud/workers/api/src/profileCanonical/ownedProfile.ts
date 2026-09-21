import { parseCanonicalLoginOwnerRow } from "./auth.ts";
import { parseCanonicalProfileRow } from "./profiles.ts";
import {
  CanonicalProfileCorruption,
  type CanonicalLoginOwnerSnapshot,
  type CanonicalProfileSnapshot,
} from "./types.ts";

export type CanonicalOwnedProfileSnapshot = {
  owner: CanonicalLoginOwnerSnapshot;
  profile: CanonicalProfileSnapshot;
};

export const CANONICAL_OWNED_PROFILE_COLUMNS = `profile.*,
  owner.login_uid AS canonical_owner_login_uid,
  owner.profile_id AS canonical_owner_profile_id,
  owner.revision AS canonical_owner_revision,
  owner.created_at_ms AS canonical_owner_created_at_ms,
  owner.updated_at_ms AS canonical_owner_updated_at_ms,
  mapping.source_profile_id AS canonical_merge_source_profile_id`;

export const CANONICAL_OWNED_PROFILE_FROM = `FROM profile_login_owners AS owner
  LEFT JOIN profile_records AS profile
    ON profile.profile_id = owner.profile_id
  LEFT JOIN profile_merge_targets AS mapping
    ON mapping.source_profile_id = owner.profile_id`;

export function parseCanonicalOwnedProfileRow(
  row: Record<string, unknown> | null | undefined,
  loginUid: string,
): CanonicalOwnedProfileSnapshot | null {
  if (!row) return null;
  const owner = parseCanonicalLoginOwnerRow({
    login_uid: row.canonical_owner_login_uid,
    profile_id: row.canonical_owner_profile_id,
    revision: row.canonical_owner_revision,
    created_at_ms: row.canonical_owner_created_at_ms,
    updated_at_ms: row.canonical_owner_updated_at_ms,
  });
  const profile = parseCanonicalProfileRow(row);
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
