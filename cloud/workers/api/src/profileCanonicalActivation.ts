import { ProfileWritesDisabledFailure } from "./authErrors.ts";
import { readCanonicalControl } from "./profileCanonicalD1.ts";

export async function profileBackgroundMutationsEnabled(
  env: Env,
): Promise<boolean> {
  try {
    return (await readCanonicalControl(env.PROFILE_DB)).state === "active";
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
