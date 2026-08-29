import type { ProfileCustomizationUpdateRequest } from "@mons/shared/profiles";
import {
  authFieldFilter,
  authUpdateWrite,
  createAuthFirestoreClient,
  type AuthFirestoreClient,
} from "./authFirestore.ts";
import {
  CanonicalProfileConflict,
  commitCanonicalPlan,
  materializeCanonicalProfile,
  readStableCanonicalProfileAggregateByLogin,
  type CanonicalProfileSnapshot,
} from "./profileCanonicalD1.ts";
import {
  profileStorageUsesD1,
  readProfileStorageMode,
} from "./profileStorageMode.ts";

export type ProfileCustomizationProfile = {
  documentName: string;
  eth: string;
  sol: string;
};

export type ProfileCustomizationUpdateOutcome =
  "updated" | "profile-not-found" | "login-profile-conflict";

export type ProfileCustomizationRepository = {
  updateCustomization: (
    uid: string,
    request: ProfileCustomizationUpdateRequest,
    authorize: (profile: ProfileCustomizationProfile) => Promise<void>,
  ) => Promise<ProfileCustomizationUpdateOutcome>;
};

function profileFromDocument(
  document: Awaited<ReturnType<AuthFirestoreClient["query"]>>[number],
): ProfileCustomizationProfile {
  return {
    documentName: document.name,
    eth: typeof document.fields.eth === "string" ? document.fields.eth : "",
    sol: typeof document.fields.sol === "string" ? document.fields.sol : "",
  };
}

function customizationWrite(
  documentName: string,
  request: ProfileCustomizationUpdateRequest,
) {
  if (request.field === "emojiAndAura") {
    return authUpdateWrite(
      documentName,
      {
        custom: {
          emoji: request.value.emoji,
          aura: request.value.aura,
        },
      },
      ["custom.emoji", "custom.aura"],
    );
  }
  return authUpdateWrite(
    documentName,
    { custom: { [request.field]: request.value } },
    [`custom.${request.field}`],
  );
}

function createFirestoreProfileCustomizationRepository(
  env: Env,
  dependencies: {
    firestore?: AuthFirestoreClient;
    projectionCommitted?: (profileId: string) => Promise<void> | void;
    signal?: AbortSignal;
  } = {},
): ProfileCustomizationRepository {
  const firestore =
    dependencies.firestore ||
    createAuthFirestoreClient(env, {
      signal: dependencies.signal,
      profileProjectionCommitted: dependencies.projectionCommitted,
    });
  return {
    async updateCustomization(uid, request, authorize) {
      return firestore.runTransaction(async (transaction) => {
        const profiles = await transaction.query(
          "users",
          authFieldFilter("logins", "ARRAY_CONTAINS", uid),
          2,
          ["logins", "sol", "eth", "mergedIntoProfileId"],
        );
        if (profiles.length === 0) {
          return {
            result: "profile-not-found" as const,
            writes: [],
          };
        }
        if (
          profiles.length > 1 ||
          (typeof profiles[0].fields.mergedIntoProfileId === "string" &&
            profiles[0].fields.mergedIntoProfileId.trim())
        ) {
          return {
            result: "login-profile-conflict" as const,
            writes: [],
          };
        }
        const profile = profileFromDocument(profiles[0]);
        await authorize(profile);
        return {
          result: "updated" as const,
          writes: [customizationWrite(profile.documentName, request)],
        };
      });
    },
  };
}

function customizedProfile(
  profile: CanonicalProfileSnapshot,
  request: ProfileCustomizationUpdateRequest,
) {
  if (request.field === "emojiAndAura") {
    return {
      ...profile.profile,
      emoji: request.value.emoji,
      aura: request.value.aura,
    };
  }
  if (request.field === "completedProblems") {
    return { ...profile.profile, completedProblemIds: request.value };
  }
  if (request.field === "tutorialCompleted") {
    return { ...profile.profile, isTutorialCompleted: request.value };
  }
  return { ...profile.profile, [request.field]: request.value };
}

function createCanonicalProfileCustomizationRepository(
  env: Env,
): ProfileCustomizationRepository {
  return {
    async updateCustomization(uid, request, authorize) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const resolved = await readStableCanonicalProfileAggregateByLogin(
            env.PROFILE_DB,
            uid,
          );
          if (!resolved) return "profile-not-found";
          const owner = resolved.owner;
          const profile = resolved.aggregate.profile;
          if (!profile) throw new CanonicalProfileConflict();
          await authorize({
            documentName: profile.profileId,
            eth: profile.profile.eth || "",
            sol: profile.profile.sol || "",
          });
          const value = materializeCanonicalProfile({
            profile: customizedProfile(profile, request),
            state: profile.state,
            mergedIntoProfileId: profile.mergedIntoProfileId,
            legacyFields: profile.legacyFields,
            createdAtMs: profile.createdAtMs,
            updatedAtMs: Date.now(),
            mergedAtMs: profile.mergedAtMs,
            sortPresence: profile.sortPresence,
            sortValues: profile.sortValues,
            winPresent: profile.winPresent,
            emojiPresent:
              request.field === "emojiAndAura" ? true : profile.emojiPresent,
            gameplayEmoji:
              request.field === "emojiAndAura"
                ? request.value.emoji
                : profile.gameplayEmoji,
          });
          await commitCanonicalPlan(env.PROFILE_DB, {
            expectations: [
              {
                kind: "profile-revision",
                profileId: profile.profileId,
                revision: profile.revision,
              },
              {
                kind: "login-owner-revision",
                loginUid: uid,
                profileId: owner.profileId,
                revision: owner.revision,
              },
            ],
            mutations: [{ kind: "update-active-profile", value }],
          });
          return "updated";
        } catch (error) {
          if (error instanceof CanonicalProfileConflict && attempt < 4) {
            continue;
          }
          throw error;
        }
      }
      throw new CanonicalProfileConflict();
    },
  };
}

export function createProfileCustomizationRepository(
  env: Env,
  dependencies: {
    firestore?: AuthFirestoreClient;
    projectionCommitted?: (profileId: string) => Promise<void> | void;
    signal?: AbortSignal;
  } = {},
): ProfileCustomizationRepository {
  if (
    !dependencies.firestore &&
    profileStorageUsesD1(readProfileStorageMode(env))
  ) {
    return createCanonicalProfileCustomizationRepository(env);
  }
  return createFirestoreProfileCustomizationRepository(env, dependencies);
}

export { customizationWrite, profileFromDocument };
