import { createSeededRandom } from "./ids.js";

export type StoredGameVariant<
  TGameVariants extends object = Record<string, string>,
> = Extract<TGameVariants[keyof TGameVariants], string>;

export type GameSeed<TGameVariant extends string = string> = {
  gameVariant: TGameVariant;
  fen: string;
};

export interface GameModelWithFen {
  toFen(): string;
}

export type GameVariantHelpers<
  TGameVariant extends string = string,
  TGameModel extends GameModelWithFen = GameModelWithFen,
> = {
  legacyDefaultGameVariant: TGameVariant;
  getAllGameVariantNames(): TGameVariant[];
  normalizeStoredGameVariant(value: unknown): TGameVariant;
  getStoredGameVariantForPersistence(value: unknown): string;
  createGameModelForStoredVariant(value: unknown): TGameModel;
  buildGameSeedForStoredVariant(value: unknown): GameSeed<TGameVariant>;
  buildRandomGameSeed(random?: () => number): GameSeed<TGameVariant>;
  buildDeterministicGameSeed(seedValue: string): GameSeed<TGameVariant>;
};

const legacyDefaultGameVariant = "Classic";

function createGameVariantHelpers<
  TGameVariants extends { readonly Classic: "Classic" },
  TGameModel extends GameModelWithFen,
>(monsRules: {
  GameVariant: TGameVariants;
  Game: new (options?: {
    variant?: StoredGameVariant<TGameVariants>;
  }) => TGameModel;
}): GameVariantHelpers<StoredGameVariant<TGameVariants>, TGameModel> {
  function getAllGameVariantNames(): StoredGameVariant<TGameVariants>[] {
    const variants = Object.values(monsRules.GameVariant).filter(
      (variant) => typeof variant === "string",
    );
    return (
      variants.length > 0 ? variants : [legacyDefaultGameVariant]
    ) as StoredGameVariant<TGameVariants>[];
  }

  function normalizeStoredGameVariant(
    value: unknown,
  ): StoredGameVariant<TGameVariants> {
    if (typeof value !== "string") {
      return legacyDefaultGameVariant as StoredGameVariant<TGameVariants>;
    }
    const normalized = value.trim();
    return (
      (getAllGameVariantNames() as readonly string[]).includes(normalized)
        ? normalized
        : legacyDefaultGameVariant
    ) as StoredGameVariant<TGameVariants>;
  }

  function getStoredGameVariantForPersistence(value: unknown): string {
    if (typeof value !== "string") {
      return legacyDefaultGameVariant as StoredGameVariant<TGameVariants>;
    }
    const normalized = value.trim();
    return normalized !== "" ? normalized : legacyDefaultGameVariant;
  }

  function runtimeGameVariantFromStoredValue(
    value: unknown,
  ): StoredGameVariant<TGameVariants> {
    return normalizeStoredGameVariant(value);
  }

  function createGameModelForStoredVariant(value: unknown): TGameModel {
    return new monsRules.Game({
      variant: runtimeGameVariantFromStoredValue(value),
    });
  }

  function buildGameSeedForStoredVariant(
    value: unknown,
  ): GameSeed<StoredGameVariant<TGameVariants>> {
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

  function buildDeterministicGameSeed(seedValue: string) {
    return buildRandomGameSeed(createSeededRandom(seedValue));
  }

  return {
    buildDeterministicGameSeed,
    buildGameSeedForStoredVariant,
    buildRandomGameSeed,
    createGameModelForStoredVariant,
    getAllGameVariantNames,
    getStoredGameVariantForPersistence,
    legacyDefaultGameVariant:
      legacyDefaultGameVariant as StoredGameVariant<TGameVariants>,
    normalizeStoredGameVariant,
  };
}

export { createGameVariantHelpers, legacyDefaultGameVariant };
