import {
  isPlayerProfile,
  type CompletePlayerProfile,
  type LeaderboardReadType,
} from "@mons/shared/profiles";
import {
  createProfileProjectionFailureLoginMetadata,
  PROFILE_PROJECTION_SCHEMA_VERSION,
  profileWithoutTutorialState,
  type FirestoreUpdateVersion,
  type ProfileProjection,
} from "./profileProjectionModel.ts";
import {
  LEADERBOARD_ENTRY_LIMIT,
  PROFILE_MERGE_REDIRECT_LIMIT,
  ProfileRepositoryFailure,
  type ProfileRepository,
} from "./profileRepository.ts";

type ProfileRow = {
  merged_into_profile_id: string | null;
  payload_json: string;
  profile_id: string;
};

type ProfileReconciliationRow = {
  is_deleted: number | null;
  is_failure: number;
  login_uids_complete: number | null;
  login_uids_source_nanos: number | null;
  login_uids_source_seconds: number | null;
  profile_id: string;
  projection_schema_source_nanos: number;
  projection_schema_source_seconds: number;
  projection_schema_version: number;
  source_update_nanos: number;
  source_update_seconds: number;
};

export type ProfileReconciliationState = {
  failureLoginUidsComplete: boolean | null;
  failureLoginUidsSourceVersion: FirestoreUpdateVersion | null;
  failureSchemaSourceVersion: FirestoreUpdateVersion | null;
  failureSchemaVersion: number | null;
  failureVersion: FirestoreUpdateVersion | null;
  profile: {
    isDeleted: boolean;
    schemaSourceVersion: FirestoreUpdateVersion;
    schemaVersion: number;
    sourceVersion: FirestoreUpdateVersion;
  } | null;
};

const UPSERT_PROFILE_SQL = `
  INSERT INTO profiles (
    profile_id,
    payload_json,
    merged_into_profile_id,
    rating_sort,
    mana_points_sort,
    dust_sort,
    slime_sort,
    gum_sort,
    metal_sort,
    ice_sort,
    rating_sort_present,
    mana_points_sort_present,
    dust_sort_present,
    slime_sort_present,
    gum_sort_present,
    metal_sort_present,
    ice_sort_present,
    source_update_seconds,
    source_update_nanos,
    source_digest,
    projected_at_ms,
    is_deleted,
    projection_schema_version,
    projection_schema_source_seconds,
    projection_schema_source_nanos
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  ON CONFLICT (profile_id) DO UPDATE SET
    payload_json = excluded.payload_json,
    merged_into_profile_id = excluded.merged_into_profile_id,
    rating_sort = excluded.rating_sort,
    mana_points_sort = excluded.mana_points_sort,
    dust_sort = excluded.dust_sort,
    slime_sort = excluded.slime_sort,
    gum_sort = excluded.gum_sort,
    metal_sort = excluded.metal_sort,
    ice_sort = excluded.ice_sort,
    rating_sort_present = excluded.rating_sort_present,
    mana_points_sort_present = excluded.mana_points_sort_present,
    dust_sort_present = excluded.dust_sort_present,
    slime_sort_present = excluded.slime_sort_present,
    gum_sort_present = excluded.gum_sort_present,
    metal_sort_present = excluded.metal_sort_present,
    ice_sort_present = excluded.ice_sort_present,
    source_update_seconds = excluded.source_update_seconds,
    source_update_nanos = excluded.source_update_nanos,
    source_digest = excluded.source_digest,
    projected_at_ms = excluded.projected_at_ms,
    is_deleted = 0,
    projection_schema_version = excluded.projection_schema_version,
    projection_schema_source_seconds = excluded.projection_schema_source_seconds,
    projection_schema_source_nanos = excluded.projection_schema_source_nanos
  WHERE excluded.source_update_seconds > profiles.source_update_seconds
    OR (
      excluded.source_update_seconds = profiles.source_update_seconds
      AND excluded.source_update_nanos > profiles.source_update_nanos
    )
    OR (
      excluded.source_update_seconds = profiles.source_update_seconds
      AND excluded.source_update_nanos = profiles.source_update_nanos
      AND profiles.is_deleted = 0
      AND excluded.projection_schema_version >= profiles.projection_schema_version
    )
`;

const DELETE_MATCHING_TOMBSTONE_SQL = `
  DELETE FROM profiles
  WHERE profile_id = ?
    AND source_update_seconds = ?
    AND source_update_nanos = ?
    AND is_deleted = 1
    AND projection_schema_version <= ?
`;

const DELETE_PROFILE_SQL = `
  INSERT INTO profiles (
    profile_id,
    payload_json,
    merged_into_profile_id,
    rating_sort,
    mana_points_sort,
    dust_sort,
    slime_sort,
    gum_sort,
    metal_sort,
    ice_sort,
    rating_sort_present,
    mana_points_sort_present,
    dust_sort_present,
    slime_sort_present,
    gum_sort_present,
    metal_sort_present,
    ice_sort_present,
    source_update_seconds,
    source_update_nanos,
    source_digest,
    projected_at_ms,
    is_deleted,
    projection_schema_version,
    projection_schema_source_seconds,
    projection_schema_source_nanos
  ) VALUES (?, '{}', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, 0, 0, 0, 0, ?, ?, ?, ?, 1, ?, ?, ?)
  ON CONFLICT (profile_id) DO UPDATE SET
    payload_json = '{}',
    merged_into_profile_id = NULL,
    rating_sort = NULL,
    mana_points_sort = NULL,
    dust_sort = NULL,
    slime_sort = NULL,
    gum_sort = NULL,
    metal_sort = NULL,
    ice_sort = NULL,
    rating_sort_present = 0,
    mana_points_sort_present = 0,
    dust_sort_present = 0,
    slime_sort_present = 0,
    gum_sort_present = 0,
    metal_sort_present = 0,
    ice_sort_present = 0,
    source_update_seconds = excluded.source_update_seconds,
    source_update_nanos = excluded.source_update_nanos,
    source_digest = excluded.source_digest,
    projected_at_ms = excluded.projected_at_ms,
    is_deleted = 1,
    projection_schema_version = excluded.projection_schema_version,
    projection_schema_source_seconds = excluded.projection_schema_source_seconds,
    projection_schema_source_nanos = excluded.projection_schema_source_nanos
  WHERE ? = 1
    AND profiles.source_update_seconds = ?
    AND profiles.source_update_nanos = ?
`;

const CURRENT_ACTIVE_PROJECTION_SQL = `
  EXISTS (
    SELECT 1
    FROM profiles
    WHERE profile_id = ?
      AND source_update_seconds = ?
      AND source_update_nanos = ?
      AND is_deleted = 0
      AND projection_schema_version = ?
      AND projection_schema_source_seconds = ?
      AND projection_schema_source_nanos = ?
  )
`;

const CURRENT_DELETED_SOURCE_SQL = `
  EXISTS (
    SELECT 1
    FROM profiles
    WHERE profile_id = ?
      AND source_update_seconds = ?
      AND source_update_nanos = ?
      AND is_deleted = 1
  )
`;

const CLEAR_PROJECTION_FAILURE_SQL = `
  DELETE FROM profile_projection_failures
  WHERE profile_id = ?
    AND (
      source_update_seconds < ?
      OR (
      source_update_seconds = ?
        AND (
          source_update_nanos < ?
          OR (
            source_update_nanos = ?
            AND projection_schema_version <= ?
          )
        )
      )
    )
`;

const CLEAR_PROJECTION_FAILURE_AFTER_DELETION_SQL = `
  ${CLEAR_PROJECTION_FAILURE_SQL}
    AND ${CURRENT_DELETED_SOURCE_SQL}
`;

const UPSERT_PROJECTION_FAILURE_SQL = `
  INSERT INTO profile_projection_failures (
    profile_id,
    source_update_seconds,
    source_update_nanos,
    recorded_at_ms,
    login_uids_json,
    login_uids_source_seconds,
    login_uids_source_nanos,
    login_uids_complete,
    projection_schema_version,
    projection_schema_source_seconds,
    projection_schema_source_nanos
  )
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE NOT EXISTS (
    SELECT 1
    FROM profiles
    WHERE profile_id = ?
      AND (
        source_update_seconds > ?
        OR (
          source_update_seconds = ?
          AND (
            source_update_nanos > ?
            OR (
              source_update_nanos = ?
              AND (
                is_deleted = 1
                OR projection_schema_version > ?
              )
            )
          )
        )
      )
  )
  ON CONFLICT (profile_id) DO UPDATE SET
    source_update_seconds = excluded.source_update_seconds,
    source_update_nanos = excluded.source_update_nanos,
    recorded_at_ms = excluded.recorded_at_ms,
    login_uids_json = excluded.login_uids_json,
    login_uids_source_seconds = excluded.login_uids_source_seconds,
    login_uids_source_nanos = excluded.login_uids_source_nanos,
    login_uids_complete = excluded.login_uids_complete,
    projection_schema_version = excluded.projection_schema_version,
    projection_schema_source_seconds = excluded.projection_schema_source_seconds,
    projection_schema_source_nanos = excluded.projection_schema_source_nanos
  WHERE (
      excluded.source_update_seconds > profile_projection_failures.source_update_seconds
      OR (
        excluded.source_update_seconds = profile_projection_failures.source_update_seconds
        AND (
          excluded.source_update_nanos > profile_projection_failures.source_update_nanos
          OR (
            excluded.source_update_nanos = profile_projection_failures.source_update_nanos
            AND (
              excluded.projection_schema_version > profile_projection_failures.projection_schema_version
              OR (
                excluded.projection_schema_version = profile_projection_failures.projection_schema_version
                AND (
                  (
                    excluded.projection_schema_source_seconds = excluded.source_update_seconds
                    AND excluded.projection_schema_source_nanos = excluded.source_update_nanos
                    AND (
                      profile_projection_failures.projection_schema_source_seconds != profile_projection_failures.source_update_seconds
                      OR profile_projection_failures.projection_schema_source_nanos != profile_projection_failures.source_update_nanos
                    )
                  )
                  OR (
                    excluded.login_uids_source_seconds = excluded.source_update_seconds
                    AND excluded.login_uids_source_nanos = excluded.source_update_nanos
                    AND (
                      profile_projection_failures.login_uids_source_seconds != profile_projection_failures.source_update_seconds
                      OR profile_projection_failures.login_uids_source_nanos != profile_projection_failures.source_update_nanos
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM profiles
      WHERE profile_id = excluded.profile_id
        AND (
          source_update_seconds > excluded.source_update_seconds
          OR (
            source_update_seconds = excluded.source_update_seconds
            AND (
              source_update_nanos > excluded.source_update_nanos
              OR (
                source_update_nanos = excluded.source_update_nanos
                AND (
                  is_deleted = 1
                  OR projection_schema_version > excluded.projection_schema_version
                )
              )
            )
          )
        )
    )
`;

function clearProjectionFailure(
  db: D1Database,
  profileId: string,
  sourceVersion: FirestoreUpdateVersion,
): D1PreparedStatement {
  return db
    .prepare(CLEAR_PROJECTION_FAILURE_SQL)
    .bind(
      profileId,
      sourceVersion.seconds,
      sourceVersion.seconds,
      sourceVersion.nanos,
      sourceVersion.nanos,
      PROFILE_PROJECTION_SCHEMA_VERSION,
    );
}

function clearProjectionFailureAfterDeletion(
  db: D1Database,
  profileId: string,
  sourceVersion: FirestoreUpdateVersion,
): D1PreparedStatement {
  return db
    .prepare(CLEAR_PROJECTION_FAILURE_AFTER_DELETION_SQL)
    .bind(
      profileId,
      sourceVersion.seconds,
      sourceVersion.seconds,
      sourceVersion.nanos,
      sourceVersion.nanos,
      PROFILE_PROJECTION_SCHEMA_VERSION,
      profileId,
      sourceVersion.seconds,
      sourceVersion.nanos,
    );
}

function parseProfile(row: ProfileRow): CompletePlayerProfile {
  let value: unknown;
  try {
    value = JSON.parse(row.payload_json) as unknown;
  } catch {
    throw new ProfileRepositoryFailure();
  }
  if (!isPlayerProfile(value) || value.id !== row.profile_id) {
    throw new ProfileRepositoryFailure();
  }
  return value;
}

export async function commitProfileProjection(
  db: D1Database,
  projection: ProfileProjection,
  projectedAtMs: number,
): Promise<void> {
  if (
    projection.schemaVersion !== PROFILE_PROJECTION_SCHEMA_VERSION ||
    !Number.isSafeInteger(projectedAtMs) ||
    projectedAtMs <= 0
  ) {
    throw new TypeError("invalid-profile-projected-at");
  }
  const version = [
    projection.profile.id,
    projection.sourceVersion.seconds,
    projection.sourceVersion.nanos,
    projection.schemaVersion,
    projection.sourceVersion.seconds,
    projection.sourceVersion.nanos,
  ] as const;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(DELETE_MATCHING_TOMBSTONE_SQL)
      .bind(
        projection.profile.id,
        projection.sourceVersion.seconds,
        projection.sourceVersion.nanos,
        projection.schemaVersion,
      ),
    db
      .prepare(UPSERT_PROFILE_SQL)
      .bind(
        projection.profile.id,
        JSON.stringify(projection.profile),
        projection.mergedIntoProfileId,
        projection.sortValues.rating,
        projection.sortValues.mp,
        projection.sortValues.dust,
        projection.sortValues.slime,
        projection.sortValues.gum,
        projection.sortValues.metal,
        projection.sortValues.ice,
        Number(projection.sortPresence.rating),
        Number(projection.sortPresence.mp),
        Number(projection.sortPresence.dust),
        Number(projection.sortPresence.slime),
        Number(projection.sortPresence.gum),
        Number(projection.sortPresence.metal),
        Number(projection.sortPresence.ice),
        projection.sourceVersion.seconds,
        projection.sourceVersion.nanos,
        projection.digest,
        projectedAtMs,
        projection.schemaVersion,
        projection.sourceVersion.seconds,
        projection.sourceVersion.nanos,
      ),
    db
      .prepare(
        `DELETE FROM profile_logins_v2 WHERE profile_id = ? AND ${CURRENT_ACTIVE_PROJECTION_SQL}`,
      )
      .bind(projection.profile.id, ...version),
    db
      .prepare(
        `INSERT OR IGNORE INTO profile_logins_v2 (
           login_uid,
           profile_id,
           projection_schema_version
         )
         SELECT CAST(value AS TEXT), ?, ?
         FROM json_each(?)
         WHERE ${CURRENT_ACTIVE_PROJECTION_SQL}`,
      )
      .bind(
        projection.profile.id,
        projection.schemaVersion,
        JSON.stringify(projection.logins),
        ...version,
      ),
    clearProjectionFailure(db, projection.profile.id, projection.sourceVersion),
  ];
  await db.batch(statements);
}

export async function commitProfileProjectionFailure(
  db: D1Database,
  profileId: string,
  sourceVersion: FirestoreUpdateVersion,
  recordedAtMs: number,
  loginUids: readonly unknown[] = [],
  loginUidsComplete = true,
): Promise<void> {
  if (
    !profileId ||
    profileId.includes("/") ||
    !Number.isSafeInteger(sourceVersion.seconds) ||
    !Number.isSafeInteger(sourceVersion.nanos) ||
    sourceVersion.nanos < 0 ||
    sourceVersion.nanos >= 1_000_000_000 ||
    !Number.isSafeInteger(recordedAtMs) ||
    recordedAtMs <= 0 ||
    typeof loginUidsComplete !== "boolean"
  ) {
    throw new TypeError("invalid-profile-projection-failure");
  }
  const boundedMetadata = createProfileProjectionFailureLoginMetadata({
    logins: loginUids,
  });
  const loginMetadata =
    loginUidsComplete && boundedMetadata.complete
      ? boundedMetadata
      : { complete: false, loginUids: [] };
  await db
    .prepare(UPSERT_PROJECTION_FAILURE_SQL)
    .bind(
      profileId,
      sourceVersion.seconds,
      sourceVersion.nanos,
      recordedAtMs,
      JSON.stringify(loginMetadata.loginUids),
      sourceVersion.seconds,
      sourceVersion.nanos,
      Number(loginMetadata.complete),
      PROFILE_PROJECTION_SCHEMA_VERSION,
      sourceVersion.seconds,
      sourceVersion.nanos,
      profileId,
      sourceVersion.seconds,
      sourceVersion.seconds,
      sourceVersion.nanos,
      sourceVersion.nanos,
      PROFILE_PROJECTION_SCHEMA_VERSION,
    )
    .run();
}

export async function commitProfileDeletion(
  db: D1Database,
  profileId: string,
  sourceVersion: FirestoreUpdateVersion,
  projectedAtMs: number,
  expectedProfileVersion: FirestoreUpdateVersion | null = sourceVersion,
): Promise<void> {
  if (
    !profileId ||
    profileId.includes("/") ||
    !Number.isSafeInteger(sourceVersion.seconds) ||
    !Number.isSafeInteger(sourceVersion.nanos) ||
    sourceVersion.nanos < 0 ||
    sourceVersion.nanos >= 1_000_000_000 ||
    !Number.isSafeInteger(projectedAtMs) ||
    projectedAtMs <= 0 ||
    (expectedProfileVersion !== null &&
      (!Number.isSafeInteger(expectedProfileVersion.seconds) ||
        !Number.isSafeInteger(expectedProfileVersion.nanos) ||
        expectedProfileVersion.nanos < 0 ||
        expectedProfileVersion.nanos >= 1_000_000_000 ||
        sourceVersion.seconds < expectedProfileVersion.seconds ||
        (sourceVersion.seconds === expectedProfileVersion.seconds &&
          sourceVersion.nanos < expectedProfileVersion.nanos)))
  ) {
    throw new TypeError("invalid-profile-deletion");
  }
  const version = [
    profileId,
    sourceVersion.seconds,
    sourceVersion.nanos,
  ] as const;
  await db.batch([
    db
      .prepare(DELETE_PROFILE_SQL)
      .bind(
        profileId,
        sourceVersion.seconds,
        sourceVersion.nanos,
        "0".repeat(64),
        projectedAtMs,
        PROFILE_PROJECTION_SCHEMA_VERSION,
        sourceVersion.seconds,
        sourceVersion.nanos,
        expectedProfileVersion ? 1 : 0,
        expectedProfileVersion?.seconds ?? 0,
        expectedProfileVersion?.nanos ?? 0,
      ),
    db
      .prepare(
        `DELETE FROM profile_logins_v2 WHERE profile_id = ? AND ${CURRENT_DELETED_SOURCE_SQL}`,
      )
      .bind(profileId, ...version),
    clearProjectionFailureAfterDeletion(db, profileId, sourceVersion),
  ]);
}

export async function readProfileReconciliationState(
  db: D1Database,
  profileIds?: string[],
): Promise<Map<string, ProfileReconciliationState>> {
  const uniqueProfileIds = profileIds
    ? Array.from(new Set(profileIds)).sort()
    : null;
  if (uniqueProfileIds?.length === 0) {
    return new Map();
  }
  const profileFilter = uniqueProfileIds
    ? `WHERE profile_id IN (
         SELECT CAST(value AS TEXT) FROM json_each(?)
       )`
    : "";
  const failureFilter = uniqueProfileIds
    ? `WHERE profile_id IN (
         SELECT CAST(value AS TEXT) FROM json_each(?)
       )`
    : "";
  let statement = db.prepare(
    `SELECT
       profile_id,
       source_update_seconds,
       source_update_nanos,
       projection_schema_source_seconds,
       projection_schema_source_nanos,
       projection_schema_version,
       NULL AS login_uids_source_seconds,
       NULL AS login_uids_source_nanos,
       NULL AS login_uids_complete,
       is_deleted,
       0 AS is_failure
     FROM profiles
     ${profileFilter}
     UNION ALL
     SELECT
       profile_id,
       source_update_seconds,
       source_update_nanos,
       projection_schema_source_seconds,
       projection_schema_source_nanos,
       projection_schema_version,
       login_uids_source_seconds,
       login_uids_source_nanos,
       login_uids_complete,
       NULL AS is_deleted,
       1 AS is_failure
     FROM profile_projection_failures
     ${failureFilter}`,
  );
  if (uniqueProfileIds) {
    const encoded = JSON.stringify(uniqueProfileIds);
    statement = statement.bind(encoded, encoded);
  }
  const result = await statement.all<ProfileReconciliationRow>();
  const states = new Map<string, ProfileReconciliationState>();
  for (const row of result.results) {
    if (
      !row.profile_id ||
      !Number.isSafeInteger(row.source_update_seconds) ||
      !Number.isSafeInteger(row.source_update_nanos) ||
      row.source_update_nanos < 0 ||
      row.source_update_nanos >= 1_000_000_000 ||
      !Number.isSafeInteger(row.projection_schema_source_seconds) ||
      !Number.isSafeInteger(row.projection_schema_source_nanos) ||
      row.projection_schema_source_nanos < 0 ||
      row.projection_schema_source_nanos >= 1_000_000_000 ||
      !Number.isSafeInteger(row.projection_schema_version) ||
      row.projection_schema_version <= 0 ||
      (row.is_failure !== 0 && row.is_failure !== 1) ||
      (row.is_failure === 0 &&
        ((row.is_deleted !== 0 && row.is_deleted !== 1) ||
          row.login_uids_source_seconds !== null ||
          row.login_uids_source_nanos !== null ||
          row.login_uids_complete !== null)) ||
      (row.is_failure === 1 &&
        (row.is_deleted !== null ||
          !Number.isSafeInteger(row.login_uids_source_seconds) ||
          !Number.isSafeInteger(row.login_uids_source_nanos) ||
          Number(row.login_uids_source_nanos) < 0 ||
          Number(row.login_uids_source_nanos) >= 1_000_000_000 ||
          (row.login_uids_complete !== 0 && row.login_uids_complete !== 1)))
    ) {
      throw new ProfileRepositoryFailure();
    }
    const state = states.get(row.profile_id) || {
      failureLoginUidsComplete: null,
      failureLoginUidsSourceVersion: null,
      failureSchemaSourceVersion: null,
      failureSchemaVersion: null,
      failureVersion: null,
      profile: null,
    };
    const sourceVersion = {
      seconds: row.source_update_seconds,
      nanos: row.source_update_nanos,
    };
    const schemaSourceVersion = {
      seconds: row.projection_schema_source_seconds,
      nanos: row.projection_schema_source_nanos,
    };
    if (row.is_failure === 1) {
      state.failureLoginUidsComplete = row.login_uids_complete === 1;
      state.failureLoginUidsSourceVersion = {
        seconds: Number(row.login_uids_source_seconds),
        nanos: Number(row.login_uids_source_nanos),
      };
      state.failureVersion = sourceVersion;
      state.failureSchemaVersion = row.projection_schema_version;
      state.failureSchemaSourceVersion = schemaSourceVersion;
    } else {
      state.profile = {
        isDeleted: row.is_deleted === 1,
        schemaVersion: row.projection_schema_version,
        schemaSourceVersion,
        sourceVersion,
      };
    }
    states.set(row.profile_id, state);
  }
  return states;
}

function leaderboardColumns(type: LeaderboardReadType): {
  present: string;
  value: string;
} {
  switch (type) {
    case "rating":
      return { present: "rating_sort_present", value: "rating_sort" };
    case "mp":
      return {
        present: "mana_points_sort_present",
        value: "mana_points_sort",
      };
    case "dust":
      return { present: "dust_sort_present", value: "dust_sort" };
    case "slime":
      return { present: "slime_sort_present", value: "slime_sort" };
    case "gum":
      return { present: "gum_sort_present", value: "gum_sort" };
    case "metal":
      return { present: "metal_sort_present", value: "metal_sort" };
    case "ice":
      return { present: "ice_sort_present", value: "ice_sort" };
  }
}

export function createD1ProfileRepository(db: D1Database): ProfileRepository {
  const assertAllHealthy = async (): Promise<void> => {
    if (
      await db
        .prepare("SELECT 1 FROM profile_projection_failures LIMIT 1")
        .first()
    ) {
      throw new ProfileRepositoryFailure();
    }
  };
  const assertProfileHealthy = async (profileId: string): Promise<void> => {
    if (
      await db
        .prepare(
          "SELECT 1 FROM profile_projection_failures WHERE profile_id = ? LIMIT 1",
        )
        .bind(profileId)
        .first()
    ) {
      throw new ProfileRepositoryFailure();
    }
  };
  const assertLoginHealthy = async (loginId: string): Promise<void> => {
    if (
      await db
        .prepare(
          `SELECT 1
           FROM profile_projection_failures AS failures
           WHERE failures.login_uids_source_seconds != failures.source_update_seconds
           OR failures.login_uids_source_nanos != failures.source_update_nanos
           OR failures.login_uids_complete != 1
           OR json_type(failures.login_uids_json) != 'array'
           OR EXISTS (
             SELECT 1
             FROM json_each(failures.login_uids_json) AS login_uids
             WHERE login_uids.type = 'text' AND login_uids.value = ?
           )
           OR EXISTS (
             SELECT 1
             FROM profile_logins_v2
             WHERE profile_logins_v2.login_uid = ?
               AND profile_logins_v2.profile_id = failures.profile_id
           )
           LIMIT 1`,
        )
        .bind(loginId, loginId)
        .first()
    ) {
      throw new ProfileRepositoryFailure();
    }
  };
  const getRow = (profileId: string) =>
    db
      .prepare(
        `SELECT profile_id, payload_json, merged_into_profile_id
         FROM profiles WHERE profile_id = ? AND is_deleted = 0`,
      )
      .bind(profileId)
      .first<ProfileRow>();

  const getById = async (
    profileId: string,
  ): Promise<CompletePlayerProfile | null> => {
    const visited = new Set<string>();
    let currentProfileId = profileId;
    for (let hop = 0; hop <= PROFILE_MERGE_REDIRECT_LIMIT; hop++) {
      if (visited.has(currentProfileId)) {
        return null;
      }
      visited.add(currentProfileId);
      await assertProfileHealthy(currentProfileId);
      const row = await getRow(currentProfileId);
      if (!row) {
        return null;
      }
      if (!row.merged_into_profile_id) {
        return parseProfile(row);
      }
      currentProfileId = row.merged_into_profile_id;
    }
    return null;
  };

  return {
    async getProfileById(profileId) {
      return getById(profileId);
    },

    async getProfileByLoginId(loginId) {
      await assertLoginHealthy(loginId);
      const row = await db
        .prepare(
          `SELECT
             profiles.profile_id,
             profiles.payload_json,
             profiles.merged_into_profile_id
           FROM profile_logins_v2
           INNER JOIN profiles
             ON profiles.profile_id = profile_logins_v2.profile_id
           WHERE profile_logins_v2.login_uid = ?
             AND profiles.is_deleted = 0
           ORDER BY profile_logins_v2.profile_id ASC
           LIMIT 1`,
        )
        .bind(loginId)
        .first<ProfileRow>();
      return row ? parseProfile(row) : null;
    },

    async readLeaderboard(type) {
      await assertAllHealthy();
      const columns = leaderboardColumns(type);
      const result = await db
        .prepare(
          `SELECT profile_id, payload_json, merged_into_profile_id
           FROM profiles
           WHERE is_deleted = 0 AND ${columns.present} = 1
           ORDER BY ${columns.value} DESC, profile_id DESC
           LIMIT ?`,
        )
        .bind(LEADERBOARD_ENTRY_LIMIT)
        .all<ProfileRow>();
      return result.results.map((row) =>
        profileWithoutTutorialState(parseProfile(row)),
      );
    },
  };
}
