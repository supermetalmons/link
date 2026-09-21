import {
  getLinkedAuthMethodsFromProfile,
  type LinkedAuthMethodsResponse,
} from "@mons/shared/auth";
import type { ProfileLookupResponse } from "@mons/shared/profiles";
import { AuthApiFailure } from "./authErrors.ts";
import { hasValidUsername } from "./authIdentityCanonical/policy.ts";
import { readCanonicalAuthProfileByLogin } from "./profileCanonical/authProfile.ts";

export type AuthProfileRepository = {
  getLinkedAuthMethods: (uid: string) => Promise<LinkedAuthMethodsResponse>;
};

export class AuthProfileRepositoryFailure extends Error {
  constructor() {
    super("profile-repository-unavailable");
  }
}

export async function readAuthIdentityProfile(
  db: D1Database,
  uid: string,
): Promise<ProfileLookupResponse> {
  const snapshot = await readCanonicalAuthProfileByLogin(db, uid);
  if (!snapshot) return { ok: true, profile: null };
  const methods = new Set(snapshot.authMethods.map((method) => method.method));
  if (
    (methods.has("apple") || methods.has("x")) &&
    !hasValidUsername(snapshot.profile.profile.username) &&
    !methods.has("eth") &&
    !methods.has("sol")
  ) {
    throw new AuthApiFailure(
      409,
      "failed-precondition",
      "profile-repair-required",
    );
  }
  return { ok: true, profile: snapshot.profile.profile };
}

function createCanonicalAuthProfileRepository(
  db: D1Database,
): AuthProfileRepository {
  const linkedMethodsResponse = async (
    uid: string,
  ): Promise<LinkedAuthMethodsResponse> => {
    const resolved = await readCanonicalAuthProfileByLogin(db, uid);
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
    const methodValues = Object.fromEntries(
      resolved.authMethods.map((method) => [method.method, method.rawValue]),
    );
    const linkedMethods = getLinkedAuthMethodsFromProfile({
      appleSub: methodValues.apple,
      eth: methodValues.eth,
      sol: methodValues.sol,
      xUserId: methodValues.x,
    });
    return {
      ok: true,
      profileId: resolved.profile.profileId,
      linkedMethods,
      appleLinked: linkedMethods.apple,
    };
  };
  return {
    getLinkedAuthMethods: (uid) => linkedMethodsResponse(uid),
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
