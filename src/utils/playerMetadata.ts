import type { PlayerProfile } from "../connection/connectionModels";
import glicko2 from "glicko2";
import { createRatingUpdater } from "@mons/shared/ratings";
import { storage } from "./storage";
import {
  ensForUids,
  ethAddressesForUids,
  profilesForUids,
  solAddressesForUids,
  usernamesForUids,
} from "./playerMetadataCache";
import {
  createPlayerMetadataSessionGuard,
  getPlayerProfileByLoginId,
  isPlayerMetadataWatchOnly,
  syncPlayerMiningState,
  syncPlayerTutorialProgress,
  updatePlayerEmoji,
  updatePlayerEmojiAndAura,
  updatePlayerProfileDisplayName,
} from "./playerMetadataRuntimePort";

export { resetPlayerMetadataCaches } from "./playerMetadataCache";

const updateRating = createRatingUpdater(glicko2.Glicko2);

export type PlayerMetadata = {
  uid: string;
  displayName: string | undefined;
  username: string | undefined;
  ethAddress: string | undefined;
  solAddress: string | undefined;
  ens: string | undefined;
  emojiId: string;
  aura?: string;
  voiceReactionText: string;
  voiceReactionDate: number | undefined;
  rating: number | undefined;
  profile: PlayerProfile | null;
};

export const newEmptyPlayerMetadata = (): PlayerMetadata => ({
  uid: "",
  displayName: undefined,
  username: undefined,
  ethAddress: undefined,
  solAddress: undefined,
  ens: undefined,
  emojiId: "",
  aura: "",
  voiceReactionText: "",
  voiceReactionDate: undefined,
  rating: undefined,
  profile: null,
});

export function recalculateRatingsLocallyForUids(
  victoryUid: string,
  defeatUid: string,
) {
  const rating1 = getRatingForUid(victoryUid);
  const rating2 = getRatingForUid(defeatUid);
  const nonce1 = getNonceForUid(victoryUid);
  const nonce2 = getNonceForUid(defeatUid);

  if (!rating1 || !rating2 || nonce1 === undefined || nonce2 === undefined) {
    return;
  }

  const newNonce1 = nonce1 + 1;
  const newNonce2 = nonce2 + 1;

  const [newRating1, newRating2] = updateRating(
    rating1,
    newNonce1,
    rating2,
    newNonce2,
  );

  setRatingAndNonceForUid(victoryUid, newRating1, newNonce1);
  setRatingAndNonceForUid(defeatUid, newRating2, newNonce2);
}

export function getStashedUsername(uid: string) {
  return usernamesForUids[uid];
}

export function getStashedPlayerSolAddress(uid: string) {
  return solAddressesForUids[uid];
}

export function getStashedPlayerProfile(
  uid: string,
): PlayerProfile | undefined {
  if (!uid) return undefined;
  return profilesForUids[uid];
}

export function getStashedPlayerEthAddress(uid: string) {
  return ethAddressesForUids[uid];
}

export function updatePlayerMetadataWithProfile(
  profile: PlayerProfile,
  loginId: string,
  own: boolean,
  onSuccess: () => void,
) {
  const sessionGuard = createPlayerMetadataSessionGuard();
  usernamesForUids[loginId] = profile.username ?? "";
  const ethAddress = profile.eth ?? "";
  const solAddress = profile.sol ?? "";
  if (ethAddress) {
    ethAddressesForUids[loginId] = ethAddress;
  } else {
    delete ethAddressesForUids[loginId];
  }
  if (solAddress) {
    solAddressesForUids[loginId] = solAddress;
  } else {
    delete solAddressesForUids[loginId];
  }

  if (ethAddress && !ensForUids[loginId] && !usernamesForUids[loginId]) {
    fetch(`https://api.ensideas.com/ens/resolve/${ethAddress}`)
      .then((response) => {
        if (response.ok) {
          return response.json();
        }
        return null;
      })
      .then((data) => {
        if (!sessionGuard()) {
          return;
        }
        if (data && data.name && data.name.trim() !== "") {
          ensForUids[loginId] = {
            name: data.name,
            avatar: data.avatar,
          };
          onSuccess();
        }
      })
      .catch(() => {});
  }

  if (profile.rating !== undefined && profile.nonce !== undefined) {
    profilesForUids[loginId] = profile;
    if (own) {
      syncPlayerMiningState(profile);
    }
    onSuccess();
  } else {
    getPlayerProfileByLoginId(loginId)
      .then((profile) => {
        if (!sessionGuard()) {
          return;
        }
        profilesForUids[loginId] = profile;
        if (profile.emoji !== undefined && own) {
          syncPlayerTutorialProgress(
            profile.completedProblemIds ?? [],
            profile.isTutorialCompleted ?? false,
          );
          storage.setPlayerEmojiId(profile.emoji.toString());
          storage.setPlayerEmojiAura(profile.aura ?? "");
          storage.setUsername(profile.username ?? "");
          storage.setPlayerRating(profile.rating ?? 1500);
          storage.setPlayerNonce(profile.nonce ?? -1);
          if ((profile as any).totalManaPoints !== undefined) {
            storage.setPlayerTotalManaPoints(
              (profile as any).totalManaPoints ?? 0,
            );
          }

          if (profile.cardBackgroundId) {
            storage.setCardBackgroundId(profile.cardBackgroundId);
          }

          if (profile.cardStickers) {
            storage.setCardStickers(profile.cardStickers);
          }

          if (profile.cardSubtitleId) {
            storage.setCardSubtitleId(profile.cardSubtitleId);
          }

          if (profile.profileCounter) {
            storage.setProfileCounter(profile.profileCounter);
          }

          if (profile.profileMons) {
            storage.setProfileMons(profile.profileMons);
          }

          syncPlayerMiningState(profile);

          updatePlayerProfileDisplayName(
            profile.username ?? "",
            storage.getEthAddress(""),
            storage.getSolAddress(""),
          );
          if (!isPlayerMetadataWatchOnly()) {
            updatePlayerEmojiAndAura(
              profile.emoji.toString(),
              profile.aura,
              false,
            );
          }
          updatePlayerEmoji(profile.emoji, true, profile.aura ?? "");
        }
        onSuccess();
      })
      .catch(() => {});
  }
}

export function getRatingForUid(uid: string): number | undefined {
  if (!uid) return undefined;
  return profilesForUids[uid]?.rating;
}

function getNonceForUid(uid: string): number | undefined {
  if (!uid) return undefined;
  return profilesForUids[uid]?.nonce;
}

function setRatingAndNonceForUid(
  uid: string,
  rating: number,
  nonce: number,
): void {
  if (!uid) return;
  if (profilesForUids[uid]) {
    profilesForUids[uid].rating = rating;
    profilesForUids[uid].nonce = nonce;
  }
}

export function getEnsNameForUid(uid: string): string | undefined {
  if (!uid) return undefined;
  return ensForUids[uid]?.name;
}
