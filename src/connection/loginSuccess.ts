import { storage } from "../utils/storage";
import {
  setupLoggedInPlayerProfile,
  updateEmojiAndAuraIfNeeded,
} from "../game/board";
import { connection } from "./connection";
import { updateProfileDisplayName } from "../ui/identity/profileUiPort";
import {
  handleFreshlySignedInProfileInGameIfNeeded,
  isWatchOnly,
} from "../game/gameController";
import { PlayerProfile } from "../connection/connectionModels";
import type { AuthProfileResponse } from "@mons/shared/auth";
import { isMiningSnapshot } from "@mons/shared/mining";
import { syncTutorialProgress } from "../content/problems";
import {
  clearPendingLogoutWipeAfterSignIn,
  enforcePendingLogoutWipeIfNeeded,
  notifyOtherTabsAboutSignIn,
} from "../session/logoutOrchestrator";
import {
  flushPendingOwnProfileMiningState,
  syncOwnProfileMiningState,
} from "../services/ownProfileMiningHydration";

export type AddressKind = "eth" | "sol" | "apple" | "x";

export function handleLoginSuccess(
  res: AuthProfileResponse,
  addressKind: AddressKind,
): void {
  enforcePendingLogoutWipeIfNeeded();
  const { emoji, profileId } = res;
  const username = res.username ?? "";
  const resolvedEth =
    res.eth ?? (addressKind === "eth" ? (res.address ?? null) : null);
  const resolvedSol =
    res.sol ?? (addressKind === "sol" ? (res.address ?? null) : null);

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

  syncTutorialProgress(
    Array.isArray(res.completedProblems)
      ? res.completedProblems.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    res.tutorialCompleted === true,
  );
  const resolvedLoginUid = connection.getSameProfilePlayerUid() ?? res.uid;
  setupLoggedInPlayerProfile(profile, resolvedLoginUid);

  storage.setUsername(username);
  storage.setProfileId(profileId);
  storage.setPlayerEmojiId(emoji.toString());
  storage.setPlayerEmojiAura(res.aura ?? "");
  storage.setLoginId(res.uid);
  storage.setEthAddress(resolvedEth ?? "");
  storage.setSolAddress(resolvedSol ?? "");
  syncOwnProfileMiningState(profile);
  flushPendingOwnProfileMiningState();
  updateProfileDisplayName(username, resolvedEth ?? null, resolvedSol ?? null);

  storage.setPlayerRating(typeof res.rating === "number" ? res.rating : null);
  storage.setPlayerNonce(typeof res.nonce === "number" ? res.nonce : null);
  storage.setPlayerTotalManaPoints(
    typeof res.totalManaPoints === "number" ? res.totalManaPoints : null,
  );
  storage.setCardBackgroundId(
    typeof res.cardBackgroundId === "number" ? res.cardBackgroundId : null,
  );
  storage.setCardStickers(
    typeof res.cardStickers === "string" ? res.cardStickers : null,
  );
  storage.setCardSubtitleId(
    typeof res.cardSubtitleId === "number" ? res.cardSubtitleId : null,
  );
  storage.setProfileCounter(
    typeof res.profileCounter === "string" ? res.profileCounter : null,
  );
  storage.setProfileMons(
    typeof res.profileMons === "string" ? res.profileMons : null,
  );

  notifyOtherTabsAboutSignIn(profileId, res.uid);
  clearPendingLogoutWipeAfterSignIn();
  connection.forceTokenRefresh();

  if (!isWatchOnly) {
    updateEmojiAndAuraIfNeeded(emoji.toString(), res.aura ?? undefined, false);
  }

  handleFreshlySignedInProfileInGameIfNeeded(profileId);
}
