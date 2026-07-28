import {
  PlayerMiningData,
  PlayerProfile,
} from "../connection/connectionModels";
import { rocksMiningService } from "./rocksMiningService";
import { storage } from "../utils/storage";

type PendingOwnProfileMiningState = {
  profileId: string;
  mining: PlayerMiningData;
};

const cloneMiningState = (mining: PlayerMiningData): PlayerMiningData => ({
  lastRockDate: mining.lastRockDate ?? null,
  materials: { ...mining.materials },
});

const applyOwnProfileMiningState = (mining: PlayerMiningData): void => {
  rocksMiningService.setFromServer(mining, { persist: true });
};

let pendingOwnProfileMiningState: PendingOwnProfileMiningState | null = null;

export function flushPendingOwnProfileMiningState(): void {
  if (!pendingOwnProfileMiningState) {
    return;
  }
  const activeProfileId = storage.getProfileId("");
  if (!activeProfileId) {
    return;
  }
  if (pendingOwnProfileMiningState.profileId !== activeProfileId) {
    pendingOwnProfileMiningState = null;
    return;
  }
  applyOwnProfileMiningState(pendingOwnProfileMiningState.mining);
  pendingOwnProfileMiningState = null;
}

export function syncOwnProfileMiningState(profile: PlayerProfile): void {
  if (!profile.mining) {
    return;
  }
  const activeProfileId = storage.getProfileId("");
  if (activeProfileId !== profile.id) {
    if (!activeProfileId) {
      pendingOwnProfileMiningState = {
        profileId: profile.id,
        mining: cloneMiningState(profile.mining),
      };
    }
    return;
  }
  pendingOwnProfileMiningState = null;
  applyOwnProfileMiningState(profile.mining);
}

export function resetPendingOwnProfileMiningState(): void {
  pendingOwnProfileMiningState = null;
}
