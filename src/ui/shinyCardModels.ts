import type { EmojiId } from "../content/emojis";
import type { MonType } from "../utils/namedMons";
import type { StickerType } from "../utils/stickers";

export type ShinyCardUpdateSource = "default" | "inventory";

export type UndoIntent<T> =
  { readonly kind: "record"; readonly value: T } | { readonly kind: "skip" };

type ShinyCardValues = {
  profileCounter: string;
  emojiAndAura: { emojiId: EmojiId; aura: string };
  bg: number;
  subtitle: number;
} & Record<MonType, number> &
  Record<StickerType, string | undefined>;

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
    case "subtitle":
    case "demon":
    case "angel":
    case "drainer":
    case "spirit":
    case "mystic":
      return { contentType: edit.contentType, value: edit.undo.value };
    case "big-mon-top-right":
    case "bottom-left":
    case "bottom-right":
    case "mana":
    case "middle-left":
    case "middle-right":
    case "mini-logo":
    case "type-logo":
      return { contentType: edit.contentType, value: edit.undo.value };
    default: {
      const unhandled: never = edit;
      void unhandled;
      return null;
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
    if (profileId && profileId === currentProfileId) {
      this.entries.push(entry);
    }
  }

  pop(profileId: string | null): ShinyCardUndoEntry | undefined {
    this.synchronize(profileId);
    return this.entries.pop();
  }

  get size(): number {
    return this.entries.length;
  }
}

export const parseStickerMap = (json: string): Record<string, string> => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
};

export const isInventoryEmojiId = (
  emojiId: string | number | undefined,
  inventoryStartId: number,
): boolean => {
  const parsed = Number.parseInt(`${emojiId ?? ""}`, 10);
  return Number.isFinite(parsed) && parsed >= inventoryStartId;
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
    return Number(entry.value) === options.inventoryBackgroundId
      ? "inventory"
      : "default";
  }
  if (entry.contentType === "drainer") {
    return Number(entry.value) === options.inventoryDrainerId
      ? "inventory"
      : "default";
  }
  if (entry.contentType === options.inventoryStickerType) {
    return entry.value === options.inventoryStickerName
      ? "inventory"
      : "default";
  }
  return "default";
};
