const { createGameVariantHelpers } = require("@mons/shared/game-variants");
const { loadMonsRules } = require("./monsRules");

let gameVariantHelpersPromise = null;

const loadGameVariantHelpers = () => {
  if (!gameVariantHelpersPromise) {
    gameVariantHelpersPromise = loadMonsRules().then((monsRules) =>
      createGameVariantHelpers(monsRules),
    );
  }
  return gameVariantHelpersPromise;
};

const buildGameSeedForStoredVariant = async (value) => {
  const gameVariantHelpers = await loadGameVariantHelpers();
  return gameVariantHelpers.buildGameSeedForStoredVariant(value);
};

const buildRandomGameSeed = async (random = Math.random) => {
  const gameVariantHelpers = await loadGameVariantHelpers();
  return gameVariantHelpers.buildRandomGameSeed(random);
};

module.exports = {
  buildGameSeedForStoredVariant,
  buildRandomGameSeed,
};
