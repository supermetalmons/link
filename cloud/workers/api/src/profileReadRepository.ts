import { createD1ProfileRepository } from "./profileD1.ts";
import {
  CANONICAL_PROFILE_REDIRECT_LIMIT,
  readCanonicalLeaderboard,
  readCanonicalPublicProfileByLogin,
  resolveCanonicalPublicProfile,
} from "./profileCanonicalD1.ts";
import {
  createProfileRepository,
  ProfileRepositoryFailure,
  type ProfileRepository,
} from "./profileRepository.ts";
import {
  profileStorageUsesD1,
  readProfileStorageMode,
  type ProfileStorageMode,
} from "./profileStorageMode.ts";

export type ProfileReadMode = "d1" | "firestore";

function readMode(value: string): ProfileReadMode {
  if (value === "d1" || value === "firestore") {
    return value;
  }
  throw new ProfileRepositoryFailure();
}
export function createConfiguredProfileRepository(
  env: Env,
  dependencies: {
    canonical?: ProfileRepository;
    d1?: ProfileRepository;
    firestore?: ProfileRepository;
    mode?: ProfileReadMode;
    storageMode?: ProfileStorageMode;
  } = {},
): ProfileRepository {
  const storageMode = dependencies.storageMode || readProfileStorageMode(env);
  if (profileStorageUsesD1(storageMode)) {
    return (
      dependencies.canonical || {
        async getProfileById(profileId) {
          return (
            (
              await resolveCanonicalPublicProfile(
                env.PROFILE_DB,
                profileId,
                CANONICAL_PROFILE_REDIRECT_LIMIT,
                "null",
              )
            )?.profile ?? null
          );
        },
        async getProfileByLoginId(loginId) {
          return (
            (await readCanonicalPublicProfileByLogin(env.PROFILE_DB, loginId))
              ?.profile ?? null
          );
        },
        readLeaderboard: (type) =>
          readCanonicalLeaderboard(env.PROFILE_DB, type),
      }
    );
  }
  const mode = dependencies.mode || readMode(env.PROFILE_READ_MODE);
  if (mode === "firestore") {
    return dependencies.firestore || createProfileRepository();
  }
  return dependencies.d1 || createD1ProfileRepository(env.PROFILE_DB);
}
