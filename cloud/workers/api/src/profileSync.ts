import type { LinkedAuthMethodsResponse } from "@mons/shared/auth";
import { AuthApiFailure } from "./authErrors.ts";
import {
  createAuthIdentityService,
  type AuthIdentityService,
} from "./authIdentity.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import {
  createAuthProfileRepository,
  type AuthProfileRepository,
} from "./authProfileRepository.ts";
import {
  createProfileLinkCatchupStore,
  type ProfileLinkCatchupStore,
} from "./profileLinkCatchupD1.ts";

const MAX_RECONCILIATION_ATTEMPTS = 3;

export type ProfileSyncDependencies = {
  catchupStore?: Pick<ProfileLinkCatchupStore, "read" | "settleMissing">;
  logCleanupFailure?: (kind: string) => void;
  repository?: Pick<AuthProfileRepository, "getLinkedAuthMethods">;
  syncCurrentCallerProfile?: AuthIdentityService["syncCurrentCallerProfile"];
};

export async function syncProfile(
  identity: RequestIdentity,
  env: Env,
  dependencies: ProfileSyncDependencies = {},
): Promise<LinkedAuthMethodsResponse> {
  const repository =
    dependencies.repository || createAuthProfileRepository(env);
  const readSource = (): Promise<LinkedAuthMethodsResponse> =>
    repository.getLinkedAuthMethods(identity.uid);

  let source = await readSource();
  const logCleanupFailure =
    dependencies.logCleanupFailure ||
    ((kind: string) =>
      console.error(
        JSON.stringify({ event: "profile_sync_cleanup_failure", kind }),
      ));
  const syncCurrentCallerProfile =
    dependencies.syncCurrentCallerProfile ||
    createAuthIdentityService(env).syncCurrentCallerProfile;
  const catchupStore =
    dependencies.catchupStore || createProfileLinkCatchupStore(env.PROFILE_DB);

  const cleanupMissingProfile = async (): Promise<void> => {
    const catchup = await catchupStore.read(identity.uid);
    if (catchup) {
      await catchupStore.settleMissing(
        identity.uid,
        catchup.requestId,
        catchup.matchCursor,
      );
    }
  };

  for (let attempt = 0; attempt < MAX_RECONCILIATION_ATTEMPTS; attempt++) {
    if (source.profileId) {
      const verifiedSource = await readSource();
      if (verifiedSource.profileId === source.profileId) {
        return syncCurrentCallerProfile(identity.uid);
      }
      source = verifiedSource;
      continue;
    }
    try {
      await cleanupMissingProfile();
    } catch {
      logCleanupFailure("profile-sync-cleanup-unavailable");
    }

    const verifiedSource = await readSource();
    if (verifiedSource.profileId === null) {
      return verifiedSource;
    }
    source = verifiedSource;
  }

  if (source.profileId === null) {
    try {
      await cleanupMissingProfile();
    } catch {
      logCleanupFailure("profile-sync-cleanup-unavailable");
    }
  }
  throw new AuthApiFailure(409, "aborted", "profile-claim-source-unstable");
}
