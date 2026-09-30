// Generated from src/shared/mining.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeAcceptedReservation =
  exports.computeAvailableMaterials =
  exports.computeAvailableCount =
  exports.applyMaterialDeltasWithCap =
  exports.applyMaterialDeltas =
  exports.normalizeCount =
  exports.isMaterialName =
  exports.createDropsForMiningEvent =
  exports.createDeterministicDrops =
  exports.createDropsFromRandom =
  exports.createFirstRockDrops =
  exports.isFirstMiningEvent =
  exports.pickWeightedMaterial =
  exports.createMiningSeededRandom =
  exports.formatMiningDateUtc =
  exports.formatMiningDateLocal =
  exports.isMineRockResponse =
  exports.isMiningSnapshot =
  exports.isMiningMaterials =
  exports.normalizeMiningSnapshot =
  exports.sumMaterials =
  exports.normalizeMaterials =
  exports.cloneMaterials =
  exports.createEmptyMaterials =
  exports.MINE_ROCK_FAILURE_REASONS =
  exports.MINING_MATERIAL_NAMES =
  exports.MATERIAL_KEYS =
    void 0;
const ids_js_1 = require("./ids.js");
const MATERIAL_KEYS = Object.freeze(["dust", "slime", "gum", "metal", "ice"]);
exports.MATERIAL_KEYS = MATERIAL_KEYS;
const MINING_MATERIAL_NAMES = MATERIAL_KEYS;
exports.MINING_MATERIAL_NAMES = MINING_MATERIAL_NAMES;
const MINE_ROCK_FAILURE_REASONS = Object.freeze([
  "date-out-of-range",
  "profile-not-found",
  "date-not-advanced",
  "materials-mismatch",
]);
exports.MINE_ROCK_FAILURE_REASONS = MINE_ROCK_FAILURE_REASONS;
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value, expectedKeys) => {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeys.includes(key))
  );
};
const createEmptyMaterials = () => {
  const result = {};
  MATERIAL_KEYS.forEach((key) => {
    result[key] = 0;
  });
  return result;
};
exports.createEmptyMaterials = createEmptyMaterials;
const cloneMaterials = (source) => {
  const result = createEmptyMaterials();
  MATERIAL_KEYS.forEach((key) => {
    result[key] = source[key];
  });
  return result;
};
exports.cloneMaterials = cloneMaterials;
const normalizeMaterials = (source) => {
  const result = createEmptyMaterials();
  MATERIAL_KEYS.forEach((key) => {
    const raw = source ? source[key] : undefined;
    const numeric = typeof raw === "number" ? raw : Number(raw);
    result[key] = Number.isFinite(numeric)
      ? Math.max(0, Math.round(numeric))
      : 0;
  });
  return result;
};
exports.normalizeMaterials = normalizeMaterials;
const sumMaterials = (left, right) => {
  const result = createEmptyMaterials();
  MATERIAL_KEYS.forEach((key) => {
    result[key] = (left[key] ?? 0) + (right[key] ?? 0);
  });
  return result;
};
exports.sumMaterials = sumMaterials;
const normalizeMiningSnapshot = (source) => {
  return {
    lastRockDate:
      source && typeof source.lastRockDate === "string"
        ? source.lastRockDate
        : null,
    materials: normalizeMaterials(source && source.materials),
  };
};
exports.normalizeMiningSnapshot = normalizeMiningSnapshot;
const isMiningMaterials = (value) =>
  isRecord(value) &&
  hasExactKeys(value, MATERIAL_KEYS) &&
  MATERIAL_KEYS.every((key) => Number.isInteger(value[key]) && value[key] >= 0);
exports.isMiningMaterials = isMiningMaterials;
const isMiningSnapshot = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["lastRockDate", "materials"]) &&
  (value.lastRockDate === null || typeof value.lastRockDate === "string") &&
  isMiningMaterials(value.materials);
exports.isMiningSnapshot = isMiningSnapshot;
const isMineRockResponse = (value) => {
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
    MINE_ROCK_FAILURE_REASONS.includes(value.reason)
  );
};
exports.isMineRockResponse = isMineRockResponse;
const formatMiningDateLocal = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
exports.formatMiningDateLocal = formatMiningDateLocal;
const formatMiningDateUtc = (date) => {
  return date.toISOString().slice(0, 10);
};
exports.formatMiningDateUtc = formatMiningDateUtc;
const createMiningSeededRandom = (profileId, date) => {
  const source = profileId ? `${profileId}:${date}` : date;
  return (0, ids_js_1.createSeededRandom)(source);
};
exports.createMiningSeededRandom = createMiningSeededRandom;
const pickWeightedMaterial = (random) => {
  const value = random() * 100;
  if (value < 30) return "dust";
  if (value < 55) return "slime";
  if (value < 75) return "gum";
  if (value < 90) return "metal";
  return "ice";
};
exports.pickWeightedMaterial = pickWeightedMaterial;
const isFirstMiningEvent = (source) => {
  const normalized = normalizeMiningSnapshot(source);
  if (normalized.lastRockDate) {
    return false;
  }
  return !MATERIAL_KEYS.some((key) => normalized.materials[key] > 0);
};
exports.isFirstMiningEvent = isFirstMiningEvent;
const createFirstRockDrops = () => {
  const delta = createEmptyMaterials();
  delta.dust = 1;
  return {
    drops: ["dust"],
    delta,
  };
};
exports.createFirstRockDrops = createFirstRockDrops;
const createDropsFromRandom = (random) => {
  const count = 2 + Math.floor(random() * 4);
  const drops = [];
  const delta = createEmptyMaterials();
  for (let index = 0; index < count; index += 1) {
    const material = pickWeightedMaterial(random);
    drops.push(material);
    delta[material] += 1;
  }
  return { drops, delta };
};
exports.createDropsFromRandom = createDropsFromRandom;
const createDeterministicDrops = (profileId, date) => {
  return createDropsFromRandom(createMiningSeededRandom(profileId, date));
};
exports.createDeterministicDrops = createDeterministicDrops;
const createDropsForMiningEvent = (profileId, date, miningSnapshot) => {
  if (isFirstMiningEvent(miningSnapshot)) {
    return createFirstRockDrops();
  }
  return createDeterministicDrops(profileId, date);
};
exports.createDropsForMiningEvent = createDropsForMiningEvent;
const isMaterialName = (value) => MATERIAL_KEYS.includes(value);
exports.isMaterialName = isMaterialName;
const normalizeCount = (value) => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
};
exports.normalizeCount = normalizeCount;
const applyMaterialDeltas = (source, deltas) => {
  const result = normalizeMaterials(source);
  MATERIAL_KEYS.forEach((key) => {
    const raw = deltas ? deltas[key] : undefined;
    const delta = typeof raw === "number" ? raw : Number(raw);
    const next = (result[key] ?? 0) + (Number.isFinite(delta) ? delta : 0);
    result[key] = Math.max(0, Math.round(next));
  });
  return result;
};
exports.applyMaterialDeltas = applyMaterialDeltas;
const applyMaterialDeltasWithCap = (source, deltas, totalMaterials) => {
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
exports.applyMaterialDeltasWithCap = applyMaterialDeltasWithCap;
const computeAvailableCount = (total, frozen, material) => {
  return Math.max(
    0,
    (total && total[material] ? total[material] : 0) -
      (frozen && frozen[material] ? frozen[material] : 0),
  );
};
exports.computeAvailableCount = computeAvailableCount;
const computeAvailableMaterials = (total, frozen) => {
  const result = createEmptyMaterials();
  MATERIAL_KEYS.forEach((key) => {
    result[key] = computeAvailableCount(total, frozen, key);
  });
  return result;
};
exports.computeAvailableMaterials = computeAvailableMaterials;
const computeAcceptedReservation = (
  current,
  material,
  proposedCount,
  ownProposal,
  totalMaterials,
) => {
  const normalized = normalizeMaterials(current);
  const caps = normalizeMaterials(totalMaterials);
  const next = { ...normalized };
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
  next[material] = Math.min(caps[material] ?? 0, baseFrozen + acceptedCount);
  const appliedDelta = MATERIAL_KEYS.reduce((result, key) => {
    const difference = (next[key] ?? 0) - (normalized[key] ?? 0);
    if (difference !== 0) {
      result[key] = difference;
    }
    return result;
  }, {});
  return {
    acceptedCount,
    appliedDelta,
    materials: next,
  };
};
exports.computeAcceptedReservation = computeAcceptedReservation;
