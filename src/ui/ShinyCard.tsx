import { emojis, swagpackStart } from "../content/emojis";
import { storage } from "../utils/storage";
import type { PlayerProfile } from "../connection/connectionModels";
import {
  MonType,
  getMonsIndexes,
  royalAguapwoshiDrainerIndex,
} from "../utils/namedMons";
import {
  notifyShinyCardMonsChange,
  notifyShinyCardPlayerEmojiChange,
  updateShinyCardBackgroundId,
  updateShinyCardProfileCounter,
  updateShinyCardProfileMons,
  updateShinyCardStickers,
  updateShinyCardSubtitleId,
} from "./shinyCardRuntimePort";
import {
  bindShinyCardUi,
  setShinyCardVisible,
  type ActiveInventoryItemSelection,
} from "./shinyCardUiPort";
import {
  ProfileScopedUndoHistory,
  getShinyCardUndoUpdateSource,
  isInventoryEmojiId,
  parseStickerMap,
  type ShinyCardUpdateSource,
} from "./shinyCardModels";
import { CARD_MONS, ShinyCardSession } from "./shinyCardSession";

export { showsShinyCardSomewhere } from "./shinyCardUiPort";
export type { ActiveInventoryItemSelection } from "./shinyCardUiPort";

const defaultCardBgIndex = 30;
const INVENTORY_ONLY_BG_ID = 100;
const INVENTORY_ONLY_STICKER_TYPE = "big-mon-top-right";
const INVENTORY_ONLY_STICKER_NAME = "gate";
type UpdateSource = ShinyCardUpdateSource;

const undoHistory = new ProfileScopedUndoHistory();
let activeSession: ShinyCardSession | null = null;

const getCurrentProfileId = (): string | null =>
  storage.getProfileId("").trim() || null;

const synchronizeUndoQueueWithCurrentProfile = (): string | null =>
  undoHistory.synchronize(getCurrentProfileId());

const getOwnSession = (): ShinyCardSession | null =>
  activeSession &&
  !activeSession.isOtherPlayer &&
  activeSession.ownerProfileId === getCurrentProfileId()
    ? activeSession
    : null;

const getStoredOwnStickers = (): Record<string, string> =>
  parseStickerMap(storage.getCardStickers(""));

const isInventoryOnlyEmojiId = (
  emojiId: string | number | undefined,
): boolean => {
  return isInventoryEmojiId(emojiId, swagpackStart);
};

export const getActiveInventoryItemSelection =
  (): ActiveInventoryItemSelection => {
    const storedEmojiId = Number.parseInt(storage.getPlayerEmojiId(""), 10);
    const specialIds = new Set<number>();

    if (
      royalAguapwoshiDrainerIndex >= 0 &&
      getMonsIndexes(false, null)[CARD_MONS[MonType.DRAINER].index] ===
        royalAguapwoshiDrainerIndex
    ) {
      specialIds.add(0);
    }
    if (
      storage.getCardBackgroundId(defaultCardBgIndex) === INVENTORY_ONLY_BG_ID
    ) {
      specialIds.add(1);
    }
    if (
      getStoredOwnStickers()[INVENTORY_ONLY_STICKER_TYPE] ===
      INVENTORY_ONLY_STICKER_NAME
    ) {
      specialIds.add(2);
    }

    return {
      avatarId: isInventoryOnlyEmojiId(storedEmojiId)
        ? storedEmojiId - swagpackStart
        : null,
      specialIds,
    };
  };

const getUndoUpdateSource = (contentType: string, oldId: any): UpdateSource => {
  return getShinyCardUndoUpdateSource(contentType, oldId, {
    inventoryEmojiStartId: swagpackStart,
    inventoryBackgroundId: INVENTORY_ONLY_BG_ID,
    inventoryDrainerId: royalAguapwoshiDrainerIndex,
    inventoryStickerType: INVENTORY_ONLY_STICKER_TYPE,
    inventoryStickerName: INVENTORY_ONLY_STICKER_NAME,
  });
};

export const showShinyCard = async (
  profile: PlayerProfile | null,
  displayName: string,
  isOtherPlayer: boolean,
): Promise<void> => {
  if (
    isOtherPlayer &&
    profile !== null &&
    activeSession?.isOtherPlayer &&
    activeSession.profile === profile
  ) {
    hideShinyCard();
    return;
  }
  if (isOtherPlayer && !profile) return;

  hideShinyCard();
  if (!isOtherPlayer) synchronizeUndoQueueWithCurrentProfile();

  const session = new ShinyCardSession({
    profile,
    displayName,
    isOtherPlayer,
    ownerProfileId: getCurrentProfileId(),
    onUpdateContent: (contentType, newId, oldId) => {
      if (getOwnSession() === session) updateContent(contentType, newId, oldId);
    },
    onUndo: () => {
      if (getOwnSession() === session) undoLastEdit();
    },
    getUndoSize: () => {
      synchronizeUndoQueueWithCurrentProfile();
      return undoHistory.size;
    },
    onMonsChanged: () => {
      if (getOwnSession() === session) void notifyShinyCardMonsChange();
    },
    onDispose: (disposedSession) => {
      if (activeSession !== disposedSession) return;
      activeSession = null;
      setShinyCardVisible(false);
    },
  });
  activeSession = session;
  setShinyCardVisible(true);
  try {
    session.mount();
  } catch (error) {
    session.dispose();
    throw error;
  }
};

export const hideShinyCard = (): void => {
  activeSession?.dispose();
  setShinyCardVisible(false);
};

export const updateShinyCardDisplayName = (displayName: string): void => {
  getOwnSession()?.updateDisplayName(displayName);
};

function updateContent(
  contentType: string,
  newId: any,
  oldId: any | null,
  source: UpdateSource = "default",
): void {
  const updateProfileId = getCurrentProfileId();
  const session = getOwnSession();
  switch (contentType) {
    case "profileCounter":
      storage.setProfileCounter(newId);
      updateShinyCardProfileCounter(newId);
      break;
    case "emojiAndAura": {
      const nextEmojiId = newId?.emojiId;
      const nextAura = newId?.aura ?? "";
      if (
        source !== "inventory" &&
        (isInventoryOnlyEmojiId(nextEmojiId) || nextAura === "rainbow")
      ) {
        return;
      }
      storage.setPlayerEmojiAura(nextAura);
      notifyShinyCardPlayerEmojiChange(
        nextEmojiId,
        emojis.getEmojiUrl(nextEmojiId),
        nextAura,
      );
      break;
    }
    case "bg":
      if (source !== "inventory" && newId === INVENTORY_ONLY_BG_ID) return;
      storage.setCardBackgroundId(newId);
      updateShinyCardBackgroundId(newId);
      break;
    case "subtitle":
      storage.setCardSubtitleId(newId);
      updateShinyCardSubtitleId(newId);
      break;
    case MonType.DEMON:
    case MonType.ANGEL:
    case MonType.DRAINER:
    case MonType.SPIRIT:
    case MonType.MYSTIC: {
      if (
        contentType === MonType.DRAINER &&
        source !== "inventory" &&
        newId === royalAguapwoshiDrainerIndex
      ) {
        return;
      }
      const ownMonsIndexes = getMonsIndexes(false, null);
      ownMonsIndexes[CARD_MONS[contentType].index] = newId;
      const monsIndexesString = ownMonsIndexes.join(",");
      storage.setProfileMons(monsIndexesString);
      updateShinyCardProfileMons(monsIndexesString);
      break;
    }
    case "big-mon-top-right":
    case "bottom-left":
    case "bottom-right":
    case "mana":
    case "middle-left":
    case "middle-right":
    case "mini-logo":
    case "type-logo": {
      if (
        source !== "inventory" &&
        contentType === INVENTORY_ONLY_STICKER_TYPE &&
        newId === INVENTORY_ONLY_STICKER_NAME
      ) {
        return;
      }
      const updatedStickers = getStoredOwnStickers();
      if (newId) updatedStickers[contentType] = newId;
      else delete updatedStickers[contentType];
      const currentJson = JSON.stringify(updatedStickers);
      storage.setCardStickers(currentJson);
      updateShinyCardStickers(currentJson);
      break;
    }
    default:
      return;
  }

  if (oldId !== null) {
    undoHistory.enqueue(
      updateProfileId,
      synchronizeUndoQueueWithCurrentProfile(),
      [contentType, oldId],
    );
  }
  if (session && getOwnSession() === session) {
    session.applyPresentationChange(contentType, newId);
  }
  updateUndoButton();
}

function updateUndoButton(): void {
  synchronizeUndoQueueWithCurrentProfile();
  getOwnSession()?.updateUndoButton();
}

function undoLastEdit(): void {
  const entry = undoHistory.pop(synchronizeUndoQueueWithCurrentProfile());
  if (entry) {
    const [contentType, oldId] = entry;
    updateContent(
      contentType,
      oldId,
      null,
      getUndoUpdateSource(contentType, oldId),
    );
  }
  updateUndoButton();
}

export function setOwnershipVerifiedSpecialItem(id: number) {
  switch (id) {
    case 0: {
      if (royalAguapwoshiDrainerIndex < 0) {
        break;
      }
      const ownDrainerIndex = getMonsIndexes(false, null)[
        CARD_MONS[MonType.DRAINER].index
      ];
      updateContent(
        "drainer",
        royalAguapwoshiDrainerIndex,
        ownDrainerIndex,
        "inventory",
      );
      void notifyShinyCardMonsChange();
      break;
    }
    case 1:
      updateContent(
        "bg",
        INVENTORY_ONLY_BG_ID,
        storage.getCardBackgroundId(defaultCardBgIndex),
        "inventory",
      );
      break;
    case 2: {
      const type = INVENTORY_ONLY_STICKER_TYPE;
      const currentSticker = getStoredOwnStickers()[type];
      updateContent(
        type,
        INVENTORY_ONLY_STICKER_NAME,
        currentSticker,
        "inventory",
      );
      break;
    }
  }
}

export function setOwnershipVerifiedIdCardEmoji(id: number, aura: string) {
  if (!isInventoryOnlyEmojiId(id)) {
    return;
  }
  const oldEmojiId = storage.getPlayerEmojiId("1");
  const oldAura = storage.getPlayerEmojiAura("");
  updateContent(
    "emojiAndAura",
    { emojiId: id, aura: aura === "rainbow" ? "rainbow" : "" },
    { emojiId: oldEmojiId, aura: oldAura },
    "inventory",
  );
}

bindShinyCardUi({
  show: showShinyCard,
  hide: hideShinyCard,
  updateDisplayName: updateShinyCardDisplayName,
  getActiveInventoryItemSelection,
  setOwnershipVerifiedSpecialItem,
  setOwnershipVerifiedIdCardEmoji,
});
