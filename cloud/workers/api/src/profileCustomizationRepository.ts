import type { ProfileCustomizationUpdateRequest } from "@mons/shared/profiles";
import {
  CanonicalProfileConflict,
  type CanonicalProfileSnapshot,
} from "./profileCanonicalD1.ts";
import {
  commitCanonicalProfileUpdate,
  materializeCanonicalProfileUpdate,
  readCanonicalProfileMutationByLogin,
} from "./profileMutationD1.ts";

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

export function createProfileCustomizationRepository(
  env: Env,
  {
    d1 = env.PROFILE_DB,
    now = Date.now,
  }: { d1?: D1Database; now?: () => number; signal?: AbortSignal } = {},
): ProfileCustomizationRepository {
  return {
    async updateCustomization(uid, request, authorize) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const resolved = await readCanonicalProfileMutationByLogin(d1, uid);
          if (!resolved) return "profile-not-found";
          const owner = resolved.owner;
          const profile = resolved.profile;
          await authorize({
            documentName: profile.profileId,
            eth: profile.profile.eth || "",
            sol: profile.profile.sol || "",
          });
          const value = materializeCanonicalProfileUpdate(
            profile,
            customizedProfile(profile, request),
            now(),
            request.field === "emojiAndAura"
              ? { emojiPresent: true, gameplayEmoji: request.value.emoji }
              : {},
          );
          await commitCanonicalProfileUpdate(d1, profile, value, { owner });
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
