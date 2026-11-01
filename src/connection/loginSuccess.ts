import { updateEmojiAndAuraIfNeeded } from "../game/board";
import { connection } from "./connection";
import { applyVerifiedProfile } from "./verifiedProfile";
import { invalidateInitialIdentity } from "../services/initialIdentityBootstrap";
import {
  handleFreshlySignedInProfileInGameIfNeeded,
  isWatchOnly,
} from "../game/gameController";
import { PlayerProfile } from "../connection/connectionModels";
import type { AuthProfileResponse } from "@mons/shared/auth";
import { isMiningSnapshot } from "@mons/shared/mining";
import {
  clearPendingLogoutWipeAfterSignIn,
  enforcePendingLogoutWipeIfNeeded,
  notifyOtherTabsAboutSignIn,
} from "../session/logoutOrchestrator";

export function handleLoginSuccess(res: AuthProfileResponse): boolean {
  if (!connection.isCurrentAuthUser(res.uid)) {
    return false;
  }
  invalidateInitialIdentity();
  enforcePendingLogoutWipeIfNeeded();
  const { emoji, profileId } = res;
  const username = res.username ?? "";
  const resolvedEth = res.eth ?? null;
  const resolvedSol = res.sol ?? null;

  const profile: PlayerProfile = {
    id: profileId,
    username,
    cardBackgroundId: res.cardBackgroundId,
    cardSubtitleId: res.cardSubtitleId,
    profileCounter: res.profileCounter,
    profileMons: res.profileMons,
    cardStickers: res.cardStickers,
    emoji,
    aura: res.aura,
    eth: resolvedEth ?? null,
    sol: resolvedSol ?? null,
    ...(isMiningSnapshot(res.mining) ? { mining: res.mining } : {}),
  };

  if (typeof res.rating === "number") profile.rating = res.rating;
  if (typeof res.nonce === "number") profile.nonce = res.nonce;
  if (typeof res.totalManaPoints === "number")
    profile.totalManaPoints = res.totalManaPoints;

  profile.completedProblemIds = Array.isArray(res.completedProblems)
    ? res.completedProblems.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  profile.isTutorialCompleted = res.tutorialCompleted === true;
  applyVerifiedProfile(profile, res.uid);

  notifyOtherTabsAboutSignIn(profileId, res.uid);
  clearPendingLogoutWipeAfterSignIn();

  if (!isWatchOnly) {
    updateEmojiAndAuraIfNeeded(emoji, res.aura, false);
  }

  handleFreshlySignedInProfileInGameIfNeeded();
  return true;
}
