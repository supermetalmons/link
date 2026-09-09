import type { LinkedAuthMethodsResponse } from "@mons/shared/auth";
import { AuthApiFailure } from "./authErrors.ts";
import {
  createAuthIdentityService,
  type AuthIdentityService,
} from "./authIdentity.ts";
import {
  createFirebaseAuthAdminClient,
  FirebaseAuthAdminFailure,
  type FirebaseAuthAdminClient,
} from "./firebaseAuthAdmin.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import {
  createAuthProfileRepository,
  type AuthProfileRepository,
  type ProfileClaimSource,
} from "./authProfileRepository.ts";
import {
  createProfileLinkCatchupStore,
  type ProfileLinkCatchupStore,
} from "./profileLinkCatchupD1.ts";

const MAX_RECONCILIATION_ATTEMPTS = 3;

export type ProfileClaimDependencies = {
  authClient?: FirebaseAuthAdminClient;
  catchupStore?: Pick<ProfileLinkCatchupStore, "read" | "settleMissing">;
  logCleanupFailure?: (kind: string) => void;
  repository?: Pick<AuthProfileRepository, "getProfileClaimSource">;
  syncCurrentCallerProfile?: AuthIdentityService["syncCurrentCallerProfile"];
};

function cleanupFailureKind(error: unknown): string {
  if (error instanceof FirebaseAuthAdminFailure) {
    return "firebase-auth-unavailable";
  }
  return "profile-claim-cleanup-unavailable";
}

export async function syncProfileClaim(
  identity: RequestIdentity,
  env: Env,
  dependencies: ProfileClaimDependencies = {},
): Promise<LinkedAuthMethodsResponse> {
  const repository =
    dependencies.repository || createAuthProfileRepository(env);
  const readSource = (): Promise<ProfileClaimSource> =>
    repository.getProfileClaimSource(identity.uid);

  let source = await readSource();
  const authClient =
    dependencies.authClient || createFirebaseAuthAdminClient(env);
  const logCleanupFailure =
    dependencies.logCleanupFailure ||
    ((kind: string) =>
      console.error(
        JSON.stringify({ event: "profile_claim_cleanup_failure", kind }),
      ));
  const syncCurrentCallerProfile =
    dependencies.syncCurrentCallerProfile ||
    createAuthIdentityService(env).syncCurrentCallerProfile;
  const catchupStore =
    dependencies.catchupStore || createProfileLinkCatchupStore(env.PROFILE_DB);

  const cleanupMissingProfile = async (): Promise<void> => {
    const [user, catchup] = await Promise.all([
      authClient.getUser(identity.uid),
      catchupStore.read(identity.uid),
    ]);
    if (catchup) {
      await catchupStore.settleMissing(
        identity.uid,
        catchup.requestId,
        catchup.matchCursor,
      );
    }
    const claims = { ...user.customClaims };
    if (Object.hasOwn(claims, "profileId")) {
      delete claims.profileId;
      await authClient.setCustomUserClaims(identity.uid, claims);
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
    } catch (error) {
      logCleanupFailure(cleanupFailureKind(error));
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
    } catch (error) {
      logCleanupFailure(cleanupFailureKind(error));
    }
  }
  throw new AuthApiFailure(409, "aborted", "profile-claim-source-unstable");
}
