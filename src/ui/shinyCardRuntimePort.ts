import type {
  CardBackgroundId,
  CardSubtitleId,
  ProfileCounter,
  SelectedMons,
  StickerMap,
} from "@mons/shared/appearance";
import type { Aura } from "@mons/shared/appearance";
import type { EmojiId } from "../content/emojis";

export type ShinyCardRuntime = {
  updateProfileCounter(counter: ProfileCounter): void;
  updateCardBackgroundId(id: CardBackgroundId): void;
  updateCardSubtitleId(id: CardSubtitleId): void;
  updateProfileMons(mons: SelectedMons | null): void;
  updateCardStickers(stickers: StickerMap): void;
  didClickAndChangePlayerEmoji(
    newId: EmojiId,
    newEmojiUrl: string,
    aura?: Aura,
  ): void;
  didUpdateIdCardMons(): Promise<void>;
};

let runtime: ShinyCardRuntime | null = null;

const getRuntime = (): ShinyCardRuntime => {
  if (!runtime) {
    throw new Error("shiny-card-runtime-not-bound");
  }
  return runtime;
};

export const bindShinyCardRuntime = (nextRuntime: ShinyCardRuntime): void => {
  runtime = nextRuntime;
};

export const updateShinyCardProfileCounter = (counter: ProfileCounter): void =>
  getRuntime().updateProfileCounter(counter);

export const updateShinyCardBackgroundId = (id: CardBackgroundId): void =>
  getRuntime().updateCardBackgroundId(id);

export const updateShinyCardSubtitleId = (id: CardSubtitleId): void =>
  getRuntime().updateCardSubtitleId(id);

export const updateShinyCardProfileMons = (mons: SelectedMons | null): void =>
  getRuntime().updateProfileMons(mons);

export const updateShinyCardStickers = (stickers: StickerMap): void =>
  getRuntime().updateCardStickers(stickers);

export const notifyShinyCardPlayerEmojiChange = (
  newId: EmojiId,
  newEmojiUrl: string,
  aura?: Aura,
): void => getRuntime().didClickAndChangePlayerEmoji(newId, newEmojiUrl, aura);

export const notifyShinyCardMonsChange = (): Promise<void> =>
  getRuntime().didUpdateIdCardMons();
