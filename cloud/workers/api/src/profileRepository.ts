import type {
  CompletePlayerProfile,
  LeaderboardReadType,
} from "@mons/shared/profiles";
import {
  CANONICAL_PROFILE_REDIRECT_LIMIT,
  readCanonicalLeaderboard,
  readCanonicalPublicProfileByLogin,
  resolveCanonicalPublicProfile,
} from "./profileCanonicalD1.ts";

export type ProfileRepository = {
  getProfileById: (profileId: string) => Promise<CompletePlayerProfile | null>;
  getProfileByLoginId: (
    loginId: string,
  ) => Promise<CompletePlayerProfile | null>;
  readLeaderboard: (
    type: LeaderboardReadType,
  ) => Promise<CompletePlayerProfile[]>;
};

export function createProfileRepository(
  env: Env,
  dependencies: {
    canonical?: ProfileRepository;
    profileDb?: D1Database;
  } = {},
): ProfileRepository {
  if (dependencies.canonical) return dependencies.canonical;
  const db = dependencies.profileDb || env.PROFILE_DB;
  return {
    async getProfileById(profileId) {
      return (
        (
          await resolveCanonicalPublicProfile(
            db,
            profileId,
            CANONICAL_PROFILE_REDIRECT_LIMIT,
            "null",
          )
        )?.profile ?? null
      );
    },
    async getProfileByLoginId(loginId) {
      return (
        (await readCanonicalPublicProfileByLogin(db, loginId))?.profile ?? null
      );
    },
    readLeaderboard: (type) => readCanonicalLeaderboard(db, type),
  };
}
