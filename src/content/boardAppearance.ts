import type { AssetsSet, BoardStyleSet } from "./boardStyleModels.ts";
import { applicationStorageKey } from "../session/applicationDataStorage.ts";

export const colorSets = {
  default: {
    darkSquare: "#BEBEBE",
    lightSquare: "#E8E8E8",
    manaPool: "#030DF4",
    pickupItemSquare: "#4F4F4F",
    simpleManaSquare: "#88A8F8",
    simpleManaSquareOnLightTile: "#D0E0FF",
    wave1: "#6666FF",
    wave2: "#00FCFF",
  },
  darkAndYellow: {
    darkSquare: "#181818",
    lightSquare: "#4A4A4A",
    manaPool: "#FDF30B",
    pickupItemSquare: "#BAB8B9",
    simpleManaSquare: "#816306",
    simpleManaSquareOnLightTile: "#A07907",
    wave1: "#D39F00",
    wave2: "#DBCF03",
  },
} as const;

export type ColorSetKey = keyof typeof colorSets;
type ColorMode = "light" | "dark";
type StoredPalettes = Record<ColorMode, string | null>;
type EarlyBoardAppearance = {
  assetsSet: AssetsSet;
  explicitStyle: BoardStyleSet | null;
  preferences: Record<ColorMode, ColorSetKey | null>;
};

declare global {
  interface Document {
    monsEarlyBoardAppearance?: EarlyBoardAppearance;
  }
}

export const boardAppearanceStorageKeys = {
  PREFERRED_ASSETS_SET: "preferredAssetsSet",
  BOARD_STYLE_SET: "boardStyleSet",
  BOARD_COLOR_SETS_BY_THEME: "boardColorSetsByTheme",
} as const;

export const defaultBoardPalettes = {
  light: "default",
  dark: "darkAndYellow",
} as const satisfies Record<ColorMode, ColorSetKey>;

const boardAppearanceSettings = {
  assetKey: applicationStorageKey(
    boardAppearanceStorageKeys.PREFERRED_ASSETS_SET,
  ),
  styleKey: applicationStorageKey(boardAppearanceStorageKeys.BOARD_STYLE_SET),
  paletteKey: applicationStorageKey(
    boardAppearanceStorageKeys.BOARD_COLOR_SETS_BY_THEME,
  ),
  palettes: Object.keys(colorSets) as ColorSetKey[],
};

export function isAssetsSet(value: unknown): value is AssetsSet {
  return value === "Pixel" || value === "Original" || value === "Pangchiu";
}

export function isBoardStyleSet(value: unknown): value is BoardStyleSet {
  return value === "Grid" || value === "Pangchiu";
}

export function isBoardColorSetsByTheme(
  value: unknown,
): value is StoredPalettes {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2
  )
    return false;
  const fields = value as { light?: unknown; dark?: unknown };
  return (
    (fields.light === null || typeof fields.light === "string") &&
    (fields.dark === null || typeof fields.dark === "string")
  );
}

function readAppearance(
  settings: typeof boardAppearanceSettings,
  validAssets: typeof isAssetsSet,
  validStyle: typeof isBoardStyleSet,
  validPalettes: typeof isBoardColorSetsByTheme,
  previous?: EarlyBoardAppearance,
) {
  const unreadable = Symbol();
  const read = (key: string): unknown => {
    let raw: string | null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      return unreadable;
    }
    try {
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const assets = read(settings.assetKey);
  const savedStyle = read(settings.styleKey);
  const theme = read(settings.paletteKey);
  const paletteValue = theme === unreadable ? previous?.preferences : theme;
  const storedPalettes = validPalettes(paletteValue)
    ? paletteValue
    : { light: null, dark: null };
  const palette = (value: string | null) =>
    settings.palettes.find((key) => key === value) ?? null;
  const assetValue = assets === unreadable ? previous?.assetsSet : assets;
  const assetsSet = validAssets(assetValue)
    ? assetValue
    : ("Pixel" as AssetsSet);
  const styleValue =
    savedStyle === unreadable ? previous?.explicitStyle : savedStyle;
  const explicitStyle = validStyle(styleValue) ? styleValue : null;
  const style =
    explicitStyle ??
    ((assetsSet === "Pangchiu" ? "Pangchiu" : "Grid") as BoardStyleSet);
  return {
    assetsSet,
    explicitStyle,
    style,
    canReadPalettes: theme !== unreadable,
    shouldPersistInferredStyle:
      explicitStyle === null &&
      savedStyle !== unreadable &&
      assets !== unreadable,
    preferences: {
      light: palette(storedPalettes.light),
      dark: palette(storedPalettes.dark),
    },
  };
}

type Appearance = ReturnType<typeof readAppearance>;

function setBoardAttributes(
  style: BoardStyleSet,
  palettes: Appearance["preferences"],
  defaults: typeof defaultBoardPalettes,
) {
  if (typeof document === "undefined") return;
  const attributes = document.documentElement.dataset;
  attributes.boardStyle = style;
  attributes.boardPaletteLight = palettes.light ?? defaults.light;
  attributes.boardPaletteDark = palettes.dark ?? defaults.dark;
}

export function displayBoardAppearance(
  style: BoardStyleSet,
  preferences: Appearance["preferences"],
) {
  setBoardAttributes(style, preferences, defaultBoardPalettes);
}

export function discardEarlyBoardAppearance() {
  if (typeof document !== "undefined") delete document.monsEarlyBoardAppearance;
}

export function readBoardAppearance() {
  const previous =
    typeof document === "undefined"
      ? undefined
      : document.monsEarlyBoardAppearance;
  discardEarlyBoardAppearance();
  return readAppearance(
    boardAppearanceSettings,
    isAssetsSet,
    isBoardStyleSet,
    isBoardColorSetsByTheme,
    previous,
  );
}

export function getBoardAppearanceScript(): string {
  const settings = JSON.stringify(boardAppearanceSettings);
  const defaults = JSON.stringify(defaultBoardPalettes);
  return `(() => { const appearance = (${readAppearance})(${settings}, ${isAssetsSet}, ${isBoardStyleSet}, ${isBoardColorSetsByTheme}); document.monsEarlyBoardAppearance = appearance; (${setBoardAttributes})(appearance.style, appearance.preferences, ${defaults}); })();`;
}
