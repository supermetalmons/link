import { buildUsernameLookupKey } from "@mons/shared/usernames";
import { runConflictRetry } from "./conflictRetry.ts";
import { CanonicalProfileConflict } from "./profileCanonicalD1.ts";
import { readCanonicalAuthProfileByLogin } from "./profileCanonical/authProfile.ts";
import {
  buildMutableProfileMutation,
  commitMutableProfileUpdate,
  readMutableProfileMutationByLogin,
} from "./profileMutableD1.ts";

const MAX_TRANSACTION_ATTEMPTS = 5;

export type UsernameEditOutcome =
  "cannot-clear" | "profile-not-found" | "taken" | "updated";

export type UsernameRepository = {
  editUsername: (uid: string, username: string) => Promise<UsernameEditOutcome>;
};

type UsernameRepositoryDependencies = {
  d1?: D1Database;
  maxTransactionAttempts?: number;
  now?: () => number;
};

export class UsernameRepositoryFailure extends Error {
  constructor() {
    super("username-repository-unavailable");
  }
}

type CanonicalUsernameOwnerRow = {
  profile_id: string;
};

export function createUsernameRepository(
  env: Env,
  {
    d1 = env.PROFILE_DB,
    maxTransactionAttempts = MAX_TRANSACTION_ATTEMPTS,
    now = Date.now,
  }: UsernameRepositoryDependencies = {},
): UsernameRepository {
  const attempts =
    Number.isInteger(maxTransactionAttempts) &&
    Number(maxTransactionAttempts) > 0
      ? Number(maxTransactionAttempts)
      : MAX_TRANSACTION_ATTEMPTS;
  return {
    async editUsername(uid, username) {
      const loginUid = uid.trim();
      const nextUsername = username.trim();
      if (!loginUid) {
        throw new UsernameRepositoryFailure();
      }
      const updatedAtMs = now();
      return runConflictRetry<UsernameEditOutcome>({
        maxAttempts: attempts,
        async attempt() {
          try {
            const authSnapshot = nextUsername
              ? null
              : await readCanonicalAuthProfileByLogin(d1, loginUid);
            const resolved = nextUsername
              ? await readMutableProfileMutationByLogin(d1, loginUid)
              : authSnapshot;
            if (!resolved) return { value: "profile-not-found" };
            const { owner, profile } = resolved;
            const currentUsername = profile.profile.username || "";
            if (currentUsername === nextUsername) return { value: "updated" };
            if (!nextUsername) {
              if (!authSnapshot) throw new UsernameRepositoryFailure();
              const methods = new Set(
                authSnapshot.authMethods.map((method) => method.method),
              );
              if (
                (methods.has("apple") || methods.has("x")) &&
                !methods.has("eth") &&
                !methods.has("sol")
              ) {
                return { value: "cannot-clear" };
              }
            }
            const usernameKey = nextUsername
              ? buildUsernameLookupKey(nextUsername)
              : "";
            let usernameOwnedByProfile = false;
            if (usernameKey) {
              const existing = await d1
                .prepare(
                  "SELECT profile_id FROM profile_records_canonical WHERE username_key = ?",
                )
                .bind(usernameKey)
                .first<CanonicalUsernameOwnerRow>();
              if (existing && existing.profile_id !== profile.profileId) {
                return { value: "taken" };
              }
              usernameOwnedByProfile =
                existing?.profile_id === profile.profileId;
            }
            const mutation = buildMutableProfileMutation(
              profile,
              {
                ...profile.profile,
                username: nextUsername || null,
              },
              updatedAtMs,
            );
            await commitMutableProfileUpdate(d1, mutation, {
              owner,
              additionalExpectations: usernameKey
                ? usernameOwnedByProfile
                  ? ([
                      {
                        kind: "username-owner",
                        usernameKey,
                        profileId: profile.profileId,
                        revision: profile.revision,
                      },
                    ] as const)
                  : ([{ kind: "username-absent", usernameKey }] as const)
                : [],
            });
            return { value: "updated" };
          } catch (error) {
            if (error instanceof CanonicalProfileConflict) {
              return { conflict: error };
            }
            throw new UsernameRepositoryFailure();
          }
        },
        exhausted: () => new UsernameRepositoryFailure(),
      });
    },
  };
}
