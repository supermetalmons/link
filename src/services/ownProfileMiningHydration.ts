import {
  PlayerMiningData,
  PlayerProfile,
} from "../connection/connectionModels";
import {
  decidePendingMiningHydration,
  decideProfileMiningHydration,
} from "../island/miningHydration";
import { rocksMiningService } from "./rocksMiningService";
import { storage } from "../utils/storage";
import {
  getPendingOwnProfileMiningState,
  resetPendingOwnProfileMiningState,
  setPendingOwnProfileMiningState,
} from "../utils/playerMetadataCache";

const applyOwnProfileMiningState = (mining: PlayerMiningData): void => {
  rocksMiningService.setFromServer(mining, { persist: true });
};

export function flushPendingOwnProfileMiningState(): void {
  const pendingOwnProfileMiningState = getPendingOwnProfileMiningState();
  if (!pendingOwnProfileMiningState) {
    return;
  }
  const activeProfileId = storage.getProfileId("");
  const decision = decidePendingMiningHydration(
    activeProfileId,
    pendingOwnProfileMiningState,
  );
  if (decision.action === "wait") {
    return;
  }
  if (decision.action === "clear") {
    resetPendingOwnProfileMiningState();
    return;
  }
  applyOwnProfileMiningState(decision.mining);
  resetPendingOwnProfileMiningState();
}

export function syncOwnProfileMiningState(profile: PlayerProfile): void {
  if (!profile.mining) {
    return;
  }
  const decision = decideProfileMiningHydration(
    storage.getProfileId(""),
    profile,
  );
  if (decision.action === "ignore") {
    return;
  }
  if (decision.action === "cache") {
    setPendingOwnProfileMiningState({
      profileId: decision.profileId,
      mining: decision.mining,
    });
    return;
  }
  resetPendingOwnProfileMiningState();
  applyOwnProfileMiningState(decision.mining);
}

export { resetPendingOwnProfileMiningState } from "../utils/playerMetadataCache";
