import type { AssetsSet, BoardStyleSet } from "../content/boardStyles";

export type AuthIdentity = {
  profileId: string;
  ethAddress: string;
  solAddress: string;
};

export type ReactionExtraStickerCache = AuthIdentity & {
  extraIds: number[];
  expiresAtMs: number;
};

const STORAGE_KEYS = {
  IS_MUTED: "isMuted",

  PREFERRED_ASSETS_SET: "preferredAssetsSet",
  BOARD_STYLE_SET: "boardStyleSet",
  BOARD_COLOR_SET: "boardColorSet",
  BOARD_COLOR_SETS_BY_THEME: "boardColorSetsByTheme",
  IS_EXPERIMENTING_WITH_SPRITES: "isExperimentingWithSprites",

  PLAYER_EMOJI_ID: "playerEmojiId",
  PLAYER_EMOJI_AURA: "playerEmojiAura",
  LOGIN_ID: "loginId",
  PROFILE_ID: "profileId",
  ETH_ADDRESS: "ethAddress",
  SOL_ADDRESS: "solAddress",
  USERNAME: "username",
  PLAYER_RATING: "playerRating",
  PLAYER_TOTAL_MANA_POINTS: "playerTotalManaPoints",
  PLAYER_MINING_LAST_ROCK_DATE: "playerMiningLastRockDate",
  PLAYER_MINING_MATERIALS: "playerMiningMaterials",
  CARD_BACKGROUND_ID: "cardBackgroundId",
  CARD_SUBTITLE_ID: "cardSubtitleId",
  CARD_STICKERS: "cardStickers",
  REACTION_EXTRA_STICKER_CACHE: "reactionExtraStickerCache",
  REACTION_EXTRA_STICKER_IDS: "reactionExtraStickerIds",
  REACTION_EXTRA_STICKER_PROFILE_ID: "reactionExtraStickerProfileId",
  PROFILE_MONS: "profileMons",
  PROFILE_COUNTER: "profileCounter",
  PLAYER_NONCE: "playerNonce",
  COMPLETED_PROBLEMS: "completedProblems",
  TUTORIAL_COMPLETED: "tutorialCompleted",
  IS_FIRST_LAUNCH: "isFirstLaunch",
  ISLAND_MON_TYPE: "islandMonType",
  LEADERBOARD_TYPE: "leaderboardType",
  BOT_AUTOMOVE_MODE: "botAutomoveMode",
} as const;

type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

const LOGOUT_PRESERVED_STORAGE_KEYS = new Set<string>([STORAGE_KEYS.IS_MUTED]);

export const shouldPreserveStorageKeyOnLogout = (key: string): boolean => {
  return LOGOUT_PRESERVED_STORAGE_KEYS.has(key);
};

const EXTERNAL_USER_STORAGE_KEY_PREFIXES = [
  "wagmi",
  "wc@",
  "walletconnect",
  "rainbow",
  "rk-",
];
const EXTERNAL_USER_STORAGE_KEY_EXACT = [
  "WALLETCONNECT_DEEPLINK_CHOICE",
  "ethIntentByNonceV1",
];

const shouldClearExternalUserStorageKey = (key: string): boolean => {
  if (EXTERNAL_USER_STORAGE_KEY_EXACT.includes(key)) {
    return true;
  }
  return EXTERNAL_USER_STORAGE_KEY_PREFIXES.some((prefix) =>
    key.startsWith(prefix),
  );
};

const removeMatchingStorageKeys = (
  store: Storage,
  predicate: (key: string) => boolean,
): void => {
  const keysToRemove: string[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key && predicate(key)) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => store.removeItem(key));
};

function getItem<T>(key: StorageKey | string, defaultValue: T): T {
  const item = localStorage.getItem(key);
  if (item === null || item === "null") return defaultValue;
  try {
    return JSON.parse(item) as T;
  } catch {
    return item as unknown as T;
  }
}

function setItem<T>(key: StorageKey | string, value: T): void {
  if (value === null) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(
    key,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

export const storage = {
  getAuthIdentity: (): AuthIdentity => ({
    profileId: getItem(STORAGE_KEYS.PROFILE_ID, ""),
    ethAddress: getItem(STORAGE_KEYS.ETH_ADDRESS, ""),
    solAddress: getItem(STORAGE_KEYS.SOL_ADDRESS, ""),
  }),

  getIsMuted: (defaultValue: boolean): boolean => {
    try {
      const storedValue = getItem<unknown>(STORAGE_KEYS.IS_MUTED, defaultValue);
      return typeof storedValue === "boolean" ? storedValue : defaultValue;
    } catch {
      return defaultValue;
    }
  },

  setIsMuted: (value: boolean): void => {
    setItem(STORAGE_KEYS.IS_MUTED, value);
  },

  getPreferredAssetsSet: (defaultValue: AssetsSet): AssetsSet => {
    return getItem(STORAGE_KEYS.PREFERRED_ASSETS_SET, defaultValue);
  },

  setPreferredAssetsSet: (value: AssetsSet): void => {
    setItem(STORAGE_KEYS.PREFERRED_ASSETS_SET, value);
  },

  getBoardStyleSet: (
    defaultValue: BoardStyleSet | null,
  ): BoardStyleSet | null => {
    return getItem(STORAGE_KEYS.BOARD_STYLE_SET, defaultValue);
  },

  setBoardStyleSet: (value: BoardStyleSet | null): void => {
    setItem(STORAGE_KEYS.BOARD_STYLE_SET, value);
  },

  getBoardColorSet: (defaultValue: string): string => {
    return getItem(STORAGE_KEYS.BOARD_COLOR_SET, defaultValue);
  },

  setBoardColorSet: (value: string): void => {
    setItem(STORAGE_KEYS.BOARD_COLOR_SET, value);
  },

  getBoardColorSetsByTheme: (defaultValue: {
    light: string | null;
    dark: string | null;
  }): { light: string | null; dark: string | null } => {
    return getItem(STORAGE_KEYS.BOARD_COLOR_SETS_BY_THEME, defaultValue);
  },

  setBoardColorSetsByTheme: (value: {
    light: string | null;
    dark: string | null;
  }): void => {
    setItem(STORAGE_KEYS.BOARD_COLOR_SETS_BY_THEME, value);
  },

  getIsExperimentingWithSprites: (defaultValue: boolean): boolean => {
    return getItem(STORAGE_KEYS.IS_EXPERIMENTING_WITH_SPRITES, defaultValue);
  },

  setIsExperimentingWithSprites: (value: boolean): void => {
    setItem(STORAGE_KEYS.IS_EXPERIMENTING_WITH_SPRITES, value);
  },

  getPlayerEmojiId: (defaultValue: string): string => {
    return getItem(STORAGE_KEYS.PLAYER_EMOJI_ID, defaultValue);
  },

  setPlayerEmojiId: (value: string): void => {
    setItem(STORAGE_KEYS.PLAYER_EMOJI_ID, value);
  },

  getPlayerEmojiAura: (defaultValue: string): string => {
    return getItem(STORAGE_KEYS.PLAYER_EMOJI_AURA, defaultValue);
  },

  setPlayerEmojiAura: (value: string): void => {
    setItem(STORAGE_KEYS.PLAYER_EMOJI_AURA, value);
  },

  getProfileId: (defaultValue: string): string => {
    return getItem(STORAGE_KEYS.PROFILE_ID, defaultValue);
  },

  setProfileId: (value: string): void => {
    setItem(STORAGE_KEYS.PROFILE_ID, value);
  },

  getLoginId: (defaultValue: string): string => {
    return getItem(STORAGE_KEYS.LOGIN_ID, defaultValue);
  },

  setLoginId: (value: string): void => {
    setItem(STORAGE_KEYS.LOGIN_ID, value);
  },

  getEthAddress: (defaultValue: string): string => {
    return getItem(STORAGE_KEYS.ETH_ADDRESS, defaultValue);
  },

  setEthAddress: (value: string): void => {
    setItem(STORAGE_KEYS.ETH_ADDRESS, value);
  },

  getSolAddress: (defaultValue: string): string => {
    return getItem(STORAGE_KEYS.SOL_ADDRESS, defaultValue);
  },

  setSolAddress: (value: string): void => {
    setItem(STORAGE_KEYS.SOL_ADDRESS, value);
  },

  getUsername: (defaultValue: string): string => {
    return getItem(STORAGE_KEYS.USERNAME, defaultValue);
  },

  setUsername: (value: string): void => {
    setItem(STORAGE_KEYS.USERNAME, value);
  },

  getPlayerRating: (defaultValue: number): number => {
    return getItem(STORAGE_KEYS.PLAYER_RATING, defaultValue);
  },

  setPlayerRating: (value: number): void => {
    setItem(STORAGE_KEYS.PLAYER_RATING, value);
  },

  getPlayerTotalManaPoints: (defaultValue: number): number => {
    return getItem(STORAGE_KEYS.PLAYER_TOTAL_MANA_POINTS, defaultValue);
  },

  setPlayerTotalManaPoints: (value: number): void => {
    setItem(STORAGE_KEYS.PLAYER_TOTAL_MANA_POINTS, value);
  },

  getMiningLastRockDate: (defaultValue: string | null): string | null => {
    return getItem(STORAGE_KEYS.PLAYER_MINING_LAST_ROCK_DATE, defaultValue);
  },

  setMiningLastRockDate: (value: string | null): void => {
    setItem(STORAGE_KEYS.PLAYER_MINING_LAST_ROCK_DATE, value);
  },

  getMiningMaterials: (
    defaultValue: Record<string, number>,
  ): Record<string, number> => {
    return getItem(STORAGE_KEYS.PLAYER_MINING_MATERIALS, defaultValue);
  },

  setMiningMaterials: (value: Record<string, number>): void => {
    setItem(STORAGE_KEYS.PLAYER_MINING_MATERIALS, value);
  },

  getCardBackgroundId: (defaultValue: number): number => {
    return getItem(STORAGE_KEYS.CARD_BACKGROUND_ID, defaultValue);
  },

  setCardBackgroundId: (value: number): void => {
    setItem(STORAGE_KEYS.CARD_BACKGROUND_ID, value);
  },

  getCardSubtitleId: (defaultValue: number): number => {
    return getItem(STORAGE_KEYS.CARD_SUBTITLE_ID, defaultValue);
  },

  setCardSubtitleId: (value: number): void => {
    setItem(STORAGE_KEYS.CARD_SUBTITLE_ID, value);
  },

  getProfileCounter: (defaultValue: string): string => {
    return getItem(STORAGE_KEYS.PROFILE_COUNTER, defaultValue);
  },

  setProfileCounter: (value: string): void => {
    setItem(STORAGE_KEYS.PROFILE_COUNTER, value);
  },

  getCardStickers: (defaultValue: string): string => {
    return JSON.stringify(getItem(STORAGE_KEYS.CARD_STICKERS, defaultValue));
  },

  setCardStickers: (value: string): void => {
    setItem(STORAGE_KEYS.CARD_STICKERS, value);
  },

  getReactionExtraStickerCache: (
    defaultValue: ReactionExtraStickerCache | null,
  ): ReactionExtraStickerCache | null => {
    const value = getItem<unknown>(
      STORAGE_KEYS.REACTION_EXTRA_STICKER_CACHE,
      defaultValue,
    );
    if (typeof value !== "object" || value === null) {
      return defaultValue;
    }
    const cache = value as Record<string, unknown>;
    if (
      typeof cache.profileId !== "string" ||
      typeof cache.ethAddress !== "string" ||
      typeof cache.solAddress !== "string" ||
      !Array.isArray(cache.extraIds) ||
      typeof cache.expiresAtMs !== "number" ||
      !Number.isFinite(cache.expiresAtMs)
    ) {
      return defaultValue;
    }
    return {
      profileId: cache.profileId,
      ethAddress: cache.ethAddress,
      solAddress: cache.solAddress,
      extraIds: cache.extraIds.filter(
        (id): id is number =>
          typeof id === "number" && Number.isSafeInteger(id),
      ),
      expiresAtMs: cache.expiresAtMs,
    };
  },

  setReactionExtraStickerCache: (
    value: ReactionExtraStickerCache | null,
  ): void => {
    setItem(STORAGE_KEYS.REACTION_EXTRA_STICKER_CACHE, value);
  },

  getProfileMons: (defaultValue: string): string => {
    return getItem(STORAGE_KEYS.PROFILE_MONS, defaultValue);
  },

  setProfileMons: (value: string): void => {
    setItem(STORAGE_KEYS.PROFILE_MONS, value);
  },

  getPlayerNonce: (defaultValue: number): number => {
    return getItem(STORAGE_KEYS.PLAYER_NONCE, defaultValue);
  },

  setPlayerNonce: (value: number): void => {
    setItem(STORAGE_KEYS.PLAYER_NONCE, value);
  },

  getCompletedProblemIds: (defaultValue: string[]): string[] => {
    return getItem(STORAGE_KEYS.COMPLETED_PROBLEMS, defaultValue);
  },

  setCompletedProblemIds: (value: string[]): void => {
    setItem(STORAGE_KEYS.COMPLETED_PROBLEMS, value);
  },

  addCompletedProblemId: (id: string): void => {
    const current = getItem<string[]>(STORAGE_KEYS.COMPLETED_PROBLEMS, []);
    if (!current.includes(id)) {
      current.push(id);
      setItem(STORAGE_KEYS.COMPLETED_PROBLEMS, current);
    }
  },

  getTutorialCompleted: (defaultValue: boolean): boolean => {
    return getItem(STORAGE_KEYS.TUTORIAL_COMPLETED, defaultValue);
  },

  setTutorialCompleted: (value: boolean): void => {
    setItem(STORAGE_KEYS.TUTORIAL_COMPLETED, value);
  },

  isFirstLaunch: (): boolean => {
    return getItem(STORAGE_KEYS.IS_FIRST_LAUNCH, true);
  },

  trackFirstLaunch: (): void => {
    setItem(STORAGE_KEYS.IS_FIRST_LAUNCH, false);
  },

  getIslandMonType: (defaultValue: string): string => {
    return getItem(STORAGE_KEYS.ISLAND_MON_TYPE, defaultValue);
  },

  setIslandMonType: (value: string): void => {
    setItem(STORAGE_KEYS.ISLAND_MON_TYPE, value);
  },

  getLeaderboardType: (defaultValue: string): string => {
    return getItem(STORAGE_KEYS.LEADERBOARD_TYPE, defaultValue);
  },

  setLeaderboardType: (value: string): void => {
    setItem(STORAGE_KEYS.LEADERBOARD_TYPE, value);
  },

  getBotAutomoveMode: (defaultValue: string): string => {
    return getItem(STORAGE_KEYS.BOT_AUTOMOVE_MODE, defaultValue);
  },

  setBotAutomoveMode: (value: string): void => {
    setItem(STORAGE_KEYS.BOT_AUTOMOVE_MODE, value);
  },

  signOut: (): void => {
    Object.values(STORAGE_KEYS).forEach((key) => {
      if (!shouldPreserveStorageKeyOnLogout(key)) {
        localStorage.removeItem(key);
      }
    });
    removeMatchingStorageKeys(localStorage, shouldClearExternalUserStorageKey);
    removeMatchingStorageKeys(
      sessionStorage,
      shouldClearExternalUserStorageKey,
    );
  },
};
