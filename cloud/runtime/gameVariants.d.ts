// Generated from src/gameVariants.ts. Run npm run generate:runtime.
export declare const buildGameSeedForStoredVariant: (
  value: unknown,
) => Promise<
  import("@mons/shared/game-variants").GameSeed<
    | "Classic"
    | "SwappedManaRows"
    | "OffsetArcManaRows"
    | "CenterSpokeManaRows"
    | "AlternatingManaRows"
    | "InnerWedgeManaRows"
    | "OuterWedgeManaRows"
    | "BentCenterManaRows"
    | "OuterEdgeManaRows"
    | "SplitFlankManaRows"
    | "ForwardBridgeManaRows"
    | "CornerChainManaRows"
  >
>;
export declare const buildRandomGameSeed: (
  random?: () => number,
) => Promise<
  import("@mons/shared/game-variants").GameSeed<
    | "Classic"
    | "SwappedManaRows"
    | "OffsetArcManaRows"
    | "CenterSpokeManaRows"
    | "AlternatingManaRows"
    | "InnerWedgeManaRows"
    | "OuterWedgeManaRows"
    | "BentCenterManaRows"
    | "OuterEdgeManaRows"
    | "SplitFlankManaRows"
    | "ForwardBridgeManaRows"
    | "CornerChainManaRows"
  >
>;
