import { buildUsernameLookupKey } from "@mons/shared/usernames";
import {
  CanonicalProfileConflict,
  commitCanonicalPlan,
  materializeCanonicalProfile,
  readStableCanonicalProfileAggregateByLogin,
} from "./profileCanonicalD1.ts";

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
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const resolved = await readStableCanonicalProfileAggregateByLogin(
            d1,
            loginUid,
          );
          if (!resolved) return "profile-not-found";
          const owner = resolved.owner;
          const aggregate = resolved.aggregate;
          const profile = aggregate.profile;
          if (!profile) throw new UsernameRepositoryFailure();
          const currentUsername = profile.profile.username || "";
          if (currentUsername === nextUsername) return "updated";
          if (!nextUsername) {
            const methods = new Set(
              aggregate.authMethods.map((method) => method.method),
            );
            if (
              (methods.has("apple") || methods.has("x")) &&
              !methods.has("eth") &&
              !methods.has("sol")
            ) {
              return "cannot-clear";
            }
          }
          const usernameKey = nextUsername
            ? buildUsernameLookupKey(nextUsername)
            : "";
          let usernameOwnedByProfile = false;
          if (usernameKey) {
            const existing = await d1
              .prepare(
                "SELECT profile_id FROM profile_records WHERE username_key = ?",
              )
              .bind(usernameKey)
              .first<CanonicalUsernameOwnerRow>();
            if (existing && existing.profile_id !== profile.profileId) {
              return "taken";
            }
            usernameOwnedByProfile = existing?.profile_id === profile.profileId;
          }
          const nextProfile = materializeCanonicalProfile({
            profile: {
              ...profile.profile,
              username: nextUsername || null,
            },
            state: profile.state,
            mergedIntoProfileId: profile.mergedIntoProfileId,
            legacyFields: profile.legacyFields,
            createdAtMs: profile.createdAtMs,
            updatedAtMs,
            mergedAtMs: profile.mergedAtMs,
            sortPresence: profile.sortPresence,
            sortValues: profile.sortValues,
            winPresent: profile.winPresent,
            emojiPresent: profile.emojiPresent,
            gameplayEmoji: profile.gameplayEmoji,
          });
          await commitCanonicalPlan(d1, {
            expectations: [
              {
                kind: "profile-revision",
                profileId: profile.profileId,
                revision: profile.revision,
              },
              {
                kind: "login-owner-revision",
                loginUid,
                profileId: owner.profileId,
                revision: owner.revision,
              },
              ...(usernameKey
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
                : []),
            ],
            mutations: [{ kind: "update-active-profile", value: nextProfile }],
          });
          return "updated";
        } catch (error) {
          if (error instanceof CanonicalProfileConflict) {
            if (attempt < attempts - 1) continue;
          }
          throw new UsernameRepositoryFailure();
        }
      }
      throw new UsernameRepositoryFailure();
    },
  };
}
