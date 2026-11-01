import { requireValue } from "./browserAssertions.ts";
import {
  isEmojiId,
  type Aura,
  type CardBackgroundId,
  type CardSubtitleId,
  type EmojiId,
  type ProfileCounter,
  type SelectedMons,
  type StickerMap,
} from "@mons/shared/appearance";

export type FixtureValues = {
  ProfileId: string;
  PlayerEmojiId: EmojiId;
  PlayerEmojiAura: Aura;
  CardBackgroundId: CardBackgroundId;
  CardSubtitleId: CardSubtitleId;
  CardStickers: StickerMap;
  ProfileMons: SelectedMons | null;
  ProfileCounter: ProfileCounter;
  PlayerRating: number;
  PlayerNonce: number;
  PlayerTotalManaPoints: number;
};
export const initialValues: FixtureValues = {
  ProfileId: "owner-a",
  PlayerEmojiId: 1,
  PlayerEmojiAura: "none",
  CardBackgroundId: 30,
  CardSubtitleId: 0,
  CardStickers: {},
  ProfileMons: { demon: 0, angel: 0, drainer: 0, spirit: 0, mystic: 0 },
  ProfileCounter: "gp",
  PlayerRating: 1500,
  PlayerNonce: 3,
  PlayerTotalManaPoints: 7,
};

export const environment = {
  values: { ...initialValues },
  writes: [] as unknown[][],
  onWrite: null as ((write: unknown[]) => void) | null,
  spriteRequests: [] as string[],
  releaseSprites: () => {},
};

export const spritesReady = new Promise<void>((resolve) => {
  environment.releaseSprites = resolve;
});

export const storage = {
  getProfileId: (_fallback: string): string => environment.values.ProfileId,
  setProfileId: (value: string): void => {
    environment.values.ProfileId = value;
  },
  getPlayerEmojiId: (_fallback: EmojiId): EmojiId =>
    environment.values.PlayerEmojiId,
  setPlayerEmojiId: (value: EmojiId): void => {
    if (!isEmojiId(value)) throw new TypeError("invalid-emoji");
    environment.values.PlayerEmojiId = value;
  },
  getPlayerEmojiAura: (_fallback: Aura): Aura =>
    environment.values.PlayerEmojiAura,
  setPlayerEmojiAura: (value: Aura): void => {
    environment.values.PlayerEmojiAura = value;
  },
  getCardBackgroundId: (_fallback: CardBackgroundId): CardBackgroundId =>
    environment.values.CardBackgroundId,
  setCardBackgroundId: (value: CardBackgroundId): void => {
    environment.values.CardBackgroundId = value;
  },
  getCardSubtitleId: (_fallback: CardSubtitleId): CardSubtitleId =>
    environment.values.CardSubtitleId,
  setCardSubtitleId: (value: CardSubtitleId): void => {
    environment.values.CardSubtitleId = value;
  },
  getCardStickers: (_fallback: StickerMap): StickerMap =>
    environment.values.CardStickers,
  setCardStickers: (value: StickerMap): void => {
    environment.values.CardStickers = value;
  },
  getProfileMons: (_fallback: SelectedMons | null): SelectedMons | null =>
    environment.values.ProfileMons,
  setProfileMons: (value: SelectedMons | null): void => {
    environment.values.ProfileMons = value;
  },
  getProfileCounter: (_fallback: ProfileCounter): ProfileCounter =>
    environment.values.ProfileCounter,
  setProfileCounter: (value: ProfileCounter): void => {
    environment.values.ProfileCounter = value;
  },
  getPlayerRating: (_fallback: number): number =>
    environment.values.PlayerRating,
  setPlayerRating: (value: number): void => {
    environment.values.PlayerRating = value;
  },
  getPlayerNonce: (_fallback: number): number => environment.values.PlayerNonce,
  setPlayerNonce: (value: number): void => {
    environment.values.PlayerNonce = value;
  },
  getPlayerTotalManaPoints: (_fallback: number): number =>
    environment.values.PlayerTotalManaPoints,
  setPlayerTotalManaPoints: (value: number): void => {
    environment.values.PlayerTotalManaPoints = value;
  },
};

const spriteImages = new Map<string, string>();

export function spriteForKey(key: string): string {
  let image = spriteImages.get(key);
  if (!image) {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext("2d")!;
    const hue = [...key].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    context.fillStyle = `hsl(${hue % 360}, 80%, 50%)`;
    context.fillRect(0, 0, 8, 8);
    image = requireValue(canvas.toDataURL("image/png").split(",")[1]);
    spriteImages.set(key, image);
  }
  return image;
}
