import { normalizeProfileEmojiId } from "@mons/shared/profiles";
import type { PlayerProfile } from "./connectionModels";
import { connection } from "./connection";
import { setupLoggedInPlayerProfile } from "../game/board";
import { syncTutorialProgress } from "../content/problems";
import { storage } from "../utils/storage";
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
  const presentationWrites = [
    {
      read: () => localStorage.getItem("cardBackgroundId"),
      write: () =>
        storage.setCardBackgroundId(profile.cardBackgroundId ?? null),
    },
    {
      read: () => localStorage.getItem("cardStickers"),
      write: () => storage.setCardStickers(profile.cardStickers ?? null),
    },
    {
      read: () => localStorage.getItem("cardSubtitleId"),
      write: () => storage.setCardSubtitleId(profile.cardSubtitleId ?? null),
    },
    {
      read: () => localStorage.getItem("profileCounter"),
      write: () => storage.setProfileCounter(profile.profileCounter ?? null),
    },
    {
      read: () => localStorage.getItem("profileMons"),
      write: () => storage.setProfileMons(profile.profileMons ?? null),
    },
  ];
  const emoji = normalizeProfileEmojiId(profile.emoji, 1);
  storage.setLoginId(uid);
  storage.setProfileId(profile.id);
  storage.setEthAddress(profile.eth ?? "");
  storage.setSolAddress(profile.sol ?? "");
  applyOptional(() => {
    storage.setUsername(profile.username ?? "");
    storage.setPlayerEmojiId(emoji.toString());
    storage.setPlayerEmojiAura(profile.aura ?? "");
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
