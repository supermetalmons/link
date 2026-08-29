import {
  MATERIAL_KEYS,
  normalizeMiningSnapshot,
  type MiningSnapshot,
} from "@mons/shared/mining";
import {
  CanonicalProfileConflict,
  commitCanonicalPlan,
  materializeCanonicalProfile,
  readCanonicalLoginOwner,
  readCanonicalProfile,
  resolveCanonicalProfile,
} from "./profileCanonicalD1.ts";

export type MiningProfile = {
  mining: MiningSnapshot;
  profileId: string;
  updateTime: string;
};

export type MiningRepository = {
  getProfile: (
    uid: string,
    firebaseIdToken: string,
  ) => Promise<MiningProfile | null>;
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

export function createMiningRepository(
  env: Env,
  { d1 = env.PROFILE_DB, now = Date.now }: MiningRepositoryDependencies = {},
): MiningRepository {
  return {
    async getProfile(uid) {
      const owner = await readCanonicalLoginOwner(d1, uid);
      if (!owner) return null;
      const profile = await resolveCanonicalProfile(d1, owner.profileId);
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
