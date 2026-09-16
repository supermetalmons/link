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
    rating: undefined,
    nonce: undefined,
    win: undefined,
    cardBackgroundId: undefined,
    cardSubtitleId: undefined,
    profileCounter: undefined,
    profileMons: undefined,
    cardStickers: undefined,
    emoji,
    aura: res.aura ?? undefined,
    completedProblemIds: undefined,
    isTutorialCompleted: undefined,
    eth: resolvedEth ?? null,
    sol: resolvedSol ?? null,
    mining: isMiningSnapshot(res.mining) ? res.mining : undefined,
  };

  if (typeof res.rating === "number") profile.rating = res.rating;
  if (typeof res.nonce === "number") profile.nonce = res.nonce;
  if (typeof res.totalManaPoints === "number")
    profile.totalManaPoints = res.totalManaPoints;
  if (typeof res.cardBackgroundId === "number")
    profile.cardBackgroundId = res.cardBackgroundId;
  if (typeof res.cardStickers === "string")
    profile.cardStickers = res.cardStickers;
  if (typeof res.cardSubtitleId === "number")
    profile.cardSubtitleId = res.cardSubtitleId;
  if (typeof res.profileCounter === "string")
    profile.profileCounter = res.profileCounter;
  if (typeof res.profileMons === "string")
    profile.profileMons = res.profileMons;

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
    updateEmojiAndAuraIfNeeded(emoji.toString(), res.aura ?? undefined, false);
  }

  handleFreshlySignedInProfileInGameIfNeeded();
  return true;
}
