import type { AssetsSet, BoardStyleSet } from "../content/boardStyleModels";
import type { EmojiId } from "../content/emojis";
import { GAME_SESSION_OPERATION_ID_PATTERN } from "@mons/shared/game-sessions";
import { isSafeRecordKey } from "@mons/shared/ids";
import { isRetiredSessionStorageKey } from "./sessionStorageCompatibility.js";
import {
  isStartAutomatchRequest,
  type StartAutomatchRequest,
} from "@mons/shared/navigation";

export type AuthIdentity = {
  profileId: string;
  ethAddress: string;
  solAddress: string;
};

export type ReactionExtraStickerCache = AuthIdentity & {
  extraIds: number[];
  expiresAtMs: number;
};

export type PendingAutomatchOperation = {
  createdAtMs: number;
  operationId: string;
  request: StartAutomatchRequest;
  resolvedInviteId: string | null;
  uid: string;
};

const PENDING_AUTOMATCH_OPERATION_PREFIX = "pendingAutomatchOperation:";

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
const SESSION_RESET_PRESERVED_STORAGE_KEYS = new Set<string>([
  STORAGE_KEYS.IS_MUTED,
  STORAGE_KEYS.PREFERRED_ASSETS_SET,
  STORAGE_KEYS.BOARD_STYLE_SET,
  STORAGE_KEYS.BOARD_COLOR_SET,
  STORAGE_KEYS.BOARD_COLOR_SETS_BY_THEME,
  STORAGE_KEYS.IS_EXPERIMENTING_WITH_SPRITES,
  STORAGE_KEYS.IS_FIRST_LAUNCH,
  STORAGE_KEYS.ISLAND_MON_TYPE,
  STORAGE_KEYS.LEADERBOARD_TYPE,
  STORAGE_KEYS.BOT_AUTOMOVE_MODE,
]);

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

type BoardColorSetsByTheme = { light: string | null; dark: string | null };

type StorageReadValues = {
  isMuted: boolean;
  preferredAssetsSet: AssetsSet;
  boardStyleSet: BoardStyleSet | null;
  boardColorSet: string;
  boardColorSetsByTheme: BoardColorSetsByTheme;
  isExperimentingWithSprites: boolean;
  playerEmojiId: EmojiId;
  playerEmojiAura: string;
  loginId: string;
  profileId: string;
  ethAddress: string;
  solAddress: string;
  username: string;
  playerRating: number;
  playerTotalManaPoints: number;
  playerMiningLastRockDate: string | null;
  playerMiningMaterials: Record<string, number>;
  cardBackgroundId: number;
  cardSubtitleId: number;
  profileMons: string;
  profileCounter: string;
  playerNonce: number;
  completedProblems: string[];
  tutorialCompleted: boolean;
  isFirstLaunch: boolean;
  islandMonType: string;
  leaderboardType: string;
  botAutomoveMode: string;
};
type NullableStorageWriteKey =
  | "playerRating"
  | "playerTotalManaPoints"
  | "cardBackgroundId"
  | "cardSubtitleId"
  | "profileMons"
  | "profileCounter"
  | "playerNonce";
type PendingAutomatchStorageKey =
  `${typeof PENDING_AUTOMATCH_OPERATION_PREFIX}${string}`;
type StorageWriteValues = Omit<StorageReadValues, NullableStorageWriteKey> & {
  [Key in NullableStorageWriteKey]: StorageReadValues[Key] | null;
} & {
  cardStickers: string | null;
  reactionExtraStickerCache: ReactionExtraStickerCache | null;
  reactionExtraStickerIds: number[];
  reactionExtraStickerProfileId: string;
} & {
  [Key in PendingAutomatchStorageKey]: PendingAutomatchOperation | null;
};

type StoredItem = { raw: string; value: unknown };

function readStoredItem(
  key: StorageKey | PendingAutomatchStorageKey,
): StoredItem | undefined {
  const item = localStorage.getItem(key);
  if (item === null || item === "null") return undefined;
  try {
    const value: unknown = JSON.parse(item);
    return { raw: item, value };
  } catch {
    return { raw: item, value: item };
  }
}

function readStoredValue(
  key: StorageKey | PendingAutomatchStorageKey,
  defaultValue: unknown,
): unknown {
  const stored = readStoredItem(key);
  return stored === undefined ? defaultValue : stored.value;
}

const textValue = (value: unknown, raw: string): string | undefined =>
  typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? raw
      : undefined;
const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;
const booleanValue = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;
const isAssetsSet = (value: unknown): value is AssetsSet =>
  value === "Pixel" || value === "Original" || value === "Pangchiu";
const isBoardStyleSet = (value: unknown): value is BoardStyleSet =>
  value === "Grid" || value === "Pangchiu";
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const isBoardColorSetsByTheme = (
  value: unknown,
): value is BoardColorSetsByTheme => {
  if (!value || typeof value !== "object") return false;
  const fields = value as { light?: unknown; dark?: unknown };
  return isNullableString(fields.light) && isNullableString(fields.dark);
};
const isNumberRecord = (value: unknown): value is Record<string, number> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === "number");
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((entry: unknown) => typeof entry === "string");

const storageDecoders: {
  [Key in keyof StorageReadValues]: (
    value: unknown,
    raw: string,
  ) => StorageReadValues[Key] | undefined;
} = {
  isMuted: booleanValue,
  preferredAssetsSet: (value) => (isAssetsSet(value) ? value : undefined),
  boardStyleSet: (value) =>
    value === null || isBoardStyleSet(value) ? value : undefined,
  boardColorSet: textValue,
  boardColorSetsByTheme: (value) =>
    isBoardColorSetsByTheme(value) ? value : undefined,
  isExperimentingWithSprites: booleanValue,
  playerEmojiId: (value) =>
    typeof value === "string" || typeof value === "number" ? value : undefined,
  playerEmojiAura: textValue,
  loginId: textValue,
  profileId: textValue,
  ethAddress: textValue,
  solAddress: textValue,
  username: textValue,
  playerRating: numberValue,
  playerTotalManaPoints: numberValue,
  playerMiningLastRockDate: (value, raw) =>
    value === null ? null : textValue(value, raw),
  playerMiningMaterials: (value) => (isNumberRecord(value) ? value : undefined),
  cardBackgroundId: numberValue,
  cardSubtitleId: numberValue,
  profileMons: textValue,
  profileCounter: textValue,
  playerNonce: numberValue,
  completedProblems: (value) => (isStringArray(value) ? value : undefined),
  tutorialCompleted: booleanValue,
  isFirstLaunch: booleanValue,
  islandMonType: textValue,
  leaderboardType: textValue,
  botAutomoveMode: textValue,
};

function getItem<Key extends keyof StorageReadValues>(
  key: Key,
  defaultValue: NoInfer<StorageReadValues[Key]>,
): StorageReadValues[Key] {
  const stored = readStoredItem(key);
  if (stored === undefined) return defaultValue;
  const decoded = storageDecoders[key](stored.value, stored.raw);
  return decoded === undefined ? defaultValue : decoded;
}

function setItem<Key extends keyof StorageWriteValues>(
  key: Key,
  value: NoInfer<StorageWriteValues[Key]>,
): void {
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
  getPendingAutomatchOperation: (
    uid: string,
  ): PendingAutomatchOperation | null => {
    const value = readStoredValue(
      `${PENDING_AUTOMATCH_OPERATION_PREFIX}${uid}`,
      null,
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const operation = value as Record<string, unknown>;
    if (
      typeof operation.uid !== "string" ||
      operation.uid !== uid ||
      typeof operation.operationId !== "string" ||
      !GAME_SESSION_OPERATION_ID_PATTERN.test(operation.operationId) ||
      !(
        operation.resolvedInviteId === null ||
        (typeof operation.resolvedInviteId === "string" &&
          isSafeRecordKey(operation.resolvedInviteId))
      ) ||
      !Number.isSafeInteger(operation.createdAtMs) ||
      Number(operation.createdAtMs) <= 0 ||
      !isStartAutomatchRequest(operation.request)
    ) {
      return null;
    }
    return {
      createdAtMs: Number(operation.createdAtMs),
      operationId: operation.operationId,
      request: { ...operation.request },
      resolvedInviteId: operation.resolvedInviteId,
      uid: operation.uid,
    };
  },

  setPendingAutomatchOperation: (
    uid: string,
    value: PendingAutomatchOperation | null,
  ): void => {
    setItem(`${PENDING_AUTOMATCH_OPERATION_PREFIX}${uid}`, value);
  },

  getAuthIdentity: (): AuthIdentity => ({
    profileId: getItem(STORAGE_KEYS.PROFILE_ID, ""),
    ethAddress: getItem(STORAGE_KEYS.ETH_ADDRESS, ""),
    solAddress: getItem(STORAGE_KEYS.SOL_ADDRESS, ""),
  }),

  getIsMuted: (defaultValue: boolean): boolean => {
    try {
      const storedValue = getItem(STORAGE_KEYS.IS_MUTED, defaultValue);
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

  getPlayerEmojiId: (defaultValue: string): EmojiId => {
    return getItem(STORAGE_KEYS.PLAYER_EMOJI_ID, defaultValue);
  },

  setPlayerEmojiId: (value: EmojiId): void => {
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

  setPlayerRating: (value: number | null): void => {
    setItem(STORAGE_KEYS.PLAYER_RATING, value);
  },

  getPlayerTotalManaPoints: (defaultValue: number): number => {
    return getItem(STORAGE_KEYS.PLAYER_TOTAL_MANA_POINTS, defaultValue);
  },

  setPlayerTotalManaPoints: (value: number | null): void => {
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

  setCardBackgroundId: (value: number | null): void => {
    setItem(STORAGE_KEYS.CARD_BACKGROUND_ID, value);
  },

  getCardSubtitleId: (defaultValue: number): number => {
    return getItem(STORAGE_KEYS.CARD_SUBTITLE_ID, defaultValue);
  },

  setCardSubtitleId: (value: number | null): void => {
    setItem(STORAGE_KEYS.CARD_SUBTITLE_ID, value);
  },

  getProfileCounter: (defaultValue: string): string => {
    return getItem(STORAGE_KEYS.PROFILE_COUNTER, defaultValue);
  },

  setProfileCounter: (value: string | null): void => {
    setItem(STORAGE_KEYS.PROFILE_COUNTER, value);
  },

  getCardStickers: (defaultValue: string): string => {
    return JSON.stringify(
      readStoredValue(STORAGE_KEYS.CARD_STICKERS, defaultValue),
    );
  },

  setCardStickers: (value: string | null): void => {
    setItem(STORAGE_KEYS.CARD_STICKERS, value);
  },

  getReactionExtraStickerCache: (
    defaultValue: ReactionExtraStickerCache | null,
  ): ReactionExtraStickerCache | null => {
    const value = readStoredValue(
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

  setProfileMons: (value: string | null): void => {
    setItem(STORAGE_KEYS.PROFILE_MONS, value);
  },

  getPlayerNonce: (defaultValue: number): number => {
    return getItem(STORAGE_KEYS.PLAYER_NONCE, defaultValue);
  },

  setPlayerNonce: (value: number | null): void => {
    setItem(STORAGE_KEYS.PLAYER_NONCE, value);
  },

  getCompletedProblemIds: (defaultValue: string[]): string[] => {
    return getItem(STORAGE_KEYS.COMPLETED_PROBLEMS, defaultValue);
  },

  setCompletedProblemIds: (value: string[]): void => {
    setItem(STORAGE_KEYS.COMPLETED_PROBLEMS, value);
  },

  addCompletedProblemId: (id: string): void => {
    const current = getItem(STORAGE_KEYS.COMPLETED_PROBLEMS, []);
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

  resetSessionIdentity: (): void => {
    Object.values(STORAGE_KEYS).forEach((key) => {
      if (!SESSION_RESET_PRESERVED_STORAGE_KEYS.has(key))
        localStorage.removeItem(key);
    });
    for (const store of [localStorage, sessionStorage]) {
      removeMatchingStorageKeys(
        store,
        (key) =>
          key === "appleIntentByStateV1" ||
          isRetiredSessionStorageKey(key) ||
          key.startsWith("mons:pending-moves:v1:") ||
          key.startsWith("mons:pending-rematch-ends:v1:") ||
          key.startsWith(PENDING_AUTOMATCH_OPERATION_PREFIX) ||
          shouldClearExternalUserStorageKey(key),
      );
    }
  },

  signOut: (): void => {
    Object.values(STORAGE_KEYS).forEach((key) => {
      if (!shouldPreserveStorageKeyOnLogout(key)) {
        localStorage.removeItem(key);
      }
    });
    removeMatchingStorageKeys(localStorage, (key) =>
      key.startsWith(PENDING_AUTOMATCH_OPERATION_PREFIX),
    );
    removeMatchingStorageKeys(localStorage, shouldClearExternalUserStorageKey);
    removeMatchingStorageKeys(
      sessionStorage,
      shouldClearExternalUserStorageKey,
    );
  },
};
