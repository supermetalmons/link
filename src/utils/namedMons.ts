import {
  MON_SELECTION_CATALOG,
  isMonSelectionIndex,
  type MonSelectionKind,
  type SelectedMons,
} from "@mons/shared/appearance";
import { getStableRandomIdForProfileId } from "../utils/misc";
import { PlayerProfile } from "../connection/connectionModels";
import { storage } from "../utils/storage";
import { flushDeferredProfilePresentation } from "../connection/deferredProfilePresentation";

export enum MonType {
  DEMON = "demon",
  ANGEL = "angel",
  DRAINER = "drainer",
  SPIRIT = "spirit",
  MYSTIC = "mystic",
}

export const demonTypes = MON_SELECTION_CATALOG.demon;
export const angelTypes = MON_SELECTION_CATALOG.angel;
export const drainerTypes = MON_SELECTION_CATALOG.drainer;
export const spiritTypes = MON_SELECTION_CATALOG.spirit;
export const mysticTypes = MON_SELECTION_CATALOG.mystic;
export const royalAguapwoshiDrainerIndex = 5;
const randomizableDrainerIndexes = [0, 1, 2, 3, 4] as const;

export function getMonId(type: MonSelectionKind, index: number): string {
  const name = MON_SELECTION_CATALOG[type][index];
  if (name === undefined) throw new RangeError("invalid-mon-selection");
  return `${name}_${type}`;
}

function getDefaultMonIndex<Kind extends MonSelectionKind>(
  kind: Kind,
  profileId: string,
): SelectedMons[Kind] {
  let index = getStableRandomIdForProfileId(
    profileId,
    MON_SELECTION_CATALOG[kind].length,
  );
  if (kind === "drainer" && index === royalAguapwoshiDrainerIndex) {
    const alternate =
      randomizableDrainerIndexes[
        getStableRandomIdForProfileId(
          profileId,
          randomizableDrainerIndexes.length,
        )
      ];
    if (alternate === undefined) throw new Error("invalid-default-mon-index");
    index = alternate;
  }
  if (!isMonSelectionIndex(kind, index))
    throw new Error("invalid-default-mon-index");
  return index;
}

export function getMonsSelection(
  isOtherPlayer: boolean,
  profile: PlayerProfile | null,
): SelectedMons {
  if (!isOtherPlayer) flushDeferredProfilePresentation();
  const selected = isOtherPlayer
    ? (profile?.profileMons ?? null)
    : storage.getProfileMons(null);
  if (selected !== null) return { ...selected };
  const profileId = isOtherPlayer
    ? (profile?.id ?? "")
    : storage.getProfileId("");
  return {
    demon: getDefaultMonIndex("demon", profileId),
    angel: getDefaultMonIndex("angel", profileId),
    drainer: getDefaultMonIndex("drainer", profileId),
    spirit: getDefaultMonIndex("spirit", profileId),
    mystic: getDefaultMonIndex("mystic", profileId),
  };
}

export function getMonsIndexes(
  isOtherPlayer: boolean,
  profile: PlayerProfile | null,
): [number, number, number, number, number] {
  const selected = getMonsSelection(isOtherPlayer, profile);
  return [
    selected.demon,
    selected.angel,
    selected.drainer,
    selected.spirit,
    selected.mystic,
  ];
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
