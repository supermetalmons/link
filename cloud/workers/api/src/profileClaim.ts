import type { LinkedAuthMethodsResponse } from "@mons/shared/auth";
import { AuthApiFailure } from "./authErrors.ts";
import { cleanString } from "./authPolicy.ts";
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
  createAuthRepository,
  type AuthRepository,
  LoginProfileConflict,
  type ProfileClaimSource,
} from "./firestore.ts";

const MAX_RECONCILIATION_ATTEMPTS = 3;

export type ProfileClaimDependencies = {
  authClient?: FirebaseAuthAdminClient;
  logCleanupFailure?: (kind: string) => void;
  repository?: Pick<AuthRepository, "getProfileClaimSource">;
  rtdbClient?: Pick<FirebaseRtdbClient, "getPath" | "patchRoot">;
  schedulePendingProfileRecovery?: (profileId: string) => void | Promise<void>;
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
  const repository = dependencies.repository || createAuthRepository(env);
  const readSource = async (): Promise<ProfileClaimSource> => {
    try {
      return await repository.getProfileClaimSource(
        identity.uid,
        identity.idToken,
      );
    } catch (error) {
      if (error instanceof LoginProfileConflict) {
        throw new AuthApiFailure(
          409,
          "failed-precondition",
          "login-profile-conflict",
        );
      }
      throw error;
    }
  };

  let source = await readSource();
  const authClient =
    dependencies.authClient || createFirebaseAuthAdminClient(env);
  const rtdbClient =
    dependencies.rtdbClient ||
    createFirebaseRtdbClient(env, {
      credentials: {
        email: env.FIRESTORE_SERVICE_ACCOUNT_EMAIL,
        privateKeyPem: env.FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY,
      },
    });
  const logCleanupFailure =
    dependencies.logCleanupFailure ||
    ((kind: string) =>
      console.error(
        JSON.stringify({ event: "profile_claim_cleanup_failure", kind }),
      ));

  const reconcile = async (current: ProfileClaimSource): Promise<void> => {
    const [user, profileLink] = await Promise.all([
      authClient.getUser(identity.uid),
      rtdbClient.getPath(`players/${identity.uid}/profile`),
    ]);
    const claims = { ...user.customClaims };
    const hasProfileClaim = Object.hasOwn(claims, "profileId");
    const writes: Promise<void>[] = [];

    if (current.profileId) {
      if (cleanString(profileLink) !== current.profileId) {
        writes.push(
          rtdbClient.patchRoot({
            [`players/${identity.uid}/profile`]: current.profileId,
          }),
        );
      }
      if (cleanString(claims.profileId) !== current.profileId) {
        writes.push(
          authClient.setCustomUserClaims(identity.uid, {
            ...claims,
            profileId: current.profileId,
          }),
        );
      }
    } else {
      if (profileLink !== null) {
        writes.push(
          rtdbClient.patchRoot({
            [`players/${identity.uid}/profile`]: null,
          }),
        );
      }
      if (hasProfileClaim) {
        delete claims.profileId;
        writes.push(authClient.setCustomUserClaims(identity.uid, claims));
      }
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
    let reconciliationFailed = false;
    let reconciliationFailure: unknown;
    try {
      await reconcile(source);
    } catch (error) {
      if (source.profileId) {
        reconciliationFailed = true;
        reconciliationFailure = error;
      } else {
        logCleanupFailure(cleanupFailureKind(error));
      }
    }

    const verifiedSource = await readSource();
    if (verifiedSource.profileId === source.profileId) {
      if (verifiedSource.profileId && verifiedSource.pendingRecovery) {
        await dependencies.schedulePendingProfileRecovery?.(
          verifiedSource.profileId,
        );
      }
      if (reconciliationFailed) {
        throw reconciliationFailure;
      }
      const { pendingRecovery: _pendingRecovery, ...response } = verifiedSource;
      return response;
    }
    source = verifiedSource;
  }

  try {
    await reconcile(source);
  } catch (error) {
    if (!source.profileId) {
      logCleanupFailure(cleanupFailureKind(error));
    }
  }
  if (source.profileId && source.pendingRecovery) {
    await dependencies.schedulePendingProfileRecovery?.(source.profileId);
  }
  throw new AuthApiFailure(409, "aborted", "profile-claim-source-unstable");
}
