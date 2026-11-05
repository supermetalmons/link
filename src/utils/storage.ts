import {
  boardAppearanceStorageKeys,
  discardEarlyBoardAppearance,
  isAssetsSet,
  isBoardStyleSet,
  isBoardColorSetsByTheme,
} from "../content/boardAppearance.ts";
import type { AssetsSet, BoardStyleSet } from "../content/boardStyleModels";
import {
  isAura,
  isCardBackgroundId,
  isCardSubtitleId,
  isEmojiId,
  isProfileCounter,
  isSelectedMons,
  isStickerMap,
  type Aura,
  type CardBackgroundId,
  type CardSubtitleId,
  type EmojiId,
  type ProfileCounter,
  type SelectedMons,
  type StickerMap,
} from "@mons/shared/appearance";
import { GAME_SESSION_OPERATION_ID_PATTERN } from "@mons/shared/game-sessions";
import { isSafeRecordKey } from "@mons/shared/ids";
import { isMiningMaterials, type MiningMaterials } from "@mons/shared/mining";
import {
  applicationStorageKey,
  isRetiredApplicationStorageKey,
} from "../session/applicationDataStorage.ts";
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

  ...boardAppearanceStorageKeys,
  BOARD_COLOR_SET: "boardColorSet",
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
  return [...LOGOUT_PRESERVED_STORAGE_KEYS].some(
    (preserved) => key === applicationStorageKey(preserved),
  );
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
  playerEmojiAura: Aura;
  loginId: string;
  profileId: string;
  ethAddress: string;
  solAddress: string;
  username: string;
  playerRating: number;
  playerTotalManaPoints: number;
  playerMiningLastRockDate: string | null;
  playerMiningMaterials: MiningMaterials;
  cardBackgroundId: CardBackgroundId;
  cardSubtitleId: CardSubtitleId;
  profileMons: SelectedMons | null;
  profileCounter: ProfileCounter;
  cardStickers: StickerMap;
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
  | "cardStickers"
  | "playerNonce";
type PendingAutomatchStorageKey =
  `${typeof PENDING_AUTOMATCH_OPERATION_PREFIX}${string}`;
type StorageWriteValues = Omit<StorageReadValues, NullableStorageWriteKey> & {
  [Key in NullableStorageWriteKey]: StorageReadValues[Key] | null;
} & {
  cardStickers: StickerMap | null;
  reactionExtraStickerCache: ReactionExtraStickerCache | null;
  reactionExtraStickerIds: number[];
  reactionExtraStickerProfileId: string;
} & {
  [Key in PendingAutomatchStorageKey]: PendingAutomatchOperation | null;
};

type StoredItem = { value: unknown };

function readStoredItem(
  key: StorageKey | PendingAutomatchStorageKey,
): StoredItem | undefined {
  const item = localStorage.getItem(applicationStorageKey(key));
  if (item === null) return undefined;
  try {
    const value: unknown = JSON.parse(item);
    return { value };
  } catch {
    return undefined;
  }
}

function readStoredValue(
  key: StorageKey | PendingAutomatchStorageKey,
  defaultValue: unknown,
): unknown {
  const stored = readStoredItem(key);
  return stored === undefined ? defaultValue : stored.value;
}

const textValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const booleanValue = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((entry: unknown) => typeof entry === "string");
const isIntegerArray = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.every(
    (entry: unknown) =>
      typeof entry === "number" && Number.isSafeInteger(entry),
  );

const storageDecoders: {
  [Key in keyof StorageReadValues]: (
    value: unknown,
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
  playerEmojiId: (value) => (isEmojiId(value) ? value : undefined),
  playerEmojiAura: (value) => (isAura(value) ? value : undefined),
  loginId: textValue,
  profileId: textValue,
  ethAddress: textValue,
  solAddress: textValue,
  username: textValue,
  playerRating: numberValue,
  playerTotalManaPoints: numberValue,
  playerMiningLastRockDate: (value) =>
    value === null ? null : textValue(value),
  playerMiningMaterials: (value) =>
    isMiningMaterials(value) ? value : undefined,
  cardBackgroundId: (value) => (isCardBackgroundId(value) ? value : undefined),
  cardSubtitleId: (value) => (isCardSubtitleId(value) ? value : undefined),
  profileMons: (value) =>
    value === null || isSelectedMons(value) ? value : undefined,
  profileCounter: (value) => (isProfileCounter(value) ? value : undefined),
  cardStickers: (value) => (isStickerMap(value) ? value : undefined),
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
  const decoded = storageDecoders[key](stored.value);
  return decoded === undefined ? defaultValue : decoded;
}

function setItem<Key extends keyof StorageWriteValues>(
  key: Key,
  value: NoInfer<StorageWriteValues[Key]>,
): void {
  if (value === null) {
    localStorage.removeItem(applicationStorageKey(key));
    return;
  }
  if (isStorageReadKey(key) && storageDecoders[key](value) === undefined) {
    throw new TypeError("invalid-application-storage-value");
  }
  localStorage.setItem(applicationStorageKey(key), JSON.stringify(value));
}

function isStorageReadKey(key: string): key is keyof StorageReadValues {
  return Object.hasOwn(storageDecoders, key);
}

function getStoredEmojiId(defaultValue: EmojiId): EmojiId;
function getStoredEmojiId(defaultValue: null): EmojiId | null;
function getStoredEmojiId(defaultValue: EmojiId | null): EmojiId | null {
  const stored = readStoredItem(STORAGE_KEYS.PLAYER_EMOJI_ID);
  return stored && isEmojiId(stored.value) ? stored.value : defaultValue;
}

export const storage = {
  getPendingAutomatchOperation: (
    uid: string,
  ): PendingAutomatchOperation | null => {
    const value = readStoredValue(
      `${PENDING_AUTOMATCH_OPERATION_PREFIX}${uid}`,
      null,
    );
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 5
    ) {
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
      typeof operation.createdAtMs !== "number" ||
      !Number.isSafeInteger(operation.createdAtMs) ||
      operation.createdAtMs <= 0 ||
      !isStartAutomatchRequest(operation.request)
    ) {
      return null;
    }
    return {
      createdAtMs: operation.createdAtMs,
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

  getPlayerEmojiId: getStoredEmojiId,

  setPlayerEmojiId: (value: EmojiId): void => {
    setItem(STORAGE_KEYS.PLAYER_EMOJI_ID, value);
  },

  getPlayerEmojiAura: (defaultValue: Aura): Aura => {
    return getItem(STORAGE_KEYS.PLAYER_EMOJI_AURA, defaultValue);
  },

  setPlayerEmojiAura: (value: Aura): void => {
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

  getMiningMaterials: (defaultValue: MiningMaterials): MiningMaterials => {
    return getItem(STORAGE_KEYS.PLAYER_MINING_MATERIALS, defaultValue);
  },

  setMiningMaterials: (value: MiningMaterials): void => {
    setItem(STORAGE_KEYS.PLAYER_MINING_MATERIALS, value);
  },

  getCardBackgroundId: (defaultValue: CardBackgroundId): CardBackgroundId => {
    return getItem(STORAGE_KEYS.CARD_BACKGROUND_ID, defaultValue);
  },

  setCardBackgroundId: (value: CardBackgroundId | null): void => {
    setItem(STORAGE_KEYS.CARD_BACKGROUND_ID, value);
  },

  getCardSubtitleId: (defaultValue: CardSubtitleId): CardSubtitleId => {
    return getItem(STORAGE_KEYS.CARD_SUBTITLE_ID, defaultValue);
  },

  setCardSubtitleId: (value: CardSubtitleId | null): void => {
    setItem(STORAGE_KEYS.CARD_SUBTITLE_ID, value);
  },

  getProfileCounter: (defaultValue: ProfileCounter): ProfileCounter => {
    return getItem(STORAGE_KEYS.PROFILE_COUNTER, defaultValue);
  },

  setProfileCounter: (value: ProfileCounter | null): void => {
    setItem(STORAGE_KEYS.PROFILE_COUNTER, value);
  },

  getCardStickers: (defaultValue: StickerMap): StickerMap => {
    return getItem(STORAGE_KEYS.CARD_STICKERS, defaultValue);
  },

  setCardStickers: (value: StickerMap | null): void => {
    setItem(STORAGE_KEYS.CARD_STICKERS, value);
  },

  getReactionExtraStickerCache: (
    defaultValue: ReactionExtraStickerCache | null,
  ): ReactionExtraStickerCache | null => {
    const value = readStoredValue(
      STORAGE_KEYS.REACTION_EXTRA_STICKER_CACHE,
      defaultValue,
    );
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 5
    ) {
      return defaultValue;
    }
    const cache = value as Record<string, unknown>;
    if (
      typeof cache.profileId !== "string" ||
      typeof cache.ethAddress !== "string" ||
      typeof cache.solAddress !== "string" ||
      !isIntegerArray(cache.extraIds) ||
      typeof cache.expiresAtMs !== "number" ||
      !Number.isFinite(cache.expiresAtMs)
    ) {
      return defaultValue;
    }
    return {
      profileId: cache.profileId,
      ethAddress: cache.ethAddress,
      solAddress: cache.solAddress,
      extraIds: [...cache.extraIds],
      expiresAtMs: cache.expiresAtMs,
    };
  },

  setReactionExtraStickerCache: (
    value: ReactionExtraStickerCache | null,
  ): void => {
    setItem(STORAGE_KEYS.REACTION_EXTRA_STICKER_CACHE, value);
  },

  getProfileMons: (defaultValue: SelectedMons | null): SelectedMons | null => {
    return getItem(STORAGE_KEYS.PROFILE_MONS, defaultValue);
  },

  setProfileMons: (value: SelectedMons | null): void => {
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
        localStorage.removeItem(applicationStorageKey(key));
    });
    for (const store of [localStorage, sessionStorage]) {
      removeMatchingStorageKeys(
        store,
        (key) =>
          key === applicationStorageKey("appleIntentByStateV1") ||
          isRetiredApplicationStorageKey(key) ||
          key.startsWith(applicationStorageKey("pending-moves:")) ||
          key.startsWith(applicationStorageKey("pending-rematch-ends:")) ||
          key.startsWith(
            applicationStorageKey(PENDING_AUTOMATCH_OPERATION_PREFIX),
          ) ||
          shouldClearExternalUserStorageKey(key),
      );
    }
  },

  signOut: (): void => {
    discardEarlyBoardAppearance();
    Object.values(STORAGE_KEYS).forEach((key) => {
      if (!LOGOUT_PRESERVED_STORAGE_KEYS.has(key)) {
        localStorage.removeItem(applicationStorageKey(key));
      }
    });
    removeMatchingStorageKeys(localStorage, (key) =>
      key.startsWith(applicationStorageKey(PENDING_AUTOMATCH_OPERATION_PREFIX)),
    );
    removeMatchingStorageKeys(localStorage, shouldClearExternalUserStorageKey);
    removeMatchingStorageKeys(
      sessionStorage,
      shouldClearExternalUserStorageKey,
    );
  },
};
