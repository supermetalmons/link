import {
  CanonicalProfileCorruption,
  commitCanonicalPlan,
  materializeCanonicalProfile,
  parseCanonicalLoginOwnerRow,
  parseCanonicalProfileRow,
  type CanonicalExpectation,
  type CanonicalLoginOwnerSnapshot,
  type CanonicalProfileSnapshot,
  type CanonicalProfileValue,
  type CanonicalSortKey,
} from "./profileCanonicalD1.ts";

export type CanonicalProfileMutationSnapshot = {
  owner: CanonicalLoginOwnerSnapshot;
  profile: CanonicalProfileSnapshot;
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

export async function readCanonicalProfileMutationByLogin(
  db: D1Database,
  loginUid: string,
): Promise<CanonicalProfileMutationSnapshot | null> {
  const row = await db
    .prepare(
      `SELECT profile.*,
              owner.login_uid AS mutation_owner_login_uid,
              owner.profile_id AS mutation_owner_profile_id,
              owner.revision AS mutation_owner_revision,
              owner.created_at_ms AS mutation_owner_created_at_ms,
              owner.updated_at_ms AS mutation_owner_updated_at_ms,
              mapping.source_profile_id AS mutation_merge_source_profile_id
       FROM profile_login_owners AS owner
       LEFT JOIN profile_records AS profile
         ON profile.profile_id = owner.profile_id
       LEFT JOIN profile_merge_targets AS mapping
         ON mapping.source_profile_id = owner.profile_id
       WHERE owner.login_uid = ?`,
    )
    .bind(loginUid)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const owner = parseCanonicalLoginOwnerRow({
    login_uid: row.mutation_owner_login_uid,
    profile_id: row.mutation_owner_profile_id,
    revision: row.mutation_owner_revision,
    created_at_ms: row.mutation_owner_created_at_ms,
    updated_at_ms: row.mutation_owner_updated_at_ms,
  });
  const profile = parseCanonicalProfileRow(row);
  if (
    owner.loginUid !== loginUid ||
    owner.profileId !== profile.profileId ||
    profile.state !== "active" ||
    row.mutation_merge_source_profile_id !== null
  ) {
    throw new CanonicalProfileCorruption();
  }
  return { owner, profile };
}
