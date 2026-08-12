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
import {
  PlayerMiningData,
  PlayerProfile,
} from "../connection/connectionModels";
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

interface VerifyResponse {
  ok: true;
  uid: string;
  profileId: string;
  username: string | null;
  address?: string | null;
  eth?: string | null;
  sol?: string | null;
  emoji: number;
  aura?: string | null;
  rating?: number;
  nonce?: number;
  totalManaPoints?: number;
  win?: number;
  cardBackgroundId?: number;
  cardSubtitleId?: number;
  profileCounter?: string;
  profileMons?: any;
  cardStickers?: any;
  completedProblems?: any;
  tutorialCompleted?: any;
  mining?: PlayerMiningData;
}

export function handleLoginSuccess(
  res: VerifyResponse,
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
    mining: res.mining,
  };

  if (res.rating !== undefined) profile.rating = res.rating;
  if (res.nonce !== undefined) profile.nonce = res.nonce;
  if (res.totalManaPoints !== undefined)
    (profile as any).totalManaPoints = res.totalManaPoints;
  if (res.cardBackgroundId !== undefined)
    profile.cardBackgroundId = res.cardBackgroundId;
  if (res.cardStickers !== undefined) profile.cardStickers = res.cardStickers;
  if (res.cardSubtitleId !== undefined)
    profile.cardSubtitleId = res.cardSubtitleId;
  if (res.profileCounter !== undefined)
    profile.profileCounter = res.profileCounter;
  if (res.profileMons !== undefined) profile.profileMons = res.profileMons;

  syncTutorialProgress(
    res.completedProblems ?? [],
    res.tutorialCompleted ?? false,
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

  if (res.rating !== undefined) storage.setPlayerRating(res.rating);
  if (res.nonce !== undefined) storage.setPlayerNonce(res.nonce);
  if (res.totalManaPoints !== undefined)
    storage.setPlayerTotalManaPoints(res.totalManaPoints);
  if (res.cardBackgroundId !== undefined)
    storage.setCardBackgroundId(res.cardBackgroundId);
  if (res.cardStickers !== undefined) storage.setCardStickers(res.cardStickers);
  if (res.cardSubtitleId !== undefined)
    storage.setCardSubtitleId(res.cardSubtitleId);
  if (res.profileCounter !== undefined)
    storage.setProfileCounter(res.profileCounter);
  if (res.profileMons !== undefined) storage.setProfileMons(res.profileMons);

  notifyOtherTabsAboutSignIn(profileId, res.uid);
  clearPendingLogoutWipeAfterSignIn();
  connection.forceTokenRefresh();

  if (!isWatchOnly) {
    updateEmojiAndAuraIfNeeded(emoji.toString(), res.aura ?? undefined, false);
  }

  handleFreshlySignedInProfileInGameIfNeeded(profileId);
}
