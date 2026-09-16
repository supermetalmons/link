import { normalizeProfileEmojiId } from "@mons/shared/profiles";
import type { PlayerProfile } from "./connectionModels";
import { connection } from "./connection";
import { setupLoggedInPlayerProfile } from "../game/board";
import { syncTutorialProgress } from "../content/problems";
import { storage } from "../utils/storage";
import { updateProfileDisplayName } from "../ui/identity/profileUiPort";
import {
  flushPendingOwnProfileMiningState,
  syncOwnProfileMiningState,
} from "../services/ownProfileMiningHydration";

export function applyVerifiedProfile(
  profile: PlayerProfile,
  uid: string,
): void {
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
    storage.setCardBackgroundId(profile.cardBackgroundId ?? null);
    storage.setCardStickers(profile.cardStickers ?? null);
    storage.setCardSubtitleId(profile.cardSubtitleId ?? null);
    storage.setProfileCounter(profile.profileCounter ?? null);
    storage.setProfileMons(profile.profileMons ?? null);
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
}
