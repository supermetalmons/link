import {
  CanonicalProfileCorruption,
  commitCanonicalPlan,
  materializeCanonicalProfile,
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

export type CanonicalProfileMutationSnapshot = CanonicalOwnedProfileSnapshot;

export type CanonicalRatingProfileSnapshot =
  CanonicalProfileMutationSnapshot & {
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
    mutations: [{ kind: "update-active-profile", value }],
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
