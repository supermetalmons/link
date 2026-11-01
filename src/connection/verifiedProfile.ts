import type { PlayerProfile } from "./connectionModels";
import { connection } from "./connection";
import { setupLoggedInPlayerProfile } from "../game/board";
import { syncTutorialProgress } from "../content/problems";
import { storage } from "../utils/storage";
import { createProfileCosmeticWrites } from "../utils/profileCosmeticStorage";
import { sessionAuth } from "../session/sessionAuth";
import {
  formatProfileDisplayName,
  updateProfileDisplayName,
} from "../ui/identity/profileUiPort";
import {
  beginVerifiedProfileApplication,
  queueDeferredProfilePresentation,
} from "./deferredProfilePresentation";
import {
  flushPendingOwnProfileMiningState,
  syncOwnProfileMiningState,
} from "../services/ownProfileMiningHydration";

export function applyVerifiedProfile(
  profile: PlayerProfile,
  uid: string,
  options?: { deferPresentationCache?: boolean },
): void {
  const applicationRevision = beginVerifiedProfileApplication();
  const user = sessionAuth.currentUser;
  const applyOptional = (apply: () => void): void => {
    try {
      apply();
    } catch (error) {
      if (
        !(error instanceof DOMException) ||
        error.name !== "QuotaExceededError"
      )
        throw error;
    }
  };
  const presentationWrites = createProfileCosmeticWrites(profile);
  const emoji = profile.emoji;
  storage.setLoginId(uid);
  storage.setProfileId(profile.id);
  storage.setEthAddress(profile.eth ?? "");
  storage.setSolAddress(profile.sol ?? "");
  applyOptional(() => {
    storage.setUsername(profile.username ?? "");
    storage.setPlayerEmojiId(emoji);
    storage.setPlayerEmojiAura(profile.aura);
    storage.setPlayerRating(profile.rating ?? null);
    storage.setPlayerNonce(profile.nonce ?? null);
    storage.setPlayerTotalManaPoints(profile.totalManaPoints ?? null);
    if (!options?.deferPresentationCache)
      presentationWrites.forEach((field) => field.write());
  });

  applyOptional(() =>
    syncTutorialProgress(
      profile.completedProblemIds ?? [],
      profile.isTutorialCompleted === true,
    ),
  );
  applyOptional(() =>
    setupLoggedInPlayerProfile(
      { ...profile, emoji },
      connection.getSameProfilePlayerUid() ?? uid,
    ),
  );
  applyOptional(() => syncOwnProfileMiningState(profile));
  applyOptional(flushPendingOwnProfileMiningState);
  updateProfileDisplayName(
    profile.username ?? "",
    profile.eth ?? null,
    profile.sol ?? null,
  );
  if (options?.deferPresentationCache)
    queueDeferredProfilePresentation(
      applicationRevision,
      {
        profileId: profile.id,
        displayName: formatProfileDisplayName(
          profile.username ?? "",
          profile.eth ?? null,
          profile.sol ?? null,
        ),
      },
      () =>
        user?.uid === uid &&
        sessionAuth.currentUser === user &&
        !sessionAuth.isStoppedForLogout &&
        storage.getLoginId("") === uid &&
        storage.getProfileId("") === profile.id,
      presentationWrites,
    );
}
