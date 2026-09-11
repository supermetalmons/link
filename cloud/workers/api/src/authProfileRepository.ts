import {
  getLinkedAuthMethodsFromProfile,
  type LinkedAuthMethodsResponse,
} from "@mons/shared/auth";
import {
  CanonicalProfileCorruption,
  parseCanonicalAuthMethodRow,
  parseCanonicalLoginOwnerRow,
  parseCanonicalProfileRow,
  type CanonicalAuthMethodSnapshot,
} from "./profileCanonicalD1.ts";

export type AuthProfileRepository = {
  getLinkedAuthMethods: (uid: string) => Promise<LinkedAuthMethodsResponse>;
};

export class AuthProfileRepositoryFailure extends Error {
  constructor() {
    super("profile-repository-unavailable");
  }
}

async function readAuthProfileSnapshot(
  db: D1Database,
  loginUid: string,
): Promise<{
  profileId: string;
  authMethods: CanonicalAuthMethodSnapshot[];
} | null> {
  const { results } = await db
    .prepare(
      `SELECT profile.*,
              owner.login_uid AS auth_owner_login_uid,
              owner.profile_id AS auth_owner_profile_id,
              owner.revision AS auth_owner_revision,
              owner.created_at_ms AS auth_owner_created_at_ms,
              owner.updated_at_ms AS auth_owner_updated_at_ms,
              mapping.source_profile_id AS auth_merge_source_profile_id,
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
       FROM profile_login_owners AS owner
       LEFT JOIN profile_records AS profile
         ON profile.profile_id = owner.profile_id
       LEFT JOIN profile_merge_targets AS mapping
         ON mapping.source_profile_id = owner.profile_id
       LEFT JOIN profile_auth_methods AS method
         ON method.profile_id = owner.profile_id
       WHERE owner.login_uid = ?
       ORDER BY method.method ASC`,
    )
    .bind(loginUid)
    .all<Record<string, unknown>>();
  const row = results[0];
  if (!row) return null;
  const owner = parseCanonicalLoginOwnerRow({
    login_uid: row.auth_owner_login_uid,
    profile_id: row.auth_owner_profile_id,
    revision: row.auth_owner_revision,
    created_at_ms: row.auth_owner_created_at_ms,
    updated_at_ms: row.auth_owner_updated_at_ms,
  });
  const profile = parseCanonicalProfileRow(row);
  if (
    owner.loginUid !== loginUid ||
    owner.profileId !== profile.profileId ||
    profile.state !== "active" ||
    row.auth_merge_source_profile_id !== null
  ) {
    throw new CanonicalProfileCorruption();
  }
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
  return { profileId: profile.profileId, authMethods };
}

function createCanonicalAuthProfileRepository(
  db: D1Database,
): AuthProfileRepository {
  const linkedMethodsResponse = async (
    uid: string,
  ): Promise<LinkedAuthMethodsResponse> => {
    const resolved = await readAuthProfileSnapshot(db, uid);
    if (!resolved) {
      const linkedMethods = {
        apple: false,
        eth: false,
        sol: false,
        x: false,
      };
      return {
        ok: true,
        profileId: null,
        linkedMethods,
        appleLinked: false,
      };
    }
    const methodValues = Object.fromEntries(
      resolved.authMethods.map((method) => [method.method, method.rawValue]),
    );
    const linkedMethods = getLinkedAuthMethodsFromProfile({
      appleSub: methodValues.apple,
      eth: methodValues.eth,
      sol: methodValues.sol,
      xUserId: methodValues.x,
    });
    return {
      ok: true,
      profileId: resolved.profileId,
      linkedMethods,
      appleLinked: linkedMethods.apple,
    };
  };
  return {
    getLinkedAuthMethods: (uid) => linkedMethodsResponse(uid),
  };
}

export function createAuthProfileRepository(
  env: Env,
  dependencies: { d1?: D1Database } = {},
): AuthProfileRepository {
  return createCanonicalAuthProfileRepository(
    dependencies.d1 || env.PROFILE_DB,
  );
}
