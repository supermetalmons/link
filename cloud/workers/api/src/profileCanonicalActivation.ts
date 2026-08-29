import { ProfileWritesDisabledFailure } from "./authErrors.ts";
import { readCanonicalControl } from "./profileCanonicalD1.ts";
import { readProfileStorageMode } from "./profileStorageMode.ts";

export async function profileBackgroundMutationsEnabled(
  env: Env,
): Promise<boolean> {
  try {
    if (readProfileStorageMode(env) !== "firestore") return false;
    return (await readCanonicalControl(env.PROFILE_DB)).state === "firestore";
  } catch {
    return false;
  }
}

export async function assertProfileBackgroundMutationsEnabled(
  env: Env,
): Promise<void> {
  if (!(await profileBackgroundMutationsEnabled(env))) {
    throw new ProfileWritesDisabledFailure();
  }
}

export async function assertProfileMutationAllowed(env: Env): Promise<void> {
  await assertProfileBackgroundMutationsEnabled(env);
}
