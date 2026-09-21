import {
  CanonicalProfileCorruption,
  commitCanonicalPlan,
  materializeCanonicalProfile,
  parseCanonicalMergeTargetRow,
  parseCanonicalProfileRow,
  type CanonicalExpectation,
  type CanonicalLoginOwnerSnapshot,
  type CanonicalProfileSnapshot,
  type CanonicalProfileValue,
  type CanonicalSortKey,
} from "./profileCanonicalD1.ts";
import {
  CANONICAL_OWNED_PROFILE_COLUMNS,
  CANONICAL_OWNED_PROFILE_FROM,
  parseCanonicalOwnedProfileRow,
  type CanonicalOwnedProfileSnapshot,
} from "./profileCanonical/ownedProfile.ts";
import { flag, nonempty } from "./profileCanonical/validation.ts";

export type CanonicalProfileMutationSnapshot = CanonicalOwnedProfileSnapshot;

export type CanonicalRatingProfileSnapshot =
  CanonicalProfileMutationSnapshot & {
    februaryOpponentProfileIds: string[];
  };

export type CanonicalChallengeReplayProfileSnapshot = {
  profile: CanonicalProfileSnapshot | null;
  februaryOpponentProfileIds: string[];
};

export function materializeCanonicalProfileUpdate(
  snapshot: CanonicalProfileSnapshot,
  profile: CanonicalProfileSnapshot["profile"],
  updatedAtMs: number,
  {
    sortUpdates = {},
    winPresent = snapshot.winPresent,
    emojiPresent = snapshot.emojiPresent,
    gameplayEmoji = snapshot.gameplayEmoji,
  }: {
    sortUpdates?: Partial<Record<CanonicalSortKey, number>>;
    winPresent?: boolean;
    emojiPresent?: boolean;
    gameplayEmoji?: string | number;
  } = {},
): CanonicalProfileValue {
  return materializeCanonicalProfile({
    profile,
    createdAtMs: snapshot.createdAtMs,
    updatedAtMs,
    legacyFields: snapshot.legacyFields,
    mergedAtMs: snapshot.mergedAtMs,
    mergedIntoProfileId: snapshot.mergedIntoProfileId,
    state: snapshot.state,
    sortPresence: {
      ...snapshot.sortPresence,
      ...Object.fromEntries(Object.keys(sortUpdates).map((key) => [key, true])),
    },
    sortValues: { ...snapshot.sortValues, ...sortUpdates },
    winPresent,
    emojiPresent,
    gameplayEmoji,
  });
}

export function commitCanonicalProfileUpdate(
  db: D1Database,
  snapshot: CanonicalProfileSnapshot,
  value: CanonicalProfileValue,
  {
    owner,
    additionalExpectations = [],
  }: {
    owner?: CanonicalLoginOwnerSnapshot;
    additionalExpectations?: readonly CanonicalExpectation[];
  } = {},
): Promise<void> {
  return commitCanonicalPlan(db, {
    expectations: [
      {
        kind: "profile-revision",
        profileId: snapshot.profileId,
        revision: snapshot.revision,
      },
      ...(owner
        ? ([
            {
              kind: "login-owner-revision",
              loginUid: owner.loginUid,
              profileId: owner.profileId,
              revision: owner.revision,
            },
          ] as const)
        : []),
      ...additionalExpectations,
    ],
    mutations: [{ kind: "patch-active-profile", current: snapshot, value }],
  });
}

function canonicalProfileMutationStatement(
  db: D1Database,
  loginUid: string,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ${CANONICAL_OWNED_PROFILE_COLUMNS}
       ${CANONICAL_OWNED_PROFILE_FROM}
       WHERE owner.login_uid = ?`,
    )
    .bind(loginUid);
}

export async function readCanonicalProfileMutationByLogin(
  db: D1Database,
  loginUid: string,
): Promise<CanonicalProfileMutationSnapshot | null> {
  const row = await canonicalProfileMutationStatement(db, loginUid).first<
    Record<string, unknown>
  >();
  return parseCanonicalOwnedProfileRow(row, loginUid);
}

function parseCanonicalRatingProfile(
  row: Record<string, unknown> | undefined,
  opponents: readonly Record<string, unknown>[],
  loginUid: string,
): CanonicalRatingProfileSnapshot | null {
  const snapshot = parseCanonicalOwnedProfileRow(row, loginUid);
  if (!snapshot) return null;
  const februaryOpponentProfileIds = opponents.map((opponent) => {
    const profileId = opponent?.opponent_profile_id;
    if (typeof profileId !== "string" || profileId === "") {
      throw new CanonicalProfileCorruption();
    }
    return profileId;
  });
  return { ...snapshot, februaryOpponentProfileIds };
}

export async function readCanonicalRatingProfiles(
  db: D1Database,
  {
    playerLoginUid,
    opponentLoginUid,
  }: { playerLoginUid: string; opponentLoginUid: string },
): Promise<{
  player: CanonicalRatingProfileSnapshot | null;
  opponent: CanonicalRatingProfileSnapshot | null;
}> {
  const statements = [playerLoginUid, opponentLoginUid].flatMap((loginUid) => [
    canonicalProfileMutationStatement(db, loginUid),
    db
      .prepare(
        `SELECT opponent_profile_id FROM profile_february_opponents
         WHERE profile_id = (
           SELECT profile_id FROM profile_login_owners WHERE login_uid = ?
         ) ORDER BY opponent_profile_id ASC`,
      )
      .bind(loginUid),
  ]);
  const [player, playerOpponents, opponent, opponentOpponents] =
    await db.batch<Record<string, unknown>>(statements);
  return {
    player: parseCanonicalRatingProfile(
      player.results[0],
      playerOpponents.results,
      playerLoginUid,
    ),
    opponent: parseCanonicalRatingProfile(
      opponent.results[0],
      opponentOpponents.results,
      opponentLoginUid,
    ),
  };
}

function canonicalChallengeReplayProfileStatement(
  db: D1Database,
  profileId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT profile.*,
              mapping.source_profile_id AS canonical_merge_source_profile_id,
              mapping.target_profile_id AS canonical_merge_target_profile_id,
              mapping.merged_at_ms AS canonical_merge_merged_at_ms,
              mapping.op_id AS canonical_merge_op_id,
              CASE WHEN profile.profile_id IS NULL THEN
                EXISTS (
                  SELECT 1 FROM profile_login_owners
                  WHERE profile_id = requested.profile_id
                ) OR EXISTS (
                  SELECT 1 FROM profile_auth_methods
                  WHERE profile_id = requested.profile_id
                ) OR EXISTS (
                  SELECT 1 FROM profile_auth_recovery_jobs
                  WHERE profile_id = requested.profile_id
                )
              ELSE 0 END AS canonical_orphaned_dependents
       FROM (SELECT ? AS profile_id) AS requested
       LEFT JOIN profile_records AS profile
         ON profile.profile_id = requested.profile_id
       LEFT JOIN profile_merge_targets AS mapping
         ON mapping.source_profile_id = requested.profile_id`,
    )
    .bind(profileId);
}

function parseCanonicalChallengeReplayProfile(
  row: Record<string, unknown> | undefined,
  opponents: readonly Record<string, unknown>[],
  profileId: string,
): CanonicalChallengeReplayProfileSnapshot {
  if (!row) throw new CanonicalProfileCorruption();
  const profile =
    row.profile_id === null ? null : parseCanonicalProfileRow(row);
  const mergeFields = {
    source_profile_id: row.canonical_merge_source_profile_id,
    target_profile_id: row.canonical_merge_target_profile_id,
    merged_at_ms: row.canonical_merge_merged_at_ms,
    op_id: row.canonical_merge_op_id,
  };
  const mergeTarget = Object.values(mergeFields).every(
    (value) => value === null,
  )
    ? null
    : parseCanonicalMergeTargetRow(mergeFields);
  const orphanedDependents = flag(row.canonical_orphaned_dependents);
  const februaryOpponentProfileIds = opponents.map((opponent) =>
    nonempty(opponent?.opponent_profile_id),
  );
  if (!profile) {
    if (orphanedDependents || februaryOpponentProfileIds.length !== 0) {
      throw new CanonicalProfileCorruption();
    }
    return { profile, februaryOpponentProfileIds };
  }
  if (
    profile.profileId !== profileId ||
    (profile.state === "active"
      ? mergeTarget !== null
      : !mergeTarget ||
        mergeTarget.sourceProfileId !== profileId ||
        mergeTarget.targetProfileId !== profile.mergedIntoProfileId)
  ) {
    throw new CanonicalProfileCorruption();
  }
  return { profile, februaryOpponentProfileIds };
}

export async function readCanonicalChallengeReplayProfiles(
  db: D1Database,
  {
    playerProfileId,
    opponentProfileId,
  }: { playerProfileId: string; opponentProfileId: string },
): Promise<{
  player: CanonicalChallengeReplayProfileSnapshot;
  opponent: CanonicalChallengeReplayProfileSnapshot;
}> {
  const statements = [playerProfileId, opponentProfileId].flatMap(
    (profileId) => [
      canonicalChallengeReplayProfileStatement(db, profileId),
      db
        .prepare(
          `SELECT opponent_profile_id FROM profile_february_opponents
         WHERE profile_id = ? ORDER BY opponent_profile_id ASC`,
        )
        .bind(profileId),
    ],
  );
  const [player, playerOpponents, opponent, opponentOpponents] =
    await db.batch<Record<string, unknown>>(statements);
  return {
    player: parseCanonicalChallengeReplayProfile(
      player.results[0],
      playerOpponents.results,
      playerProfileId,
    ),
    opponent: parseCanonicalChallengeReplayProfile(
      opponent.results[0],
      opponentOpponents.results,
      opponentProfileId,
    ),
  };
}
