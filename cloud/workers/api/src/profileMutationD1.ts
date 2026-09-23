import {
  MATERIAL_KEYS,
  normalizeMiningSnapshot,
  type MiningMaterialName,
} from "@mons/shared/mining";
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

type CanonicalGameplayProfilePatch = {
  rating?: number;
  nonce?: number;
  win?: boolean;
  totalManaPoints?: number;
  feb2026UniqueOpponentsCount?: number;
  mining?: unknown;
};

export function patchCanonicalProfile(
  snapshot: CanonicalProfileSnapshot,
  patch: CanonicalGameplayProfilePatch,
  updatedAtMs: number,
  miningSortKeys: readonly MiningMaterialName[] = MATERIAL_KEYS,
): CanonicalProfileValue {
  const profile = { ...snapshot.profile };
  const sortUpdates: Partial<Record<CanonicalSortKey, number>> = {};
  if (typeof patch.rating === "number" && Number.isFinite(patch.rating)) {
    profile.rating = patch.rating;
    sortUpdates.rating = patch.rating;
  }
  if (typeof patch.nonce === "number" && Number.isFinite(patch.nonce)) {
    profile.nonce = patch.nonce;
    sortUpdates.nonce = patch.nonce;
  }
  if (
    typeof patch.totalManaPoints === "number" &&
    Number.isFinite(patch.totalManaPoints)
  ) {
    profile.totalManaPoints = patch.totalManaPoints;
    sortUpdates.mp = patch.totalManaPoints;
  }
  let winPresent = snapshot.winPresent;
  if (typeof patch.win === "boolean") {
    profile.win = patch.win;
    winPresent = true;
  }
  if (
    typeof patch.feb2026UniqueOpponentsCount === "number" &&
    Number.isFinite(patch.feb2026UniqueOpponentsCount)
  ) {
    profile.feb2026UniqueOpponentsCount = patch.feb2026UniqueOpponentsCount;
  }
  if (patch.mining !== undefined) {
    profile.mining = normalizeMiningSnapshot(patch.mining);
    for (const material of miningSortKeys) {
      sortUpdates[material] = profile.mining.materials[material];
    }
  }
  return materializeCanonicalProfileUpdate(
    snapshot,
    profile,
    Math.max(snapshot.updatedAtMs, updatedAtMs),
    { sortUpdates, winPresent },
  );
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

export async function readCanonicalRatingProfiles(
  db: D1Database,
  {
    playerLoginUid,
    opponentLoginUid,
  }: { playerLoginUid: string; opponentLoginUid: string },
): Promise<{
  player: CanonicalProfileMutationSnapshot | null;
  opponent: CanonicalProfileMutationSnapshot | null;
}> {
  const statements = [playerLoginUid, opponentLoginUid].map((loginUid) =>
    canonicalProfileMutationStatement(db, loginUid),
  );
  const [player, opponent] =
    await db.batch<Record<string, unknown>>(statements);
  return {
    player: parseCanonicalOwnedProfileRow(player.results[0], playerLoginUid),
    opponent: parseCanonicalOwnedProfileRow(
      opponent.results[0],
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
