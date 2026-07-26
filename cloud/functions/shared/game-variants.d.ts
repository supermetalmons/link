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

export const legacyDefaultGameVariant: "Classic";

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

export function createGameVariantHelpers<
  TGameVariants extends { readonly Classic: "Classic" },
  TGameModel extends GameModelWithFen,
>(monsRules: {
  GameVariant: TGameVariants;
  Game: new (options?: {
    variant?: StoredGameVariant<TGameVariants>;
  }) => TGameModel;
}): GameVariantHelpers<StoredGameVariant<TGameVariants>, TGameModel>;
