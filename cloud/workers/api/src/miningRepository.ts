import {
  MATERIAL_KEYS,
  normalizeMiningSnapshot,
  type MiningSnapshot,
} from "@mons/shared/mining";
import {
  CanonicalProfileConflict,
  commitCanonicalPlan,
  materializeCanonicalProfile,
  readCanonicalProfileOwnershipSnapshot,
  readCanonicalProfile,
  resolveCanonicalProfile,
} from "./profileCanonicalD1.ts";
import type {
  ProfileOwnershipReader,
  ProfileOwnershipSnapshot,
} from "./profileOwnership.ts";

export type MiningProfile = {
  mining: MiningSnapshot;
  profileId: string;
  updateTime: string;
};

export type MiningRepository = ProfileOwnershipReader & {
  getProfileSnapshot: (profileId: string) => Promise<MiningProfile | null>;
  updateMining: (
    profileId: string,
    mining: MiningSnapshot,
    updateTime: string,
  ) => Promise<"conflict" | "updated">;
};

type MiningRepositoryDependencies = {
  d1?: D1Database;
  now?: () => number;
};

function canonicalRevision(value: string): number | null {
  const match = /^d1:(\d+)$/.exec(value);
  if (!match) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

async function readOwnershipSnapshot(
  db: D1Database,
  query: Parameters<ProfileOwnershipReader["readProfileOwnershipSnapshot"]>[0],
): Promise<ProfileOwnershipSnapshot> {
  const snapshot = await readCanonicalProfileOwnershipSnapshot(db, query);
  return Object.freeze({
    canonicalProfileIdByProfileId: new Map(
      snapshot.canonicalProfileIdByProfileId,
    ),
    loginOwnerByUid: new Map(snapshot.loginOwnerByUid),
    loginUidsByProfileId: new Map(
      [...snapshot.loginOwnersByProfileId].map(([profileId, owners]) => [
        profileId,
        Object.freeze(owners.map((owner) => owner.loginUid)),
      ]),
    ),
    profileById: new Map(
      [...snapshot.profileById].map(([profileId, value]) => [
        profileId,
        Object.freeze({
          profile: Object.freeze({
            aura: value.profile.aura || "",
            emoji: value.gameplayEmoji,
            eth: value.profile.eth || "",
            profileId,
            rating:
              value.sortPresence.rating && value.sortValues.rating !== null
                ? value.sortValues.rating
                : 1500,
            sol: value.profile.sol || "",
            username: value.profile.username || "",
          }),
          revision: value.revision,
        }),
      ]),
    ),
  });
}

export function createMiningRepository(
  env: Env,
  { d1 = env.PROFILE_DB, now = Date.now }: MiningRepositoryDependencies = {},
): MiningRepository {
  return {
    readProfileOwnershipSnapshot: (query) => readOwnershipSnapshot(d1, query),

    async getProfileSnapshot(profileId) {
      const profile = await resolveCanonicalProfile(d1, profileId);
      if (!profile || profile.state !== "active") return null;
      return {
        profileId: profile.profileId,
        mining: normalizeMiningSnapshot(profile.profile.mining),
        updateTime: `d1:${profile.revision}`,
      };
    },

    async updateMining(profileId, mining, updateTime) {
      const revision = canonicalRevision(updateTime);
      if (revision === null) return "conflict";
      const profile = await readCanonicalProfile(d1, profileId);
      if (
        !profile ||
        profile.state !== "active" ||
        profile.revision !== revision
      ) {
        return "conflict";
      }
      const sortPresence = {
        ...profile.sortPresence,
        ...Object.fromEntries(MATERIAL_KEYS.map((key) => [key, true])),
      };
      const sortValues = {
        ...profile.sortValues,
        ...Object.fromEntries(
          MATERIAL_KEYS.map((key) => [key, mining.materials[key]]),
        ),
      };
      const value = materializeCanonicalProfile({
        profile: { ...profile.profile, mining },
        state: profile.state,
        mergedIntoProfileId: profile.mergedIntoProfileId,
        legacyFields: profile.legacyFields,
        createdAtMs: profile.createdAtMs,
        updatedAtMs: now(),
        mergedAtMs: profile.mergedAtMs,
        sortPresence,
        sortValues,
        winPresent: profile.winPresent,
        emojiPresent: profile.emojiPresent,
        gameplayEmoji: profile.gameplayEmoji,
      });
      try {
        await commitCanonicalPlan(d1, {
          expectations: [{ kind: "profile-revision", profileId, revision }],
          mutations: [{ kind: "update-active-profile", value }],
        });
        return "updated";
      } catch (error) {
        if (error instanceof CanonicalProfileConflict) return "conflict";
        throw error;
      }
    },
  };
}
