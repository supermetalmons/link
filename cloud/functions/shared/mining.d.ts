export const MATERIAL_KEYS: readonly ["dust", "slime", "gum", "metal", "ice"];

export const MINING_MATERIAL_NAMES: typeof MATERIAL_KEYS;

export type MiningMaterialName = (typeof MATERIAL_KEYS)[number];
export type MiningMaterials = Record<MiningMaterialName, number>;

export const MINE_ROCK_FAILURE_REASONS: readonly [
  "date-out-of-range",
  "profile-not-found",
  "date-not-advanced",
  "materials-mismatch",
];

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
  | { ok: true; mining: MiningSnapshot }
  | { ok: false; reason: MineRockFailureReason };

export interface WagerProposalLike {
  material?: string | null;
  count?: unknown;
}

export interface AcceptedMaterialReservation {
  acceptedCount: number;
  appliedDelta: Partial<MiningMaterials> | null;
  materials: (MiningMaterials & Record<string, number>) | null;
}

export function createEmptyMaterials(): MiningMaterials;
export function cloneMaterials(source: MiningMaterials): MiningMaterials;
export function normalizeMaterials(source?: unknown): MiningMaterials;
export function sumMaterials(
  left: MiningMaterials,
  right: MiningMaterials,
): MiningMaterials;
export function normalizeMiningSnapshot(source?: unknown): MiningSnapshot;
export function isMiningMaterials(value: unknown): value is MiningMaterials;
export function isMiningSnapshot(value: unknown): value is MiningSnapshot;
export function isMineRockResponse(value: unknown): value is MineRockResponse;

export function formatMiningDateLocal(date: Date): string;
export function formatMiningDateUtc(date: Date): string;

export function createMiningSeededRandom(
  profileId: string,
  date: string,
): () => number;
export function pickWeightedMaterial(random: () => number): MiningMaterialName;
export function isFirstMiningEvent(source?: unknown): boolean;
export function createFirstRockDrops(): MiningDrops;
export function createDropsFromRandom(random: () => number): MiningDrops;
export function createDeterministicDrops(
  profileId: string,
  date: string,
): MiningDrops;
export function createDropsForMiningEvent(
  profileId: string,
  date: string,
  miningSnapshot?: unknown,
): MiningDrops;

export function isMaterialName(value: unknown): value is MiningMaterialName;
export function normalizeCount(value: unknown): number;
export function applyMaterialDeltas(
  source?: unknown,
  deltas?: unknown,
): MiningMaterials;
export function applyMaterialDeltasWithCap(
  source: unknown,
  deltas: unknown,
  totalMaterials?: unknown,
): MiningMaterials;
export function computeAvailableCount(
  total: Partial<Record<string, number>> | null | undefined,
  frozen: Partial<Record<string, number>> | null | undefined,
  material: string,
): number;
export function computeAvailableMaterials(
  total: MiningMaterials,
  frozen: MiningMaterials,
): MiningMaterials;
export function computeAcceptedReservation(
  current: unknown,
  material: string,
  proposedCount: number,
  ownProposal: WagerProposalLike | null | undefined,
  totalMaterials: unknown,
): AcceptedMaterialReservation;
