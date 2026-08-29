import type { ProfileCustomizationUpdateRequest } from "@mons/shared/profiles";
import {
  CanonicalProfileConflict,
  commitCanonicalPlan,
  materializeCanonicalProfile,
  readStableCanonicalProfileAggregateByLogin,
  type CanonicalProfileSnapshot,
} from "./profileCanonicalD1.ts";

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
          const resolved = await readStableCanonicalProfileAggregateByLogin(
            d1,
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
            updatedAtMs: now(),
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
          await commitCanonicalPlan(d1, {
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
