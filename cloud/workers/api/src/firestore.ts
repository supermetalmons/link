import {
  getLinkedAuthMethodsFromProfile,
  type LinkedAuthMethodsResponse,
} from "@mons/shared/auth";
import { readStableCanonicalProfileAggregateByLogin } from "./profileCanonicalD1.ts";

export type AuthRepository = {
  getLinkedAuthMethods: (
    uid: string,
    firebaseIdToken: string,
  ) => Promise<LinkedAuthMethodsResponse>;
  getProfileClaimSource: (
    uid: string,
    firebaseIdToken: string,
  ) => Promise<ProfileClaimSource>;
};

export type ProfileClaimSource = LinkedAuthMethodsResponse;

export class FirestoreFailure extends Error {
  constructor() {
    super("profile-repository-unavailable");
  }
}

export class LoginProfileConflict extends Error {
  constructor() {
    super("login-profile-conflict");
  }
}

function createCanonicalAuthRepository(db: D1Database): AuthRepository {
  const linkedMethodsResponse = async (
    uid: string,
  ): Promise<LinkedAuthMethodsResponse> => {
    const resolved = await readStableCanonicalProfileAggregateByLogin(db, uid);
    if (!resolved) {
      const linkedMethods = {
        apple: false,
        eth: false,
        sol: false,
        x: false,
      };
      return {
        ok: true,
        profileId: null,
        linkedMethods,
        appleLinked: false,
      };
    }
    const aggregate = resolved.aggregate;
    const profile = aggregate.profile;
    if (!profile || resolved.owner.profileId !== profile.profileId) {
      throw new FirestoreFailure();
    }
    const methodValues = Object.fromEntries(
      aggregate.authMethods.map((method) => [method.method, method.rawValue]),
    );
    const linkedMethods = getLinkedAuthMethodsFromProfile({
      appleSub: methodValues.apple,
      eth: methodValues.eth,
      sol: methodValues.sol,
      xUserId: methodValues.x,
    });
    return {
      ok: true,
      profileId: profile.profileId,
      linkedMethods,
      appleLinked: linkedMethods.apple,
    };
  };
  return {
    getLinkedAuthMethods: (uid) => linkedMethodsResponse(uid),
    getProfileClaimSource: (uid) => linkedMethodsResponse(uid),
  };
}

export function createAuthRepository(
  env: Env,
  dependencies: { d1?: D1Database } = {},
): AuthRepository {
  return createCanonicalAuthRepository(dependencies.d1 || env.PROFILE_DB);
}
