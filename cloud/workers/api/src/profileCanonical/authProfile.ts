import { parseCanonicalAuthMethodRow } from "./auth.ts";
import {
  CanonicalProfileCorruption,
  type CanonicalAuthMethodSnapshot,
} from "./types.ts";
import {
  CANONICAL_OWNED_PROFILE_COLUMNS,
  CANONICAL_OWNED_PROFILE_FROM,
  parseCanonicalOwnedProfileRow,
  type CanonicalOwnedProfileSnapshot,
} from "./ownedProfile.ts";

export type CanonicalAuthProfileSnapshot = CanonicalOwnedProfileSnapshot & {
  authMethods: CanonicalAuthMethodSnapshot[];
};

export async function readCanonicalAuthProfileByLogin(
  db: D1Database,
  loginUid: string,
): Promise<CanonicalAuthProfileSnapshot | null> {
  const { results } = await db
    .prepare(
      `SELECT ${CANONICAL_OWNED_PROFILE_COLUMNS},
              method.method AS auth_method_method,
              method.normalized_value AS auth_method_normalized_value,
              method.profile_id AS auth_method_profile_id,
              method.raw_value AS auth_method_raw_value,
              method.apple_email_masked AS auth_method_apple_email_masked,
              method.x_username AS auth_method_x_username,
              method.linked_at_ms AS auth_method_linked_at_ms,
              method.consent_at_ms AS auth_method_consent_at_ms,
              method.consent_source AS auth_method_consent_source,
              method.revision AS auth_method_revision,
              method.created_at_ms AS auth_method_created_at_ms,
              method.updated_at_ms AS auth_method_updated_at_ms
       ${CANONICAL_OWNED_PROFILE_FROM}
       LEFT JOIN profile_auth_methods AS method
         ON method.profile_id = owner.profile_id
       WHERE owner.login_uid = ?
       ORDER BY method.method ASC`,
    )
    .bind(loginUid)
    .all<Record<string, unknown>>();
  const snapshot = parseCanonicalOwnedProfileRow(results[0], loginUid);
  if (!snapshot) return null;
  const { profile } = snapshot;
  const authMethods: CanonicalAuthMethodSnapshot[] = [];
  for (const methodRow of results) {
    const value = {
      method: methodRow.auth_method_method,
      normalized_value: methodRow.auth_method_normalized_value,
      profile_id: methodRow.auth_method_profile_id,
      raw_value: methodRow.auth_method_raw_value,
      apple_email_masked: methodRow.auth_method_apple_email_masked,
      x_username: methodRow.auth_method_x_username,
      linked_at_ms: methodRow.auth_method_linked_at_ms,
      consent_at_ms: methodRow.auth_method_consent_at_ms,
      consent_source: methodRow.auth_method_consent_source,
      revision: methodRow.auth_method_revision,
      created_at_ms: methodRow.auth_method_created_at_ms,
      updated_at_ms: methodRow.auth_method_updated_at_ms,
    };
    if (Object.values(value).every((field) => field === null)) continue;
    const method = parseCanonicalAuthMethodRow(value);
    if (method.profileId !== profile.profileId) {
      throw new CanonicalProfileCorruption();
    }
    authMethods.push(method);
  }
  return {
    ...snapshot,
    authMethods,
  };
}
