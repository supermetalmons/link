import type {
  Aura,
  CardBackgroundId,
  CardSubtitleId,
  EmojiId,
  ProfileCounter,
  SelectedMons,
  StickerSlot,
  StickerName,
  StickerMap,
  MonSelectionKind,
} from "@mons/shared/appearance";
import { isEmojiId } from "@mons/shared/appearance";

export type ShinyCardUpdateSource = "default" | "inventory";

/** @knipExternal Imported by the generated type probe in test/shinyCardEditTypes.test.mjs. */
export type UndoIntent<T> =
  { readonly kind: "record"; readonly value: T } | { readonly kind: "skip" };

type ShinyCardValues = {
  profileCounter: ProfileCounter;
  emojiAndAura: { emojiId: EmojiId; aura: Aura };
  bg: CardBackgroundId;
  subtitle: CardSubtitleId;
} & SelectedMons & { [Slot in StickerSlot]: StickerName<Slot> | undefined };

export type ShinyCardChange = {
  [Type in keyof ShinyCardValues]: {
    readonly contentType: Type;
    readonly value: ShinyCardValues[Type];
  };
}[keyof ShinyCardValues];

export type ShinyCardEdit = {
  [Type in keyof ShinyCardValues]: {
    readonly contentType: Type;
    readonly value: ShinyCardValues[Type];
    readonly undo: UndoIntent<ShinyCardValues[Type]>;
  };
}[keyof ShinyCardValues];

export type ShinyCardUndoEntry = ShinyCardChange;

export const getShinyCardUndoEntry = (
  edit: ShinyCardEdit,
): ShinyCardUndoEntry | null => {
  if (edit.undo.kind === "skip") return null;

  switch (edit.contentType) {
    case "profileCounter":
      return { contentType: edit.contentType, value: edit.undo.value };
    case "emojiAndAura":
      return { contentType: edit.contentType, value: edit.undo.value };
    case "bg":
      return { contentType: edit.contentType, value: edit.undo.value };
    case "subtitle":
      return { contentType: edit.contentType, value: edit.undo.value };
    case "demon":
      return { contentType: edit.contentType, value: edit.undo.value };
    case "angel":
      return { contentType: edit.contentType, value: edit.undo.value };
    case "drainer":
      return { contentType: edit.contentType, value: edit.undo.value };
    case "spirit":
      return { contentType: edit.contentType, value: edit.undo.value };
    case "mystic":
      return { contentType: edit.contentType, value: edit.undo.value };
    case "big-mon-top-right":
      return { contentType: edit.contentType, value: edit.undo.value };
    case "bottom-left":
      return { contentType: edit.contentType, value: edit.undo.value };
    case "bottom-right":
      return { contentType: edit.contentType, value: edit.undo.value };
    case "mana":
      return { contentType: edit.contentType, value: edit.undo.value };
    case "middle-left":
      return { contentType: edit.contentType, value: edit.undo.value };
    case "middle-right":
      return { contentType: edit.contentType, value: edit.undo.value };
    case "mini-logo":
      return { contentType: edit.contentType, value: edit.undo.value };
    case "type-logo":
      return { contentType: edit.contentType, value: edit.undo.value };
    default: {
      const unhandled: never = edit;
      return unhandled;
    }
  }
};

export class ProfileScopedUndoHistory {
  private profileId: string | null = null;
  private entries: ShinyCardUndoEntry[] = [];

  synchronize(profileId: string | null): string | null {
    if (this.profileId !== profileId) {
      this.entries = [];
      this.profileId = profileId;
    }
    return profileId;
  }

  enqueue(
    profileId: string | null,
    currentProfileId: string | null,
    entry: ShinyCardUndoEntry,
  ): void {
    this.synchronize(currentProfileId);
    if (profileId && profileId === currentProfileId) this.entries.push(entry);
  }

  pop(profileId: string | null): ShinyCardUndoEntry | undefined {
    this.synchronize(profileId);
    return this.entries.pop();
  }

  get size(): number {
    return this.entries.length;
  }
}

export function createMonCardEdit(
  kind: MonSelectionKind,
  current: SelectedMons,
  next: SelectedMons,
): ShinyCardEdit {
  switch (kind) {
    case "demon":
      return {
        contentType: kind,
        value: next[kind],
        undo: { kind: "record", value: current[kind] },
      };
    case "angel":
      return {
        contentType: kind,
        value: next[kind],
        undo: { kind: "record", value: current[kind] },
      };
    case "drainer":
      return {
        contentType: kind,
        value: next[kind],
        undo: { kind: "record", value: current[kind] },
      };
    case "spirit":
      return {
        contentType: kind,
        value: next[kind],
        undo: { kind: "record", value: current[kind] },
      };
    case "mystic":
      return {
        contentType: kind,
        value: next[kind],
        undo: { kind: "record", value: current[kind] },
      };
  }
}

export function createStickerCardEdit(
  slot: StickerSlot,
  current: StickerMap,
  next: StickerMap,
): ShinyCardEdit {
  switch (slot) {
    case "big-mon-top-right":
      return {
        contentType: slot,
        value: next[slot],
        undo: { kind: "record", value: current[slot] },
      };
    case "bottom-left":
      return {
        contentType: slot,
        value: next[slot],
        undo: { kind: "record", value: current[slot] },
      };
    case "bottom-right":
      return {
        contentType: slot,
        value: next[slot],
        undo: { kind: "record", value: current[slot] },
      };
    case "mana":
      return {
        contentType: slot,
        value: next[slot],
        undo: { kind: "record", value: current[slot] },
      };
    case "middle-left":
      return {
        contentType: slot,
        value: next[slot],
        undo: { kind: "record", value: current[slot] },
      };
    case "middle-right":
      return {
        contentType: slot,
        value: next[slot],
        undo: { kind: "record", value: current[slot] },
      };
    case "mini-logo":
      return {
        contentType: slot,
        value: next[slot],
        undo: { kind: "record", value: current[slot] },
      };
    case "type-logo":
      return {
        contentType: slot,
        value: next[slot],
        undo: { kind: "record", value: current[slot] },
      };
  }
}

export const isInventoryEmojiId = (
  emojiId: EmojiId | null | undefined,
  inventoryStartId: number,
): boolean => {
  return isEmojiId(emojiId) && emojiId >= inventoryStartId;
};

export const getNextRegularId = (
  currentId: number,
  regularItemCount: number,
): number => {
  if (
    regularItemCount <= 0 ||
    !Number.isFinite(currentId) ||
    currentId < 0 ||
    currentId >= regularItemCount
  ) {
    return 0;
  }
  return (currentId + 1) % regularItemCount;
};

export const getShinyCardUndoUpdateSource = (
  entry: ShinyCardUndoEntry,
  options: {
    inventoryEmojiStartId: number;
    inventoryBackgroundId: number;
    inventoryDrainerId: number;
    inventoryStickerType: string;
    inventoryStickerName: string;
  },
): ShinyCardUpdateSource => {
  if (entry.contentType === "emojiAndAura") {
    const emojiAndAura = entry.value;
    return isInventoryEmojiId(
      emojiAndAura?.emojiId,
      options.inventoryEmojiStartId,
    ) || emojiAndAura?.aura === "rainbow"
      ? "inventory"
      : "default";
  }
  if (entry.contentType === "bg") {
    return entry.value === options.inventoryBackgroundId
      ? "inventory"
      : "default";
  }
  if (entry.contentType === "drainer") {
    return entry.value === options.inventoryDrainerId ? "inventory" : "default";
  }
  if (entry.contentType === options.inventoryStickerType) {
    return entry.value === options.inventoryStickerName
      ? "inventory"
      : "default";
  }
  return "default";
};
