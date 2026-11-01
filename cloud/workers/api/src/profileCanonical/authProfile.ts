import { parseCanonicalAuthMethodRow } from "./auth.ts";
import {
  CanonicalProfileCorruption,
  type CanonicalAuthMethodSnapshot,
  type CanonicalProfileFieldsSnapshot,
  type CanonicalProfileSnapshot,
} from "./types.ts";
import {
  prepareCanonicalOwnedProfileRead,
  parseCanonicalOwnedProfileRowWith,
  type CanonicalOwnedProfileSnapshot,
} from "./ownedProfile.ts";
import { parseCanonicalProfileRow } from "./profiles.ts";
import {
  mutableProfileColumns,
  parseMutableProfileRow,
} from "./mutableProfiles.ts";

export type CanonicalAuthProfileSnapshot = CanonicalOwnedProfileSnapshot & {
  authMethods: CanonicalAuthMethodSnapshot[];
};

export type CanonicalAuthReadSnapshot =
  CanonicalOwnedProfileSnapshot<CanonicalProfileFieldsSnapshot> & {
    authMethods: CanonicalAuthMethodSnapshot[];
  };

function parseAuthReadProfileRow(
  value: unknown,
): CanonicalProfileFieldsSnapshot {
  return parseMutableProfileRow(value);
}

export function readCanonicalAuthProfileByLogin(
  db: D1Database,
  loginUid: string,
): Promise<CanonicalAuthProfileSnapshot | null> {
  return readCanonicalAuthSnapshot(
    db,
    loginUid,
    "profile.*",
    parseCanonicalProfileRow,
  );
}

export function readCanonicalAuthReadSnapshotByLogin(
  db: D1Database,
  loginUid: string,
): Promise<CanonicalAuthReadSnapshot | null> {
  return readCanonicalAuthSnapshot(
    db,
    loginUid,
    mutableProfileColumns("profile"),
    parseAuthReadProfileRow,
  );
}

async function readCanonicalAuthSnapshot<
  Profile extends Pick<CanonicalProfileSnapshot, "profileId" | "state">,
>(
  db: D1Database,
  loginUid: string,
  profileColumns: string,
  parseProfile: (value: unknown) => Profile,
): Promise<
  | (CanonicalOwnedProfileSnapshot<Profile> & {
      authMethods: CanonicalAuthMethodSnapshot[];
    })
  | null
> {
  const results = await db.batch<Record<string, unknown>>([
    prepareCanonicalOwnedProfileRead(db, loginUid, profileColumns),
    db
      .prepare(
        `SELECT method.method, method.normalized_value, method.profile_id,
              method.raw_value, method.apple_email_masked, method.x_username,
              method.linked_at_ms, method.consent_at_ms, method.consent_source,
              method.revision, method.created_at_ms, method.updated_at_ms
       FROM profile_auth_methods_canonical AS method
       JOIN profile_login_owners_canonical AS owner
         ON method.profile_id = owner.profile_id
       WHERE owner.login_uid = ?
       ORDER BY method.method ASC`,
      )
      .bind(loginUid),
  ]);
  if (
    results.length !== 2 ||
    results.some(
      (result) => !result?.success || !Array.isArray(result.results),
    ) ||
    results[0]!.results.length > 1
  ) {
    throw new CanonicalProfileCorruption();
  }
  const snapshot = parseCanonicalOwnedProfileRowWith(
    results[0]!.results[0],
    loginUid,
    parseProfile,
  );
  if (!snapshot) {
    if (results[1]!.results.length !== 0)
      throw new CanonicalProfileCorruption();
    return null;
  }
  const { profile } = snapshot;
  const authMethods: CanonicalAuthMethodSnapshot[] = [];
  for (const methodRow of results[1]!.results) {
    const method = parseCanonicalAuthMethodRow(methodRow);
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
