import { createGameVariantHelpers } from "@mons/shared/game-variants";
import { loadMonsRules } from "./monsRules.js";

const createHelpers = (monsRules: Awaited<ReturnType<typeof loadMonsRules>>) =>
  createGameVariantHelpers(monsRules);
let gameVariantHelpersPromise: Promise<
  ReturnType<typeof createHelpers>
> | null = null;

const loadGameVariantHelpers = () => {
  if (!gameVariantHelpersPromise) {
    gameVariantHelpersPromise = loadMonsRules().then((monsRules) =>
      createHelpers(monsRules),
    );
  }
  return gameVariantHelpersPromise;
};

export const buildGameSeedForStoredVariant = async (value: unknown) => {
  const gameVariantHelpers = await loadGameVariantHelpers();
  return gameVariantHelpers.buildGameSeedForStoredVariant(value);
};

export const buildRandomGameSeed = async (random = Math.random) => {
  const gameVariantHelpers = await loadGameVariantHelpers();
  return gameVariantHelpers.buildRandomGameSeed(random);
};
