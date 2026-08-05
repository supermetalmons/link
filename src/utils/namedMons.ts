import { getStableRandomIdForProfileId } from "../utils/misc";
import { PlayerProfile } from "../connection/connectionModels";
import { storage } from "../utils/storage";

export enum MonType {
  DEMON = "demon",
  ANGEL = "angel",
  DRAINER = "drainer",
  SPIRIT = "spirit",
  MYSTIC = "mystic",
}

export const demonTypes = ["borgalo", "notchur"];
export const angelTypes = [
  "applecreme",
  "gerp",
  "goxfold",
  "mowch",
  "mummyfly",
];
export const drainerTypes = [
  "deino",
  "greenseech",
  "omom",
  "supermetaldrop",
  "zwubbi",
  "royal_aguapwoshi",
];
export const spiritTypes = ["melmut", "omenstatue", "owg"];
export const mysticTypes = ["chamgot", "dart", "estalibur"];
export const royalAguapwoshiDrainerIndex =
  drainerTypes.indexOf("royal_aguapwoshi");
const randomizableDrainerIndexes = drainerTypes
  .map((_, index) => index)
  .filter((index) => index !== royalAguapwoshiDrainerIndex);

export function getMonId(type: MonType, index: number): string {
  switch (type) {
    case MonType.DEMON:
      return demonTypes[index] + "_" + type;
    case MonType.ANGEL:
      return angelTypes[index] + "_" + type;
    case MonType.DRAINER:
      return drainerTypes[index] + "_" + type;
    case MonType.SPIRIT:
      return spiritTypes[index] + "_" + type;
    case MonType.MYSTIC:
      return mysticTypes[index] + "_" + type;
  }
}

function getDefaultMonId(type: MonType, profileId: string): number {
  switch (type) {
    case MonType.DEMON:
      return getStableRandomIdForProfileId(profileId, demonTypes.length);
    case MonType.ANGEL:
      return getStableRandomIdForProfileId(profileId, angelTypes.length);
    case MonType.DRAINER: {
      if (drainerTypes.length === 0) {
        return 0;
      }
      const defaultDrainerIndex = getStableRandomIdForProfileId(
        profileId,
        drainerTypes.length,
      );
      if (defaultDrainerIndex !== royalAguapwoshiDrainerIndex) {
        return defaultDrainerIndex;
      }
      if (randomizableDrainerIndexes.length === 0) {
        return defaultDrainerIndex;
      }
      const fallbackIndex = getStableRandomIdForProfileId(
        profileId,
        randomizableDrainerIndexes.length,
      );
      return randomizableDrainerIndexes[fallbackIndex];
    }
    case MonType.SPIRIT:
      return getStableRandomIdForProfileId(profileId, spiritTypes.length);
    case MonType.MYSTIC:
      return getStableRandomIdForProfileId(profileId, mysticTypes.length);
  }
}

export function getMonsIndexes(
  isOtherPlayer: boolean,
  profile: PlayerProfile | null,
): [number, number, number, number, number] {
  const currentIndexes = isOtherPlayer
    ? (profile?.profileMons ?? "")
    : storage.getProfileMons("");

  let useDefaultIndexes = true;
  let demonIndex = 0;
  let angelIndex = 0;
  let drainerIndex = 0;
  let spiritIndex = 0;
  let mysticIndex = 0;

  if (currentIndexes && currentIndexes.trim() !== "") {
    const parts = currentIndexes.split(",");
    if (parts.length === 5) {
      const parsedIndexes = parts.map((part: string) => parseInt(part, 10));
      if (parsedIndexes.every((index: number) => !isNaN(index))) {
        demonIndex = parsedIndexes[0];
        angelIndex = parsedIndexes[1];
        drainerIndex = parsedIndexes[2];
        spiritIndex = parsedIndexes[3];
        mysticIndex = parsedIndexes[4];
        useDefaultIndexes = false;
      }
    }
  }

  if (useDefaultIndexes) {
    const profileId = isOtherPlayer
      ? (profile?.id ?? "")
      : storage.getProfileId("");
    demonIndex = getDefaultMonId(MonType.DEMON, profileId);
    angelIndex = getDefaultMonId(MonType.ANGEL, profileId);
    drainerIndex = getDefaultMonId(MonType.DRAINER, profileId);
    spiritIndex = getDefaultMonId(MonType.SPIRIT, profileId);
    mysticIndex = getDefaultMonId(MonType.MYSTIC, profileId);
  }

  return [demonIndex, angelIndex, drainerIndex, spiritIndex, mysticIndex];
}

export function getOwnMonIdByType(type: MonType): string {
  const indexes = getMonsIndexes(false, null);
  const typeToIndexMap: Record<MonType, number> = {
    [MonType.DEMON]: indexes[0],
    [MonType.ANGEL]: indexes[1],
    [MonType.DRAINER]: indexes[2],
    [MonType.SPIRIT]: indexes[3],
    [MonType.MYSTIC]: indexes[4],
  };
  return getMonId(type, typeToIndexMap[type]);
}
