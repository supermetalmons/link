// Generated from src/gameVariants.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildRandomGameSeed = exports.buildGameSeedForStoredVariant = void 0;
const game_variants_1 = require("@mons/shared/game-variants");
const monsRules_js_1 = require("./monsRules.js");
const createHelpers = (monsRules) =>
  (0, game_variants_1.createGameVariantHelpers)(monsRules);
let gameVariantHelpersPromise = null;
const loadGameVariantHelpers = () => {
  if (!gameVariantHelpersPromise) {
    gameVariantHelpersPromise = (0, monsRules_js_1.loadMonsRules)().then(
      (monsRules) => createHelpers(monsRules),
    );
  }
  return gameVariantHelpersPromise;
};
const buildGameSeedForStoredVariant = async (value) => {
  const gameVariantHelpers = await loadGameVariantHelpers();
  return gameVariantHelpers.buildGameSeedForStoredVariant(value);
};
exports.buildGameSeedForStoredVariant = buildGameSeedForStoredVariant;
const buildRandomGameSeed = async (random = Math.random) => {
  const gameVariantHelpers = await loadGameVariantHelpers();
  return gameVariantHelpers.buildRandomGameSeed(random);
};
exports.buildRandomGameSeed = buildRandomGameSeed;
