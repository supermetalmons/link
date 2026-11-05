import {
  readBoardAppearance,
  displayBoardAppearance,
  defaultBoardPalettes,
  colorSets,
  type ColorSetKey,
} from "./boardAppearance";
import { storage } from "../utils/storage";
import { notifyBoardColorChange } from "./boardStyleRuntimePort";
import { AssetsSet, BoardStyleSet } from "./boardStyleModels";

export { AssetsSet, BoardStyleSet } from "./boardStyleModels";

export { colorSets, type ColorSetKey } from "./boardAppearance";

export function saveBoardPreference(write: () => void) {
  try {
    write();
  } catch {}
}

const appearance = readBoardAppearance();
displayBoardAppearance(appearance.style, appearance.preferences);
export let currentAssetsSet: AssetsSet = appearance.assetsSet;
const assetsSetListeners = new Set<() => void>();
const notifyAssetsSetListeners = () => {
  assetsSetListeners.forEach((listener) => listener());
};

export const subscribeToAssetsSetChanges = (listener: () => void) => {
  assetsSetListeners.add(listener);
  return () => {
    assetsSetListeners.delete(listener);
  };
};

export const getCurrentAssetsSet = () => currentAssetsSet;

export function setCurrentAssetsSet(set: AssetsSet) {
  saveBoardPreference(() => storage.setPreferredAssetsSet(set));
  if (currentAssetsSet === set) {
    return;
  }
  currentAssetsSet = set;
  notifyAssetsSetListeners();
}

let currentBoardStyleSet: BoardStyleSet = appearance.style;
if (appearance.shouldPersistInferredStyle) {
  saveBoardPreference(() => storage.setBoardStyleSet(currentBoardStyleSet));
}

const boardStyleSetListeners = new Set<() => void>();
const notifyBoardStyleSetListeners = () => {
  boardStyleSetListeners.forEach((listener) => listener());
};

export const subscribeToBoardStyleSetChanges = (listener: () => void) => {
  boardStyleSetListeners.add(listener);
  return () => {
    boardStyleSetListeners.delete(listener);
  };
};

export const getCurrentBoardStyleSet = () => currentBoardStyleSet;

export function setCurrentBoardStyleSet(set: BoardStyleSet): boolean {
  saveBoardPreference(() => storage.setBoardStyleSet(set));
  if (currentBoardStyleSet === set) {
    return false;
  }
  currentBoardStyleSet = set;
  displayBoardAppearance(set, colorSetPreferencesByMode);
  notifyBoardStyleSetListeners();
  return true;
}

export const isPangchiuBoard = () =>
  currentBoardStyleSet === BoardStyleSet.Pangchiu;
export const isCustomPictureBoardEnabled = () =>
  currentBoardStyleSet !== BoardStyleSet.Grid;

export const colors = {
  attackTarget: "#941651",
  get destination() {
    return isPangchiuBoard() ? "#00BC00" : "#009500";
  },
  spiritTarget: "#FF84FF",
  startFromSuggestion: "#FEFB00",
  selectedItem: "#00F900",
  rainbow: {
    1: "#FF2F92", // Pink
    2: "#FFD478", // Orange
    3: "#FFFB78", // Yellow
    4: "#72FA78", // Green
    5: "#73FDFF", // Cyan
    6: "#75D5FF", // Light Blue
    7: "#D783FF", // Purple
  } as { [key: string]: string },

  pangchiuBoardRainbow: {
    1: "#E01B75", // Pink
    2: "#FFB23D", // Orange
    3: "#FFE83D", // Yellow
    4: "#47D14D", // Green
    5: "#33F2FF", // Cyan
    6: "#29B8FF", // Light Blue
    7: "#B347FF", // Purple
  } as { [key: string]: string },

  getRainbow: function (index: string) {
    return isPangchiuBoard()
      ? this.pangchiuBoardRainbow[index]
      : this.rainbow[index];
  },
  itemSelectionBackground: "rgba(0, 0, 0, 0.5)",
  scoreText: "gray",

  get wave1() {
    return colorSets[currentColorSetKey].wave1;
  },
  get wave2() {
    return colorSets[currentColorSetKey].wave2;
  },
  get manaPool() {
    return colorSets[currentColorSetKey].manaPool;
  },
  get lightSquare() {
    return colorSets[currentColorSetKey].lightSquare;
  },
  get darkSquare() {
    return colorSets[currentColorSetKey].darkSquare;
  },

  sparkleLight: "#FEFEFE",
  sparkleDark: "#000",
  startFromStroke: "#fbbf24",
};

export type ColorSet = {
  darkSquare: string;
  lightSquare: string;
  manaPool: string;
  pickupItemSquare: string;
  simpleManaSquare: string;
  simpleManaSquareOnLightTile: string;
  wave1: string;
  wave2: string;
};

type ColorMode = "light" | "dark";

const getSystemColorMode = (): ColorMode => {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
};

let colorSetPreferencesByMode = appearance.preferences;
let pendingPaletteEdits: Partial<Record<ColorMode, ColorSetKey>> = {};

const resolveColorSetKeyForMode = (mode: ColorMode): ColorSetKey => {
  return colorSetPreferencesByMode[mode] ?? defaultBoardPalettes[mode];
};

let currentColorMode: ColorMode = getSystemColorMode();
let currentColorSetKey: ColorSetKey =
  resolveColorSetKeyForMode(currentColorMode);

const boardColorSetListeners = new Set<() => void>();

const notifyBoardColorSetListeners = () => {
  boardColorSetListeners.forEach((listener) => listener());
};

const applyColorMode = (mode: ColorMode) => {
  currentColorMode = mode;
  currentColorSetKey = resolveColorSetKeyForMode(mode);
  notifyBoardColorChange();
  notifyBoardColorSetListeners();
};

export const getCurrentColorSetKey = () => currentColorSetKey;

export const subscribeToBoardColorSetChanges = (listener: () => void) => {
  boardColorSetListeners.add(listener);
  return () => {
    boardColorSetListeners.delete(listener);
  };
};

export const setBoardColorSet = (colorSetKey: ColorSetKey) => {
  pendingPaletteEdits[currentColorMode] = colorSetKey;
  const latest = readBoardAppearance();
  colorSetPreferencesByMode = {
    ...(latest.canReadPalettes
      ? latest.preferences
      : colorSetPreferencesByMode),
    ...pendingPaletteEdits,
  };
  displayBoardAppearance(currentBoardStyleSet, colorSetPreferencesByMode);
  if (latest.canReadPalettes) {
    saveBoardPreference(() => {
      storage.setBoardColorSetsByTheme(colorSetPreferencesByMode);
      pendingPaletteEdits = {};
    });
  }
  applyColorMode(currentColorMode);
};

if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleSystemThemeChange = (event: MediaQueryListEvent) => {
    applyColorMode(event.matches ? "dark" : "light");
  };
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", handleSystemThemeChange);
  } else if (typeof mediaQuery.addListener === "function") {
    mediaQuery.addListener(handleSystemThemeChange);
  }
}
