import type { LinkedAuthMethodsResponse } from "@mons/shared/auth";
import { AuthApiFailure } from "./authErrors.ts";
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
} from "./firestore.ts";

export type ProfileClaimDependencies = {
  authClient?: FirebaseAuthAdminClient;
  logCleanupFailure?: (kind: string) => void;
  repository?: Pick<AuthRepository, "getProfileClaimSource">;
  rtdbClient?: Pick<FirebaseRtdbClient, "getPath" | "patchRoot">;
};

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

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
  let source: LinkedAuthMethodsResponse;
  try {
    source = await repository.getProfileClaimSource(
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

  const reconcile = async (): Promise<void> => {
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
    const [user, profileLink] = await Promise.all([
      authClient.getUser(identity.uid),
      rtdbClient.getPath(`players/${identity.uid}/profile`),
    ]);
    const claims = { ...user.customClaims };
    const hasProfileClaim = Object.hasOwn(claims, "profileId");
    const writes: Promise<void>[] = [];

    if (source.profileId) {
      if (cleanString(profileLink) !== source.profileId) {
        writes.push(
          rtdbClient.patchRoot({
            [`players/${identity.uid}/profile`]: source.profileId,
          }),
        );
      }
      if (cleanString(claims.profileId) !== source.profileId) {
        writes.push(
          authClient.setCustomUserClaims(identity.uid, {
            ...claims,
            profileId: source.profileId,
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

    await Promise.all(writes);
  };

  if (source.profileId) {
    await reconcile();
  } else {
    try {
      await reconcile();
    } catch (error) {
      (
        dependencies.logCleanupFailure ||
        ((kind) =>
          console.error(
            JSON.stringify({ event: "profile_claim_cleanup_failure", kind }),
          ))
      )(cleanupFailureKind(error));
    }
  }

  return source;
}
