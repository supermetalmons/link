import { createEmptyMaterials } from "@mons/shared/mining";
import { cropAddress } from "@mons/shared/profiles";
import {
  MINING_MATERIAL_NAMES,
  type PlayerProfile,
} from "../connection/connectionModels";
import type { LeaderboardEntry, LeaderboardType } from "./leaderboardCache";

export const LEADERBOARD_ENTRY_LIMIT = 99;

export const getLeaderboardDisplayName = (row: LeaderboardEntry): string => {
  if (row.username) return row.username;
  if (row.ensName) return row.ensName;
  if (row.eth) return cropAddress(row.eth);
  if (row.sol) return cropAddress(row.sol);
  return "";
};

export const createLeaderboardEntry = (
  entry: PlayerProfile,
): LeaderboardEntry => ({
  username: entry.username,
  eth: entry.eth,
  sol: entry.sol,
  mp: entry.totalManaPoints ?? 0,
  rating: Math.round(entry.rating ?? 1500),
  win: entry.win ?? true,
  id: entry.id,
  emoji: entry.emoji,
  aura: entry.aura,
  ensName: null,
  profile: entry,
  materials: entry.mining?.materials
    ? { ...createEmptyMaterials(), ...entry.mining.materials }
    : createEmptyMaterials(),
});

export const profilesToLeaderboardEntries = (
  profiles: PlayerProfile[],
): LeaderboardEntry[] => profiles.map(createLeaderboardEntry);

export const getLeaderboardMaterialTotal = (entry: LeaderboardEntry): number =>
  Object.values(entry.materials).reduce((sum, value) => sum + value, 0);

export const populateMaterialLeaderboardCaches = (
  cache: Map<LeaderboardType, LeaderboardEntry[]>,
  entries: LeaderboardEntry[],
): void => {
  const entryMap = new Map<string, LeaderboardEntry>();
  entries.forEach((entry) => entryMap.set(entry.id, entry));

  MINING_MATERIAL_NAMES.forEach((material) => {
    if (cache.has(material)) {
      return;
    }
    cache.set(
      material,
      [...entryMap.values()]
        .sort(
          (left, right) => right.materials[material] - left.materials[material],
        )
        .slice(0, LEADERBOARD_ENTRY_LIMIT),
    );
  });

  if (!cache.has("total")) {
    cache.set(
      "total",
      [...entryMap.values()]
        .sort(
          (left, right) =>
            getLeaderboardMaterialTotal(right) -
            getLeaderboardMaterialTotal(left),
        )
        .slice(0, LEADERBOARD_ENTRY_LIMIT),
    );
  }
};
