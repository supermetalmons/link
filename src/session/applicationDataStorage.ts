import { APPLICATION_DATA_EPOCH } from "@mons/shared/data-contract";

const APPLICATION_STORAGE_PREFIX = `mons:data:v${APPLICATION_DATA_EPOCH}:`;
export const APPLICATION_RELOAD_MARKER = "__mons_link_data_reload__";

export const applicationStorageKey = (key: string): string =>
  `${APPLICATION_STORAGE_PREFIX}${key}`;

const retiredApplicationKeys = new Set([
  "isMuted",
  "preferredAssetsSet",
  "boardStyleSet",
  "boardColorSet",
  "boardColorSetsByTheme",
  "isExperimentingWithSprites",
  "playerEmojiId",
  "playerEmojiAura",
  "loginId",
  "profileId",
  "ethAddress",
  "solAddress",
  "username",
  "playerRating",
  "playerTotalManaPoints",
  "playerMiningLastRockDate",
  "playerMiningMaterials",
  "cardBackgroundId",
  "cardSubtitleId",
  "cardStickers",
  "reactionExtraStickerCache",
  "reactionExtraStickerIds",
  "reactionExtraStickerProfileId",
  "profileMons",
  "profileCounter",
  "playerNonce",
  "completedProblems",
  "tutorialCompleted",
  "isFirstLaunch",
  "islandMonType",
  "leaderboardType",
  "botAutomoveMode",
  "appleIntentByStateV1",
  "ethIntentByNonceV1",
  "xAuthUiFeedbackV1",
]);

const retiredApplicationPrefixes = [
  "pendingAutomatchOperation:",
  "mons:pending-moves:",
  "mons:pending-rematch-ends:",
  "navigationGamesTopCache:",
  "firebase:",
];

export function isRetiredApplicationStorageKey(key: string): boolean {
  if (key.startsWith(APPLICATION_STORAGE_PREFIX)) return false;
  const storedEpoch = /^mons:data:v([0-9]+):/.exec(key)?.[1];
  return (
    retiredApplicationKeys.has(key) ||
    (storedEpoch !== undefined &&
      Number(storedEpoch) < APPLICATION_DATA_EPOCH) ||
    retiredApplicationPrefixes.some((prefix) => key.startsWith(prefix))
  );
}

type ApplicationStorage = Pick<Storage, "length" | "key" | "removeItem">;

export function resetRetiredApplicationStorage(
  stores: readonly ApplicationStorage[],
): void {
  for (const store of stores) {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index++) {
      const key = store.key(index);
      if (key !== null && isRetiredApplicationStorageKey(key)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  }
}
