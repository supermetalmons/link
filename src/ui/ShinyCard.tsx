import {
  withMonSelection,
  withStickerSelection,
  isAura,
  type EmojiId,
  type StickerMap,
} from "@mons/shared/appearance";
import type { Aura } from "@mons/shared/appearance";
import { emojis, swagpackStart } from "../content/emojis";
import { storage } from "../utils/storage";
import type { PlayerProfile } from "../connection/connectionModels";
import {
  MonType,
  getMonsIndexes,
  getMonsSelection,
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
  getShinyCardUndoEntry,
  getShinyCardUndoUpdateSource,
  isInventoryEmojiId,
  type ShinyCardEdit,
  type ShinyCardUndoEntry,
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

const getStoredOwnStickers = (): StickerMap => storage.getCardStickers({});

const isInventoryOnlyEmojiId = (
  emojiId: EmojiId | null | undefined,
): boolean => {
  return isInventoryEmojiId(emojiId, swagpackStart);
};

export const getActiveInventoryItemSelection =
  (): ActiveInventoryItemSelection => {
    const storedEmojiId = storage.getPlayerEmojiId(1);
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

const getUndoUpdateSource = (entry: ShinyCardUndoEntry): UpdateSource => {
  return getShinyCardUndoUpdateSource(entry, {
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
    onUpdateContent: (edit) => {
      if (getOwnSession() === session) updateContent(edit);
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
  edit: ShinyCardEdit,
  source: UpdateSource = "default",
): void {
  const updateProfileId = getCurrentProfileId();
  const session = getOwnSession();
  const { contentType, value: newId } = edit;
  switch (contentType) {
    case "profileCounter":
      storage.setProfileCounter(newId);
      updateShinyCardProfileCounter(newId);
      break;
    case "emojiAndAura": {
      const nextEmojiId = newId.emojiId;
      const nextAura = newId.aura;
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
      const selection = withMonSelection(
        getMonsSelection(false, null),
        contentType,
        newId,
      );
      storage.setProfileMons(selection);
      updateShinyCardProfileMons(selection);
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
      const updatedStickers = withStickerSelection(
        getStoredOwnStickers(),
        contentType,
        newId,
      );
      storage.setCardStickers(updatedStickers);
      updateShinyCardStickers(updatedStickers);
      break;
    }
    default: {
      const unhandled: never = contentType;
      return void unhandled;
    }
  }

  const undoEntry = getShinyCardUndoEntry(edit);
  if (undoEntry !== null) {
    undoHistory.enqueue(
      updateProfileId,
      synchronizeUndoQueueWithCurrentProfile(),
      undoEntry,
    );
  }
  if (session && getOwnSession() === session) {
    session.applyPresentationChange(edit);
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
    updateContent(
      { ...entry, undo: { kind: "skip" } },
      getUndoUpdateSource(entry),
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
      const ownDrainerIndex = getMonsSelection(false, null).drainer;
      updateContent(
        {
          contentType: MonType.DRAINER,
          value: royalAguapwoshiDrainerIndex,
          undo: { kind: "record", value: ownDrainerIndex },
        },
        "inventory",
      );
      void notifyShinyCardMonsChange();
      break;
    }
    case 1:
      updateContent(
        {
          contentType: "bg",
          value: INVENTORY_ONLY_BG_ID,
          undo: {
            kind: "record",
            value: storage.getCardBackgroundId(defaultCardBgIndex),
          },
        },
        "inventory",
      );
      break;
    case 2: {
      const type = INVENTORY_ONLY_STICKER_TYPE;
      const currentSticker = getStoredOwnStickers()[type];
      updateContent(
        {
          contentType: type,
          value: INVENTORY_ONLY_STICKER_NAME,
          undo: { kind: "record", value: currentSticker },
        },
        "inventory",
      );
      break;
    }
  }
}

export function setOwnershipVerifiedIdCardEmoji(id: number, aura: Aura) {
  if (!isInventoryOnlyEmojiId(id) || !isAura(aura)) {
    return;
  }
  const oldEmojiId = storage.getPlayerEmojiId(1);
  const oldAura = storage.getPlayerEmojiAura("none");
  updateContent(
    {
      contentType: "emojiAndAura",
      value: { emojiId: id, aura },
      undo: { kind: "record", value: { emojiId: oldEmojiId, aura: oldAura } },
    },
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
