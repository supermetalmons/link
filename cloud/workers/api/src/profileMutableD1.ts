import {
  prepareCanonicalOwnedProfileRead,
  parseCanonicalOwnedProfileRowWith,
} from "./profileCanonical/ownedProfile.ts";
import { resolveCanonicalProfilesUsing } from "./profileCanonical/profiles.ts";
import { commitCanonicalPlan } from "./profileCanonical/commit.ts";
import {
  mutableProfileColumns,
  mutableProfileValue,
  parseMutableProfileRow,
} from "./profileCanonical/mutableProfiles.ts";
import type {
  CanonicalExpectation,
  CanonicalLoginOwnerSnapshot,
  CanonicalMutableProfileSnapshot,
  CanonicalMutation,
} from "./profileCanonical/types.ts";
import {
  materializeProfileUpdateFields,
  type MutableProfileUpdateOptions,
} from "./profileUpdateFields.ts";

export type { CanonicalMutableProfileSnapshot } from "./profileCanonical/types.ts";

export type CanonicalOwnedMutableProfileSnapshot = {
  owner: CanonicalLoginOwnerSnapshot;
  profile: CanonicalMutableProfileSnapshot;
};

export type MutableProfileMutation = Extract<
  CanonicalMutation,
  { kind: "patch-profile-fields" }
>;

export async function readMutableProfileMutationByLogin(
  db: D1Database,
  loginUid: string,
): Promise<CanonicalOwnedMutableProfileSnapshot | null> {
  const row = await prepareCanonicalOwnedProfileRead(
    db,
    loginUid,
    mutableProfileColumns("profile"),
  ).first<Record<string, unknown>>();
  return parseCanonicalOwnedProfileRowWith(
    row,
    loginUid,
    parseMutableProfileRow,
  );
}

export async function readMutableRatingProfiles(
  db: D1Database,
  {
    playerLoginUid,
    opponentLoginUid,
  }: { playerLoginUid: string; opponentLoginUid: string },
): Promise<{
  player: CanonicalOwnedMutableProfileSnapshot | null;
  opponent: CanonicalOwnedMutableProfileSnapshot | null;
}> {
  const [player, opponent] = await db.batch<Record<string, unknown>>(
    [playerLoginUid, opponentLoginUid].map((loginUid) =>
      prepareCanonicalOwnedProfileRead(
        db,
        loginUid,
        mutableProfileColumns("profile"),
      ),
    ),
  );
  return {
    player: parseCanonicalOwnedProfileRowWith(
      player!.results[0],
      playerLoginUid,
      parseMutableProfileRow,
    ),
    opponent: parseCanonicalOwnedProfileRowWith(
      opponent!.results[0],
      opponentLoginUid,
      parseMutableProfileRow,
    ),
  };
}

export function resolveMutableProfiles(
  db: D1Database,
  profileIds: readonly string[],
): Promise<Array<CanonicalMutableProfileSnapshot | null>> {
  return resolveCanonicalProfilesUsing(
    db,
    profileIds,
    {
      plain: mutableProfileColumns(),
      qualified: mutableProfileColumns("profile"),
    },
    parseMutableProfileRow,
  );
}

export function buildMutableProfileMutation(
  snapshot: CanonicalMutableProfileSnapshot,
  profile: CanonicalMutableProfileSnapshot["profile"],
  updatedAtMs: number,
  options: MutableProfileUpdateOptions = {},
): MutableProfileMutation {
  return {
    kind: "patch-profile-fields",
    current: snapshot,
    value: mutableProfileValue(
      materializeProfileUpdateFields(snapshot, profile, updatedAtMs, options),
    ),
  };
}

export function commitMutableProfileUpdate(
  db: D1Database,
  mutation: MutableProfileMutation,
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
        profileId: mutation.current.profileId,
        revision: mutation.current.revision,
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
    mutations: [mutation],
  });
}
