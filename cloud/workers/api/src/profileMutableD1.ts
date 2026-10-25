import {
  prepareCanonicalOwnedProfileRead,
  parseCanonicalOwnedProfileRowWith,
} from "./profileCanonical/ownedProfile.ts";
import {
  materializeCanonicalProfile,
  materializeCanonicalProfileFields,
  resolveCanonicalProfilesUsing,
} from "./profileCanonical/profiles.ts";
import {
  mutableProfileColumns,
  mutableProfileValue,
  parseMutableProfileRow,
} from "./profileCanonical/mutableProfiles.ts";
import type {
  CanonicalLoginOwnerSnapshot,
  CanonicalMutableProfileSnapshot,
  CanonicalMutation,
  CanonicalSortKey,
} from "./profileCanonical/types.ts";

export type { CanonicalMutableProfileSnapshot } from "./profileCanonical/types.ts";

export type CanonicalOwnedMutableProfileSnapshot = {
  owner: CanonicalLoginOwnerSnapshot;
  profile: CanonicalMutableProfileSnapshot;
};

export type MutableProfileUpdateOptions = {
  sortUpdates?: Partial<Record<CanonicalSortKey, number>>;
  winPresent?: boolean;
  emojiPresent?: boolean;
  gameplayEmoji?: string | number;
};

export type MutableProfileMutation = Extract<
  CanonicalMutation,
  { kind: "patch-profile-fields" | "patch-active-profile" }
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
      player.results[0],
      playerLoginUid,
      parseMutableProfileRow,
    ),
    opponent: parseCanonicalOwnedProfileRowWith(
      opponent.results[0],
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
  {
    sortUpdates = {},
    winPresent = snapshot.winPresent,
    emojiPresent = snapshot.emojiPresent,
    gameplayEmoji = snapshot.gameplayEmoji,
  }: MutableProfileUpdateOptions = {},
): MutableProfileMutation {
  const input = {
    profile,
    createdAtMs: snapshot.createdAtMs,
    updatedAtMs,
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
  };
  if (snapshot.storageShape === "full") {
    return {
      kind: "patch-active-profile",
      current: snapshot,
      value: materializeCanonicalProfile({
        ...input,
        legacyFields: snapshot.legacyFields,
      }),
    };
  }
  return {
    kind: "patch-profile-fields",
    current: snapshot,
    value: mutableProfileValue(materializeCanonicalProfileFields(input)),
  };
}
