import {
  isPlayerProfile,
  type CompletePlayerProfile,
  type LeaderboardReadType,
} from "@mons/shared/profiles";
import {
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
  profile_id: string;
  source_update_nanos: number;
  source_update_seconds: number;
};

export type ProfileReconciliationState = {
  failureVersion: FirestoreUpdateVersion | null;
  profile: {
    isDeleted: boolean;
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
    source_update_seconds,
    source_update_nanos,
    source_digest,
    projected_at_ms,
    is_deleted
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
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
    source_update_seconds = excluded.source_update_seconds,
    source_update_nanos = excluded.source_update_nanos,
    source_digest = excluded.source_digest,
    projected_at_ms = excluded.projected_at_ms,
    is_deleted = 0
  WHERE excluded.source_update_seconds > profiles.source_update_seconds
    OR (
      excluded.source_update_seconds = profiles.source_update_seconds
      AND (
        excluded.source_update_nanos > profiles.source_update_nanos
        OR (
          excluded.source_update_nanos = profiles.source_update_nanos
          AND profiles.is_deleted = 0
        )
      )
    )
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
    source_update_seconds,
    source_update_nanos,
    source_digest,
    projected_at_ms,
    is_deleted
  ) VALUES (?, '{}', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, 1)
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
    source_update_seconds = excluded.source_update_seconds,
    source_update_nanos = excluded.source_update_nanos,
    source_digest = excluded.source_digest,
    projected_at_ms = excluded.projected_at_ms,
    is_deleted = 1
  WHERE ? = 1
    AND profiles.source_update_seconds = ?
    AND profiles.source_update_nanos = ?
`;

const CURRENT_ACTIVE_SOURCE_SQL = `
  EXISTS (
    SELECT 1
    FROM profiles
    WHERE profile_id = ?
      AND source_update_seconds = ?
      AND source_update_nanos = ?
      AND is_deleted = 0
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
        AND source_update_nanos <= ?
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
    login_uids_json
  )
  SELECT ?, ?, ?, ?, '[]'
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
            OR (source_update_nanos = ? AND is_deleted = 1)
          )
        )
      )
  )
  ON CONFLICT (profile_id) DO UPDATE SET
    source_update_seconds = excluded.source_update_seconds,
    source_update_nanos = excluded.source_update_nanos,
    recorded_at_ms = excluded.recorded_at_ms,
    login_uids_json = '[]'
  WHERE (
      excluded.source_update_seconds > profile_projection_failures.source_update_seconds
      OR (
        excluded.source_update_seconds = profile_projection_failures.source_update_seconds
        AND excluded.source_update_nanos >= profile_projection_failures.source_update_nanos
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
                AND is_deleted = 1
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
  if (!Number.isSafeInteger(projectedAtMs) || projectedAtMs <= 0) {
    throw new TypeError("invalid-profile-projected-at");
  }
  const version = [
    projection.profile.id,
    projection.sourceVersion.seconds,
    projection.sourceVersion.nanos,
  ] as const;
  const statements: D1PreparedStatement[] = [
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
        projection.sourceVersion.seconds,
        projection.sourceVersion.nanos,
        projection.digest,
        projectedAtMs,
      ),
    db
      .prepare(
        `DELETE FROM profile_logins WHERE profile_id = ? AND ${CURRENT_ACTIVE_SOURCE_SQL}`,
      )
      .bind(projection.profile.id, ...version),
    db
      .prepare(
        `INSERT OR IGNORE INTO profile_logins (login_uid, profile_id)
         SELECT CAST(value AS TEXT), ?
         FROM json_each(?)
         WHERE ${CURRENT_ACTIVE_SOURCE_SQL}`,
      )
      .bind(
        projection.profile.id,
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
): Promise<void> {
  if (
    !profileId ||
    profileId.includes("/") ||
    !Number.isSafeInteger(sourceVersion.seconds) ||
    !Number.isSafeInteger(sourceVersion.nanos) ||
    sourceVersion.nanos < 0 ||
    sourceVersion.nanos >= 1_000_000_000 ||
    !Number.isSafeInteger(recordedAtMs) ||
    recordedAtMs <= 0
  ) {
    throw new TypeError("invalid-profile-projection-failure");
  }
  await db
    .prepare(UPSERT_PROJECTION_FAILURE_SQL)
    .bind(
      profileId,
      sourceVersion.seconds,
      sourceVersion.nanos,
      recordedAtMs,
      profileId,
      sourceVersion.seconds,
      sourceVersion.seconds,
      sourceVersion.nanos,
      sourceVersion.nanos,
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
        expectedProfileVersion ? 1 : 0,
        expectedProfileVersion?.seconds ?? 0,
        expectedProfileVersion?.nanos ?? 0,
      ),
    db
      .prepare(
        `DELETE FROM profile_logins WHERE profile_id = ? AND ${CURRENT_DELETED_SOURCE_SQL}`,
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
       is_deleted,
       0 AS is_failure
     FROM profiles
     ${profileFilter}
     UNION ALL
     SELECT
       profile_id,
       source_update_seconds,
       source_update_nanos,
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
      (row.is_failure !== 0 && row.is_failure !== 1) ||
      (row.is_failure === 0 && row.is_deleted !== 0 && row.is_deleted !== 1)
    ) {
      throw new ProfileRepositoryFailure();
    }
    const state = states.get(row.profile_id) || {
      failureVersion: null,
      profile: null,
    };
    const sourceVersion = {
      seconds: row.source_update_seconds,
      nanos: row.source_update_nanos,
    };
    if (row.is_failure === 1) {
      state.failureVersion = sourceVersion;
    } else {
      state.profile = {
        isDeleted: row.is_deleted === 1,
        sourceVersion,
      };
    }
    states.set(row.profile_id, state);
  }
  return states;
}

function leaderboardColumn(type: LeaderboardReadType): string {
  switch (type) {
    case "rating":
      return "rating_sort";
    case "mp":
      return "mana_points_sort";
    case "dust":
      return "dust_sort";
    case "slime":
      return "slime_sort";
    case "gum":
      return "gum_sort";
    case "metal":
      return "metal_sort";
    case "ice":
      return "ice_sort";
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
      await assertAllHealthy();
      return getById(profileId);
    },

    async getProfileByLoginId(loginId) {
      await assertAllHealthy();
      const mapping = await db
        .prepare(
          `SELECT profile_id
           FROM profile_logins
           WHERE login_uid = ?
           ORDER BY profile_id ASC
           LIMIT 1`,
        )
        .bind(loginId)
        .first<{ profile_id: string }>();
      return mapping ? getById(mapping.profile_id) : null;
    },

    async readLeaderboard(type) {
      await assertAllHealthy();
      const column = leaderboardColumn(type);
      const result = await db
        .prepare(
          `SELECT profile_id, payload_json, merged_into_profile_id
           FROM profiles
           WHERE is_deleted = 0 AND ${column} IS NOT NULL
           ORDER BY ${column} DESC, profile_id DESC
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
