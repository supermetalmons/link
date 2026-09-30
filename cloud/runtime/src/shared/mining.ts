import { createSeededRandom } from "./ids.js";

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

const MATERIAL_KEYS = Object.freeze([
  "dust",
  "slime",
  "gum",
  "metal",
  "ice",
] as const);
const MINING_MATERIAL_NAMES: typeof MATERIAL_KEYS = MATERIAL_KEYS;
const MINE_ROCK_FAILURE_REASONS = Object.freeze([
  "date-out-of-range",
  "profile-not-found",
  "date-not-advanced",
  "materials-mismatch",
] as const);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: object,
  expectedKeys: readonly string[],
): boolean => {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeys.includes(key))
  );
};

const createEmptyMaterials = (): MiningMaterials => {
  const result: Partial<MiningMaterials> = {};
  MATERIAL_KEYS.forEach((key) => {
    result[key] = 0;
  });
  return result as MiningMaterials;
};

const cloneMaterials = (source: MiningMaterials): MiningMaterials => {
  const result = createEmptyMaterials();
  MATERIAL_KEYS.forEach((key) => {
    result[key] = source[key];
  });
  return result;
};

const normalizeMaterials = (source?: unknown): MiningMaterials => {
  const result = createEmptyMaterials();
  MATERIAL_KEYS.forEach((key) => {
    const raw = source ? (source as Record<string, unknown>)[key] : undefined;
    const numeric = typeof raw === "number" ? raw : Number(raw);
    result[key] = Number.isFinite(numeric)
      ? Math.max(0, Math.round(numeric))
      : 0;
  });
  return result;
};

const sumMaterials = (
  left: MiningMaterials,
  right: MiningMaterials,
): MiningMaterials => {
  const result = createEmptyMaterials();
  MATERIAL_KEYS.forEach((key) => {
    result[key] = (left[key] ?? 0) + (right[key] ?? 0);
  });
  return result;
};

const normalizeMiningSnapshot = (source?: unknown): MiningSnapshot => {
  return {
    lastRockDate:
      source &&
      typeof (source as Record<string, unknown>).lastRockDate === "string"
        ? (source as { lastRockDate: string }).lastRockDate
        : null,
    materials: normalizeMaterials(
      source && (source as Record<string, unknown>).materials,
    ),
  };
};

const isMiningMaterials = (value: unknown): value is MiningMaterials =>
  isRecord(value) &&
  hasExactKeys(value, MATERIAL_KEYS) &&
  MATERIAL_KEYS.every(
    (key) => Number.isInteger(value[key]) && (value[key] as number) >= 0,
  );

const isMiningSnapshot = (value: unknown): value is MiningSnapshot =>
  isRecord(value) &&
  hasExactKeys(value, ["lastRockDate", "materials"]) &&
  (value.lastRockDate === null || typeof value.lastRockDate === "string") &&
  isMiningMaterials(value.materials);

const isMineRockResponse = (value: unknown): value is MineRockResponse => {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === true) {
    return (
      hasExactKeys(value, ["ok", "mining"]) && isMiningSnapshot(value.mining)
    );
  }
  return (
    value.ok === false &&
    hasExactKeys(value, ["ok", "reason"]) &&
    (MINE_ROCK_FAILURE_REASONS as readonly unknown[]).includes(value.reason)
  );
};

const formatMiningDateLocal = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const formatMiningDateUtc = (date: Date): string => {
  return date.toISOString().slice(0, 10);
};

const createMiningSeededRandom = (
  profileId: string,
  date: string,
): (() => number) => {
  const source = profileId ? `${profileId}:${date}` : date;
  return createSeededRandom(source);
};

const pickWeightedMaterial = (random: () => number): MiningMaterialName => {
  const value = random() * 100;
  if (value < 30) return "dust";
  if (value < 55) return "slime";
  if (value < 75) return "gum";
  if (value < 90) return "metal";
  return "ice";
};

const isFirstMiningEvent = (source?: unknown): boolean => {
  const normalized = normalizeMiningSnapshot(source);
  if (normalized.lastRockDate) {
    return false;
  }
  return !MATERIAL_KEYS.some((key) => normalized.materials[key] > 0);
};

const createFirstRockDrops = (): MiningDrops => {
  const delta = createEmptyMaterials();
  delta.dust = 1;
  return {
    drops: ["dust"],
    delta,
  };
};

const createDropsFromRandom = (random: () => number): MiningDrops => {
  const count = 2 + Math.floor(random() * 4);
  const drops: MiningMaterialName[] = [];
  const delta = createEmptyMaterials();
  for (let index = 0; index < count; index += 1) {
    const material = pickWeightedMaterial(random);
    drops.push(material);
    delta[material] += 1;
  }
  return { drops, delta };
};

const createDeterministicDrops = (
  profileId: string,
  date: string,
): MiningDrops => {
  return createDropsFromRandom(createMiningSeededRandom(profileId, date));
};

const createDropsForMiningEvent = (
  profileId: string,
  date: string,
  miningSnapshot?: unknown,
): MiningDrops => {
  if (isFirstMiningEvent(miningSnapshot)) {
    return createFirstRockDrops();
  }
  return createDeterministicDrops(profileId, date);
};

const isMaterialName = (value: unknown): value is MiningMaterialName =>
  (MATERIAL_KEYS as readonly unknown[]).includes(value);

const normalizeCount = (value: unknown): number => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
};

const applyMaterialDeltas = (
  source?: unknown,
  deltas?: unknown,
): MiningMaterials => {
  const result = normalizeMaterials(source);
  MATERIAL_KEYS.forEach((key) => {
    const raw = deltas ? (deltas as Record<string, unknown>)[key] : undefined;
    const delta = typeof raw === "number" ? raw : Number(raw);
    const next = (result[key] ?? 0) + (Number.isFinite(delta) ? delta : 0);
    result[key] = Math.max(0, Math.round(next));
  });
  return result;
};

const applyMaterialDeltasWithCap = (
  source: unknown,
  deltas: unknown,
  totalMaterials?: unknown,
): MiningMaterials => {
  const result = applyMaterialDeltas(source, deltas);
  if (!totalMaterials) {
    return result;
  }
  const caps = normalizeMaterials(totalMaterials);
  MATERIAL_KEYS.forEach((key) => {
    result[key] = Math.min(result[key], caps[key] ?? 0);
  });
  return result;
};

const computeAvailableCount = (
  total: Partial<Record<string, number>> | null | undefined,
  frozen: Partial<Record<string, number>> | null | undefined,
  material: string,
): number => {
  return Math.max(
    0,
    (total && total[material] ? total[material] : 0) -
      (frozen && frozen[material] ? frozen[material] : 0),
  );
};

const computeAvailableMaterials = (
  total: MiningMaterials,
  frozen: MiningMaterials,
): MiningMaterials => {
  const result = createEmptyMaterials();
  MATERIAL_KEYS.forEach((key) => {
    result[key] = computeAvailableCount(total, frozen, key);
  });
  return result;
};

const computeAcceptedReservation = (
  current: unknown,
  material: string,
  proposedCount: number,
  ownProposal: WagerProposalLike | null | undefined,
  totalMaterials: unknown,
): AcceptedMaterialReservation => {
  const normalized = normalizeMaterials(current);
  const caps = normalizeMaterials(totalMaterials);
  const next: MiningMaterials & Record<string, number> = { ...normalized };
  const ownMaterial =
    ownProposal && ownProposal.material ? ownProposal.material : null;
  const ownCount = ownProposal ? normalizeCount(ownProposal.count) : 0;
  if (ownMaterial) {
    next[ownMaterial] = Math.max(0, (next[ownMaterial] ?? 0) - ownCount);
  }

  const baseFrozen = next[material] ?? 0;
  const available = computeAvailableCount(caps, next, material);
  const acceptedCount = Math.min(proposedCount, available);
  if (acceptedCount <= 0) {
    return {
      acceptedCount: 0,
      appliedDelta: null,
      materials: null,
    };
  }

  next[material] = Math.min(
    (caps as Partial<Record<string, number>>)[material] ?? 0,
    baseFrozen + acceptedCount,
  );
  const appliedDelta = MATERIAL_KEYS.reduce<Partial<MiningMaterials>>(
    (result, key) => {
      const difference = (next[key] ?? 0) - (normalized[key] ?? 0);
      if (difference !== 0) {
        result[key] = difference;
      }
      return result;
    },
    {},
  );
  return {
    acceptedCount,
    appliedDelta,
    materials: next,
  };
};

export {
  MATERIAL_KEYS,
  MINING_MATERIAL_NAMES,
  MINE_ROCK_FAILURE_REASONS,
  createEmptyMaterials,
  cloneMaterials,
  normalizeMaterials,
  sumMaterials,
  normalizeMiningSnapshot,
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
  normalizeCount,
  applyMaterialDeltas,
  applyMaterialDeltasWithCap,
  computeAvailableCount,
  computeAvailableMaterials,
  computeAcceptedReservation,
};
