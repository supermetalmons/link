import {
  MATERIAL_KEYS,
  parseMiningSnapshot,
  type MiningSnapshot,
} from "@mons/shared/mining";
import {
  CanonicalProfileConflict,
  commitCanonicalPlan,
} from "./profileCanonicalD1.ts";
import {
  buildMutableProfileMutation,
  readMutableProfileMutationByLogin,
} from "./profileMutableD1.ts";

export type MiningProfile = {
  readonly mining: MiningSnapshot;
  readonly profileId: string;
  commitMining: (mining: MiningSnapshot) => Promise<"conflict" | "updated">;
};

export type MiningRepository = {
  getOwnedProfileSnapshot: (loginUid: string) => Promise<MiningProfile | null>;
};

type MiningRepositoryDependencies = {
  d1?: D1Database;
  now?: () => number;
};

export function createMiningRepository(
  env: Env,
  { d1 = env.PROFILE_DB, now = Date.now }: MiningRepositoryDependencies = {},
): MiningRepository {
  return {
    async getOwnedProfileSnapshot(loginUid) {
      const snapshot = await readMutableProfileMutationByLogin(d1, loginUid);
      if (!snapshot) return null;
      const { owner, profile } = snapshot;
      const mining = parseMiningSnapshot(profile.profile.mining);
      if (!mining) throw new TypeError("invalid-mining-snapshot");
      return {
        profileId: profile.profileId,
        mining,
        async commitMining(mining) {
          const mutation = buildMutableProfileMutation(
            profile,
            { ...profile.profile, mining },
            now(),
            {
              sortUpdates: Object.fromEntries(
                MATERIAL_KEYS.map((key) => [key, mining.materials[key]]),
              ),
            },
          );
          try {
            await commitCanonicalPlan(d1, {
              expectations: [
                {
                  kind: "profile-revision",
                  profileId: profile.profileId,
                  revision: profile.revision,
                },
                {
                  kind: "login-owner-revision",
                  loginUid: owner.loginUid,
                  profileId: owner.profileId,
                  revision: owner.revision,
                },
              ],
              mutations: [mutation],
            });
            return "updated";
          } catch (error) {
            if (error instanceof CanonicalProfileConflict) return "conflict";
            throw error;
          }
        },
      };
    },
  };
}
