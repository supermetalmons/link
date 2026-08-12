import {
  cloneMaterials,
  createEmptyMaterials,
  normalizeMaterials,
  normalizeMiningSnapshot,
} from "@mons/shared/mining";
import { computeHash32 } from "@mons/shared/ids";
import type {
  PlayerMiningData,
  PlayerMiningMaterials,
} from "../connection/connectionModels";

export const ROCK_VARIANT_COUNT = 27;

export const isAnonymousProfile = (profileId: string): boolean =>
  profileId === "";

export const createEmptyMiningMaterials = (): PlayerMiningMaterials =>
  createEmptyMaterials();

export const cloneMiningMaterials = (
  source: PlayerMiningMaterials,
): PlayerMiningMaterials => cloneMaterials(source);

export const normalizeMiningMaterials = (
  source?: Partial<PlayerMiningMaterials> | null,
): PlayerMiningMaterials => normalizeMaterials(source);

export const normalizeMiningState = (
  source?: PlayerMiningData | null,
): PlayerMiningData => normalizeMiningSnapshot(source);

export const loadStoredMiningState = ({
  profileId,
  lastRockDate,
  materials,
}: {
  profileId: string;
  lastRockDate: unknown;
  materials: Partial<PlayerMiningMaterials> | null | undefined;
}): PlayerMiningData => ({
  lastRockDate: typeof lastRockDate === "string" ? lastRockDate : null,
  materials: isAnonymousProfile(profileId)
    ? createEmptyMiningMaterials()
    : normalizeMiningMaterials(materials),
});

export const shouldShowMiningRock = ({
  testingMode,
  profileId,
  serverSnapshotLoaded,
  snapshot,
  today,
}: {
  testingMode: boolean;
  profileId: string;
  serverSnapshotLoaded: boolean;
  snapshot: PlayerMiningData;
  today: string;
}): boolean => {
  if (testingMode) {
    return true;
  }
  if (!isAnonymousProfile(profileId) && !serverSnapshotLoaded) {
    return false;
  }
  return !snapshot.lastRockDate || today > snapshot.lastRockDate;
};

export const getRockVariantIndex = (
  profileId: string,
  date: string,
): number => {
  const seed = profileId ? `${profileId}:${date}` : date;
  return (computeHash32(seed) % ROCK_VARIANT_COUNT) + 1;
};
