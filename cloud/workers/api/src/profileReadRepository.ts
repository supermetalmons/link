import { createD1ProfileRepository } from "./profileD1.ts";
import {
  createProfileRepository,
  ProfileRepositoryFailure,
  type ProfileRepository,
} from "./profileRepository.ts";

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
    d1?: ProfileRepository;
    firestore?: ProfileRepository;
    mode?: ProfileReadMode;
  } = {},
): ProfileRepository {
  const mode = dependencies.mode || readMode(env.PROFILE_READ_MODE);
  if (mode === "firestore") {
    return dependencies.firestore || createProfileRepository();
  }
  return dependencies.d1 || createD1ProfileRepository(env.PROFILE_DB);
}
