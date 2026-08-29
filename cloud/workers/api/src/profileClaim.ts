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
import type { FirebaseIdentity } from "./firebaseAuth.ts";
import {
  createFirebaseRtdbClient,
  FirebaseRtdbFailure,
  type FirebaseRtdbClient,
} from "./firebaseRtdb.ts";
import {
  createAuthProfileRepository,
  type AuthProfileRepository,
  type ProfileClaimSource,
} from "./authProfileRepository.ts";
import { getProfileLinkProfileGameProjectionOutboxPath } from "./profileGameProjectionOutbox.ts";

const MAX_RECONCILIATION_ATTEMPTS = 3;

export type ProfileClaimDependencies = {
  authClient?: FirebaseAuthAdminClient;
  logCleanupFailure?: (kind: string) => void;
  repository?: Pick<AuthProfileRepository, "getProfileClaimSource">;
  rtdbClient?: Pick<FirebaseRtdbClient, "getPath" | "patchRoot">;
  syncCurrentCallerProfile?: AuthIdentityService["syncCurrentCallerProfile"];
};

function cleanupFailureKind(error: unknown): string {
  if (error instanceof FirebaseAuthAdminFailure) {
    return "firebase-auth-unavailable";
  }
  if (error instanceof FirebaseRtdbFailure) {
    return "firebase-rtdb-unavailable";
  }
  return "profile-claim-cleanup-unavailable";
}

export async function syncProfileClaim(
  identity: FirebaseIdentity,
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
  const rtdbClient =
    dependencies.rtdbClient ||
    createFirebaseRtdbClient(env, {
      credentials: {
        email: env.FIREBASE_IDENTITY_SERVICE_ACCOUNT_EMAIL,
        privateKeyPem: env.FIREBASE_IDENTITY_SERVICE_ACCOUNT_PRIVATE_KEY,
      },
    });
  const logCleanupFailure =
    dependencies.logCleanupFailure ||
    ((kind: string) =>
      console.error(
        JSON.stringify({ event: "profile_claim_cleanup_failure", kind }),
      ));
  const syncCurrentCallerProfile =
    dependencies.syncCurrentCallerProfile ||
    createAuthIdentityService(env).syncCurrentCallerProfile;

  const cleanupMissingProfile = async (): Promise<void> => {
    const [user, profileLink] = await Promise.all([
      authClient.getUser(identity.uid),
      rtdbClient.getPath(`players/${identity.uid}/profile`),
    ]);
    const claims = { ...user.customClaims };
    const hasProfileClaim = Object.hasOwn(claims, "profileId");
    const writes: Promise<void>[] = [];

    if (profileLink !== null) {
      writes.push(
        rtdbClient.patchRoot({
          [`players/${identity.uid}/profile`]: null,
          [getProfileLinkProfileGameProjectionOutboxPath(identity.uid)]: null,
        }),
      );
    }
    if (hasProfileClaim) {
      delete claims.profileId;
      writes.push(authClient.setCustomUserClaims(identity.uid, claims));
    }

    const outcomes = await Promise.allSettled(writes);
    const failure = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    if (failure) {
      throw failure.reason;
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
