export type ShinyCardUpdateSource = "default" | "inventory";
export type ShinyCardUndoEntry = readonly [contentType: string, oldId: unknown];

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
    const parsed = JSON.parse(json);
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
  contentType: string,
  oldId: unknown,
  options: {
    inventoryEmojiStartId: number;
    inventoryBackgroundId: number;
    inventoryDrainerId: number;
    inventoryStickerType: string;
    inventoryStickerName: string;
  },
): ShinyCardUpdateSource => {
  if (contentType === "emojiAndAura") {
    const emojiAndAura = oldId as
      { emojiId?: string | number; aura?: string } | null | undefined;
    return isInventoryEmojiId(
      emojiAndAura?.emojiId,
      options.inventoryEmojiStartId,
    ) || emojiAndAura?.aura === "rainbow"
      ? "inventory"
      : "default";
  }
  if (contentType === "bg") {
    return Number(oldId) === options.inventoryBackgroundId
      ? "inventory"
      : "default";
  }
  if (contentType === "drainer") {
    return Number(oldId) === options.inventoryDrainerId
      ? "inventory"
      : "default";
  }
  if (contentType === options.inventoryStickerType) {
    return oldId === options.inventoryStickerName ? "inventory" : "default";
  }
  return "default";
};
