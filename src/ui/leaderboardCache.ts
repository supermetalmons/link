import type {
  MiningMaterialName,
  PlayerProfile,
} from "../connection/connectionModels";

export type LeaderboardType = "rating" | "mp" | MiningMaterialName | "total";

export interface LeaderboardEntry {
  eth?: string | null;
  sol?: string | null;
  mp: number;
  rating: number;
  win: boolean;
  id: string;
  emoji: number;
  aura?: string;
  ensName?: string | null;
  username?: string | null;
  profile: PlayerProfile;
  materials: Record<MiningMaterialName, number>;
}

export const leaderboardCache = new Map<
  LeaderboardType,
  LeaderboardEntry[]
>();

export const resetLeaderboardCache = () => {
  leaderboardCache.clear();
};
