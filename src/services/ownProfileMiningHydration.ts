import {
  PlayerMiningData,
  PlayerProfile,
} from "../connection/connectionModels";
import { rocksMiningService } from "./rocksMiningService";
import { storage } from "../utils/storage";
import {
  getPendingOwnProfileMiningState,
  resetPendingOwnProfileMiningState,
  setPendingOwnProfileMiningState,
} from "../utils/playerMetadataCache";

const cloneMiningState = (mining: PlayerMiningData): PlayerMiningData => ({
  lastRockDate: mining.lastRockDate ?? null,
  materials: { ...mining.materials },
});

const applyOwnProfileMiningState = (mining: PlayerMiningData): void => {
  rocksMiningService.setFromServer(mining, { persist: true });
};

export function flushPendingOwnProfileMiningState(): void {
  const pendingOwnProfileMiningState = getPendingOwnProfileMiningState();
  if (!pendingOwnProfileMiningState) {
    return;
  }
  const activeProfileId = storage.getProfileId("");
  if (!activeProfileId) {
    return;
  }
  if (pendingOwnProfileMiningState.profileId !== activeProfileId) {
    resetPendingOwnProfileMiningState();
    return;
  }
  applyOwnProfileMiningState(pendingOwnProfileMiningState.mining);
  resetPendingOwnProfileMiningState();
}

export function syncOwnProfileMiningState(profile: PlayerProfile): void {
  if (!profile.mining) {
    return;
  }
  const activeProfileId = storage.getProfileId("");
  if (activeProfileId !== profile.id) {
    if (!activeProfileId) {
      setPendingOwnProfileMiningState({
        profileId: profile.id,
        mining: cloneMiningState(profile.mining),
      });
    }
    return;
  }
  resetPendingOwnProfileMiningState();
  applyOwnProfileMiningState(profile.mining);
}

export { resetPendingOwnProfileMiningState } from "../utils/playerMetadataCache";
