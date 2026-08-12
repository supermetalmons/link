import type {
  PlayerMiningData,
  PlayerProfile,
} from "../connection/connectionModels";

export type ProfileMiningHydrationDecision =
  | { action: "apply"; mining: PlayerMiningData }
  | { action: "cache"; profileId: string; mining: PlayerMiningData }
  | { action: "ignore" };

export type PendingMiningHydrationDecision =
  | { action: "apply"; mining: PlayerMiningData }
  | { action: "clear" }
  | { action: "wait" };

const cloneMiningState = (mining: PlayerMiningData): PlayerMiningData => ({
  lastRockDate: mining.lastRockDate ?? null,
  materials: { ...mining.materials },
});

export const decideProfileMiningHydration = (
  activeProfileId: string,
  profile: PlayerProfile,
): ProfileMiningHydrationDecision => {
  if (!profile.mining) {
    return { action: "ignore" };
  }
  if (activeProfileId === profile.id) {
    return { action: "apply", mining: profile.mining };
  }
  if (!activeProfileId) {
    return {
      action: "cache",
      profileId: profile.id,
      mining: cloneMiningState(profile.mining),
    };
  }
  return { action: "ignore" };
};

export const decidePendingMiningHydration = (
  activeProfileId: string,
  pending: { profileId: string; mining: PlayerMiningData } | null,
): PendingMiningHydrationDecision => {
  if (!pending || !activeProfileId) {
    return { action: "wait" };
  }
  if (pending.profileId !== activeProfileId) {
    return { action: "clear" };
  }
  return { action: "apply", mining: pending.mining };
};
