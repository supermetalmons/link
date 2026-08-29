import {
  getLinkedAuthMethodsFromProfile,
  type LinkedAuthMethodsResponse,
} from "@mons/shared/auth";
import { readStableCanonicalProfileAggregateByLogin } from "./profileCanonicalD1.ts";

export type AuthProfileRepository = {
  getLinkedAuthMethods: (uid: string) => Promise<LinkedAuthMethodsResponse>;
  getProfileClaimSource: (uid: string) => Promise<ProfileClaimSource>;
};

export type ProfileClaimSource = LinkedAuthMethodsResponse;

export class AuthProfileRepositoryFailure extends Error {
  constructor() {
    super("profile-repository-unavailable");
  }
}

function createCanonicalAuthProfileRepository(
  db: D1Database,
): AuthProfileRepository {
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
      throw new AuthProfileRepositoryFailure();
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

export function createAuthProfileRepository(
  env: Env,
  dependencies: { d1?: D1Database } = {},
): AuthProfileRepository {
  return createCanonicalAuthProfileRepository(
    dependencies.d1 || env.PROFILE_DB,
  );
}
