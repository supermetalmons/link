import {
  CANONICAL_PUBLIC_PROFILE_COLUMNS,
  parseCanonicalControlRow,
  parseCanonicalPublicProfileRow,
  parseCanonicalProfileRow,
  parseCanonicalMergeTargetRow,
} from "./profileRecords.ts";
import type {
  CompletePlayerProfile,
  LeaderboardReadType,
} from "@mons/shared/profiles";
import { readD1FirstRow } from "../d1Reads.ts";
import { canonicalProfileRedirectCte } from "./redirectSql.ts";
import {
  CanonicalProfileCorruption,
  type CanonicalControlSnapshot,
  type CanonicalControlRow,
  type CanonicalPublicProfileSnapshot,
  type PublicProfileRow,
  type CanonicalProfileSnapshot,
  type ProfileRow,
  type CanonicalMergeTarget,
  type MergeTargetRow,
  CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT,
  CANONICAL_PROFILE_LEADERBOARD_LIMIT,
} from "./types.ts";
export {
  CANONICAL_PUBLIC_PROFILE_COLUMNS,
  parseCanonicalControlRow,
  parseCanonicalPublicProfileRow,
  parseCanonicalProfileRow,
  parseCanonicalMergeTargetRow,
  assertCanonicalProfileFields,
  materializeCanonicalProfileFields,
  materializeCanonicalProfile,
  profileWriteRow,
} from "./profileRecords.ts";

export async function readCanonicalControl(
  db: D1Database,
): Promise<CanonicalControlSnapshot> {
  const row = await readD1FirstRow<CanonicalControlRow>(
    db.prepare(
      `SELECT state FROM profile_canonical_control
       WHERE singleton = 1`,
    ),
  );
  return parseCanonicalControlRow(row);
}

export async function readCanonicalProfile(
  db: D1Database,
  profileId: string,
): Promise<CanonicalProfileSnapshot | null> {
  const row = await readD1FirstRow<ProfileRow>(
    db
      .prepare("SELECT * FROM profile_records_canonical WHERE profile_id = ?")
      .bind(profileId),
  );
  return row ? parseCanonicalProfileRow(row) : null;
}

export async function readCanonicalMergeTarget(
  db: D1Database,
  sourceProfileId: string,
): Promise<CanonicalMergeTarget | null> {
  const row = await readD1FirstRow<MergeTargetRow>(
    db
      .prepare(
        `SELECT source_profile_id, target_profile_id, merged_at_ms, op_id
       FROM profile_merge_targets_canonical WHERE source_profile_id = ?`,
      )
      .bind(sourceProfileId),
  );
  return row ? parseCanonicalMergeTargetRow(row) : null;
}

type CanonicalProfileProjection = string | { plain: string; qualified: string };

async function resolveCanonicalProfileIteratively<
  T extends Pick<
    CanonicalPublicProfileSnapshot,
    "mergedIntoProfileId" | "state"
  >,
>(
  db: D1Database,
  profileId: string,
  redirectLimit: number,
  onRedirectFailure: "null" | "throw",
  columns: CanonicalProfileProjection,
  parseProfile: (value: unknown) => T,
): Promise<T | null> {
  const visited = new Set<string>();
  let currentProfileId = profileId;
  for (let hop = 0; hop <= redirectLimit; hop++) {
    if (visited.has(currentProfileId)) {
      if (onRedirectFailure === "null") return null;
      throw new CanonicalProfileCorruption();
    }
    visited.add(currentProfileId);
    const results = await db.batch([
      db
        .prepare(
          `SELECT ${typeof columns === "string" ? columns : columns.plain} FROM profile_records_canonical WHERE profile_id = ?`,
        )
        .bind(currentProfileId),
      db
        .prepare(
          `SELECT source_profile_id, target_profile_id, merged_at_ms, op_id
           FROM profile_merge_targets_canonical WHERE source_profile_id = ?`,
        )
        .bind(currentProfileId),
    ]);
    const profileRow = results[0]!.results[0];
    const mergeRow = results[1]!.results[0] as MergeTargetRow | undefined;
    const profile = profileRow ? parseProfile(profileRow) : null;
    const mergeTarget = mergeRow
      ? parseCanonicalMergeTargetRow(mergeRow)
      : null;
    if (!mergeTarget) {
      if (profile?.state === "retiring") {
        throw new CanonicalProfileCorruption();
      }
      return profile;
    }
    if (profile?.state === "active") {
      throw new CanonicalProfileCorruption();
    }
    if (
      profile?.mergedIntoProfileId &&
      profile.mergedIntoProfileId !== mergeTarget.targetProfileId
    ) {
      throw new CanonicalProfileCorruption();
    }
    currentProfileId = mergeTarget.targetProfileId;
  }
  if (onRedirectFailure === "null") return null;
  throw new CanonicalProfileCorruption();
}

export function resolveCanonicalProfile(
  db: D1Database,
  profileId: string,
  redirectLimit = CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT,
  onRedirectFailure: "null" | "throw" = "throw",
): Promise<CanonicalProfileSnapshot | null> {
  if (!Number.isFinite(redirectLimit)) {
    return resolveCanonicalProfileIteratively(
      db,
      profileId,
      redirectLimit,
      onRedirectFailure,
      "*",
      parseCanonicalProfileRow,
    );
  }
  return resolveCanonicalProfileUsing(
    db,
    profileId,
    redirectLimit,
    onRedirectFailure,
    "*",
    parseCanonicalProfileRow,
  );
}

export function resolveCanonicalProfiles(
  db: D1Database,
  profileIds: readonly string[],
): Promise<Array<CanonicalProfileSnapshot | null>> {
  return resolveCanonicalProfilesUsing(
    db,
    profileIds,
    "*",
    parseCanonicalProfileRow,
  );
}

export async function resolveCanonicalProfilesUsing<
  T extends Pick<
    CanonicalPublicProfileSnapshot,
    "mergedIntoProfileId" | "state"
  >,
>(
  db: D1Database,
  profileIds: readonly string[],
  columns: CanonicalProfileProjection,
  parseProfile: (value: unknown) => T,
): Promise<Array<T | null>> {
  if (profileIds.length === 0) return [];
  const redirectLimit = CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT;
  if (profileIds.some((profileId) => !profileId.isWellFormed())) {
    return Promise.all(
      profileIds.map((profileId) =>
        resolveCanonicalProfileUsing(
          db,
          profileId,
          redirectLimit,
          "throw",
          columns,
          parseProfile,
        ),
      ),
    );
  }
  const results = await db.batch<Record<string, unknown>>(
    profileIds.map((profileId) =>
      prepareCanonicalProfileResolution(db, profileId, redirectLimit, columns),
    ),
  );
  return profileIds.map((profileId, index) =>
    parseCanonicalProfileResolution(
      results[index]!.results,
      profileId,
      redirectLimit,
      "throw",
      parseProfile,
    ),
  );
}

async function resolveCanonicalProfileUsing<
  T extends Pick<
    CanonicalPublicProfileSnapshot,
    "mergedIntoProfileId" | "state"
  >,
>(
  db: D1Database,
  profileId: string,
  redirectLimit: number,
  onRedirectFailure: "null" | "throw",
  columns: CanonicalProfileProjection,
  parseProfile: (value: unknown) => T,
): Promise<T | null> {
  if (!profileId.isWellFormed()) {
    return resolveCanonicalProfileIteratively(
      db,
      profileId,
      redirectLimit,
      onRedirectFailure,
      columns,
      parseProfile,
    );
  }
  if (!(redirectLimit >= 0)) {
    if (onRedirectFailure === "null") return null;
    throw new CanonicalProfileCorruption();
  }
  const { results } = await prepareCanonicalProfileResolution(
    db,
    profileId,
    redirectLimit,
    columns,
  ).all<Record<string, unknown>>();
  return parseCanonicalProfileResolution(
    results,
    profileId,
    redirectLimit,
    onRedirectFailure,
    parseProfile,
  );
}

function prepareCanonicalProfileResolution(
  db: D1Database,
  profileId: string,
  redirectLimit: number,
  columns: CanonicalProfileProjection,
): D1PreparedStatement {
  return db
    .prepare(
      `${canonicalProfileRedirectCte("profile")}
       SELECT ${
         typeof columns === "string"
           ? columns
               .split(",")
               .map((column) => `profile.${column.trim()}`)
               .join(", ")
           : columns.qualified
       },
              chain.chain_profile_id, chain.depth AS chain_depth,
              target.source_profile_id AS redirect_source_profile_id,
              target.target_profile_id AS redirect_target_profile_id,
              target.merged_at_ms AS redirect_merged_at_ms,
              target.op_id AS redirect_op_id
       FROM chain
       LEFT JOIN profile_records_canonical profile
         ON profile.profile_id = chain.chain_profile_id
       LEFT JOIN profile_merge_targets_canonical target
         ON target.source_profile_id = chain.chain_profile_id
       ORDER BY chain.depth ASC`,
    )
    .bind(JSON.stringify([profileId]), Math.floor(redirectLimit));
}

function parseCanonicalProfileResolution<
  T extends Pick<
    CanonicalPublicProfileSnapshot,
    "mergedIntoProfileId" | "state"
  >,
>(
  results: readonly Record<string, unknown>[],
  profileId: string,
  redirectLimit: number,
  onRedirectFailure: "null" | "throw",
  parseProfile: (value: unknown) => T,
): T | null {
  const visited = new Set<string>();
  let currentProfileId = profileId;
  for (let hop = 0; hop <= redirectLimit; hop++) {
    if (visited.has(currentProfileId)) {
      if (onRedirectFailure === "null") return null;
      throw new CanonicalProfileCorruption();
    }
    visited.add(currentProfileId);
    const row = results[hop];
    if (
      !row ||
      row.chain_depth !== hop ||
      row.chain_profile_id !== currentProfileId
    ) {
      throw new CanonicalProfileCorruption();
    }
    const profile = row.profile_id === null ? null : parseProfile(row);
    const mergeTarget =
      row.redirect_source_profile_id === null
        ? null
        : parseCanonicalMergeTargetRow({
            source_profile_id: row.redirect_source_profile_id,
            target_profile_id: row.redirect_target_profile_id,
            merged_at_ms: row.redirect_merged_at_ms,
            op_id: row.redirect_op_id,
          });
    if (!mergeTarget) {
      if (profile?.state === "retiring" || hop + 1 !== results.length) {
        throw new CanonicalProfileCorruption();
      }
      return profile;
    }
    if (
      profile?.state === "active" ||
      (profile?.mergedIntoProfileId &&
        profile.mergedIntoProfileId !== mergeTarget.targetProfileId)
    ) {
      throw new CanonicalProfileCorruption();
    }
    currentProfileId = mergeTarget.targetProfileId;
  }
  if (onRedirectFailure === "null") return null;
  throw new CanonicalProfileCorruption();
}

export function resolveCanonicalPublicProfile(
  db: D1Database,
  profileId: string,
  redirectLimit = CANONICAL_PROFILE_INTERNAL_REDIRECT_LIMIT,
  onRedirectFailure: "null" | "throw" = "throw",
): Promise<CanonicalPublicProfileSnapshot | null> {
  return resolveCanonicalProfileUsing(
    db,
    profileId,
    redirectLimit,
    onRedirectFailure,
    CANONICAL_PUBLIC_PROFILE_COLUMNS,
    parseCanonicalPublicProfileRow,
  );
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
    case "slime":
    case "gum":
    case "metal":
    case "ice":
      return { present: `${type}_sort_present`, value: `${type}_sort` };
  }
}

function withoutTutorialState(
  profile: CompletePlayerProfile,
): CompletePlayerProfile {
  const {
    completedProblemIds: _completedProblemIds,
    isTutorialCompleted: _isTutorialCompleted,
    ...publicProfile
  } = profile;
  return publicProfile;
}

export async function readCanonicalLeaderboard(
  db: D1Database,
  type: LeaderboardReadType,
  limit = CANONICAL_PROFILE_LEADERBOARD_LIMIT,
): Promise<CompletePlayerProfile[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("invalid-canonical-leaderboard-limit");
  }
  const columns = leaderboardColumns(type);
  const rows = await db
    .prepare(
      `SELECT ${CANONICAL_PUBLIC_PROFILE_COLUMNS}
       FROM profile_records_canonical
       WHERE state = 'active' AND ${columns.present} = 1
       ORDER BY ${columns.value} DESC, profile_id DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<PublicProfileRow>();
  return rows.results.map((row) =>
    withoutTutorialState(parseCanonicalPublicProfileRow(row).profile),
  );
}
