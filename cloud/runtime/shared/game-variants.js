"use strict";

const { createSeededRandom } = require("./ids");

const legacyDefaultGameVariant = "Classic";

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
    return buildRandomGameSeed(createSeededRandom(seedValue));
  }

  return {
    buildDeterministicGameSeed,
    buildGameSeedForStoredVariant,
    buildRandomGameSeed,
    createGameModelForStoredVariant,
    getAllGameVariantNames,
    getStoredGameVariantForPersistence,
    legacyDefaultGameVariant,
    normalizeStoredGameVariant,
  };
}

module.exports = {
  createGameVariantHelpers,
  legacyDefaultGameVariant,
};
