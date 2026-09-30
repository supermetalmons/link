// Generated from src/shared/game-variants.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.legacyDefaultGameVariant = void 0;
exports.createGameVariantHelpers = createGameVariantHelpers;
const ids_js_1 = require("./ids.js");
const legacyDefaultGameVariant = "Classic";
exports.legacyDefaultGameVariant = legacyDefaultGameVariant;
function createGameVariantHelpers(monsRules) {
  function getAllGameVariantNames() {
    const variants = Object.values(monsRules.GameVariant).filter(
      (variant) => typeof variant === "string",
    );
    return variants.length > 0 ? variants : [legacyDefaultGameVariant];
  }
  function normalizeStoredGameVariant(value) {
    if (typeof value !== "string") {
      return legacyDefaultGameVariant;
    }
    const normalized = value.trim();
    return getAllGameVariantNames().includes(normalized)
      ? normalized
      : legacyDefaultGameVariant;
  }
  function getStoredGameVariantForPersistence(value) {
    if (typeof value !== "string") {
      return legacyDefaultGameVariant;
    }
    const normalized = value.trim();
    return normalized !== "" ? normalized : legacyDefaultGameVariant;
  }
  function runtimeGameVariantFromStoredValue(value) {
    return normalizeStoredGameVariant(value);
  }
  function createGameModelForStoredVariant(value) {
    return new monsRules.Game({
      variant: runtimeGameVariantFromStoredValue(value),
    });
  }
  function buildGameSeedForStoredVariant(value) {
    const gameVariant = normalizeStoredGameVariant(value);
    return {
      gameVariant,
      fen: createGameModelForStoredVariant(gameVariant).toFen(),
    };
  }
  function buildRandomGameSeed(random = Math.random) {
    const variants = getAllGameVariantNames();
    const variantIndex =
      variants.length <= 1 ? 0 : Math.floor(random() * variants.length);
    return buildGameSeedForStoredVariant(
      variants[variantIndex] || legacyDefaultGameVariant,
    );
  }
  function buildDeterministicGameSeed(seedValue) {
    return buildRandomGameSeed((0, ids_js_1.createSeededRandom)(seedValue));
  }
  return {
    buildDeterministicGameSeed,
    buildGameSeedForStoredVariant,
    buildRandomGameSeed,
    createGameModelForStoredVariant,
    getAllGameVariantNames,
    getStoredGameVariantForPersistence,
    legacyDefaultGameVariant: legacyDefaultGameVariant,
    normalizeStoredGameVariant,
  };
}
