import type { PlayerProfile } from "../connection/connectionModels";

export type ActiveInventoryItemSelection = {
  avatarId: number | null;
  specialIds: ReadonlySet<number>;
};

export type ShinyCardUiApi = {
  show: (
    profile: PlayerProfile | null,
    displayName: string,
    isOtherPlayer: boolean,
  ) => Promise<void>;
  hide: () => void;
  updateDisplayName: (displayName: string) => void;
  getActiveInventoryItemSelection: () => ActiveInventoryItemSelection;
  setOwnershipVerifiedSpecialItem: (id: number) => void;
  setOwnershipVerifiedIdCardEmoji: (id: number, aura: string) => void;
};

let api: ShinyCardUiApi | null = null;

export let showsShinyCardSomewhere = false;

const getApi = (): ShinyCardUiApi => {
  if (!api) {
    throw new Error("shiny-card-ui-not-bound");
  }
  return api;
};

export const bindShinyCardUi = (nextApi: ShinyCardUiApi): (() => void) => {
  api = nextApi;
  return () => {
    if (api === nextApi) {
      api = null;
      showsShinyCardSomewhere = false;
    }
  };
};

export const setShinyCardVisible = (visible: boolean): void => {
  showsShinyCardSomewhere = visible;
};

export const showShinyCard = (
  profile: PlayerProfile | null,
  displayName: string,
  isOtherPlayer: boolean,
): Promise<void> => getApi().show(profile, displayName, isOtherPlayer);

export const hideShinyCard = (): void => {
  getApi().hide();
};

export const updateShinyCardDisplayName = (displayName: string): void => {
  getApi().updateDisplayName(displayName);
};

export const getActiveInventoryItemSelection =
  (): ActiveInventoryItemSelection =>
    getApi().getActiveInventoryItemSelection();

export const setOwnershipVerifiedSpecialItem = (id: number): void => {
  getApi().setOwnershipVerifiedSpecialItem(id);
};

export const setOwnershipVerifiedIdCardEmoji = (
  id: number,
  aura: string,
): void => {
  getApi().setOwnershipVerifiedIdCardEmoji(id, aura);
};
