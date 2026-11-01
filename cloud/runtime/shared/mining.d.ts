// Generated from src/shared/mining.ts. Run npm run generate:runtime.
export type MiningMaterialName = (typeof MATERIAL_KEYS)[number];
export type MiningMaterials = Record<MiningMaterialName, number>;
export type MineRockFailureReason = (typeof MINE_ROCK_FAILURE_REASONS)[number];
export interface MiningSnapshot {
  lastRockDate: string | null;
  materials: MiningMaterials;
}
export interface MiningDrops {
  drops: MiningMaterialName[];
  delta: MiningMaterials;
}
export interface MineRockRequest {
  date: string;
  materials: MiningMaterials;
}
export type MineRockResponse =
  | {
      ok: true;
      mining: MiningSnapshot;
    }
  | {
      ok: false;
      reason: MineRockFailureReason;
    };
export interface WagerProposalLike {
  material: MiningMaterialName;
  count: number;
}
export interface AcceptedMaterialReservation {
  acceptedCount: number;
  appliedDelta: Partial<MiningMaterials> | null;
  materials: (MiningMaterials & Record<string, number>) | null;
}
declare const MATERIAL_KEYS: readonly ["dust", "slime", "gum", "metal", "ice"];
declare const MINING_MATERIAL_NAMES: typeof MATERIAL_KEYS;
declare const MINE_ROCK_FAILURE_REASONS: readonly [
  "date-out-of-range",
  "profile-not-found",
  "date-not-advanced",
  "materials-mismatch",
];
declare const createEmptyMaterials: () => MiningMaterials;
declare const cloneMaterials: (source: MiningMaterials) => MiningMaterials;
declare const sumMaterials: (
  left: MiningMaterials,
  right: MiningMaterials,
) => MiningMaterials;
declare const isMiningMaterials: (value: unknown) => value is MiningMaterials;
declare const isMiningSnapshot: (value: unknown) => value is MiningSnapshot;
declare const parseMiningMaterials: (value: unknown) => MiningMaterials | null;
declare const parseMiningSnapshot: (value: unknown) => MiningSnapshot | null;
declare const createEmptyMiningSnapshot: () => MiningSnapshot;
declare const isMineRockResponse: (value: unknown) => value is MineRockResponse;
declare const formatMiningDateLocal: (date: Date) => string;
declare const formatMiningDateUtc: (date: Date) => string;
declare const createMiningSeededRandom: (
  profileId: string,
  date: string,
) => () => number;
declare const pickWeightedMaterial: (
  random: () => number,
) => MiningMaterialName;
declare const isFirstMiningEvent: (source: MiningSnapshot) => boolean;
declare const createFirstRockDrops: () => MiningDrops;
declare const createDropsFromRandom: (random: () => number) => MiningDrops;
declare const createDeterministicDrops: (
  profileId: string,
  date: string,
) => MiningDrops;
declare const createDropsForMiningEvent: (
  profileId: string,
  date: string,
  miningSnapshot: MiningSnapshot,
) => MiningDrops;
declare const isMaterialName: (value: unknown) => value is MiningMaterialName;
declare const applyMaterialDeltas: (
  source: MiningMaterials,
  deltas?: Partial<MiningMaterials> | null,
) => MiningMaterials;
declare const applyMaterialDeltasWithCap: (
  source: MiningMaterials,
  deltas: Partial<MiningMaterials> | null | undefined,
  totalMaterials?: MiningMaterials,
) => MiningMaterials;
declare const computeAvailableCount: (
  total: Partial<Record<string, number>> | null | undefined,
  frozen: Partial<Record<string, number>> | null | undefined,
  material: string,
) => number;
declare const computeAvailableMaterials: (
  total: MiningMaterials,
  frozen: MiningMaterials,
) => MiningMaterials;
declare const computeAcceptedReservation: (
  current: MiningMaterials,
  material: MiningMaterialName,
  proposedCount: number,
  ownProposal: WagerProposalLike | null | undefined,
  totalMaterials: MiningMaterials,
) => AcceptedMaterialReservation;
export {
  MATERIAL_KEYS,
  MINING_MATERIAL_NAMES,
  MINE_ROCK_FAILURE_REASONS,
  createEmptyMaterials,
  cloneMaterials,
  sumMaterials,
  createEmptyMiningSnapshot,
  parseMiningMaterials,
  parseMiningSnapshot,
  isMiningMaterials,
  isMiningSnapshot,
  isMineRockResponse,
  formatMiningDateLocal,
  formatMiningDateUtc,
  createMiningSeededRandom,
  pickWeightedMaterial,
  isFirstMiningEvent,
  createFirstRockDrops,
  createDropsFromRandom,
  createDeterministicDrops,
  createDropsForMiningEvent,
  isMaterialName,
  applyMaterialDeltas,
  applyMaterialDeltasWithCap,
  computeAvailableCount,
  computeAvailableMaterials,
  computeAcceptedReservation,
};
