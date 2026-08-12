export type ShinyCardRuntime = {
  updateProfileCounter(counter: string): void;
  updateCardBackgroundId(id: number): void;
  updateCardSubtitleId(id: number): void;
  updateProfileMons(mons: string): void;
  updateCardStickers(stickers: string): void;
  didClickAndChangePlayerEmoji(
    newId: string,
    newEmojiUrl: string,
    aura?: string,
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

export const updateShinyCardProfileCounter = (counter: string): void =>
  getRuntime().updateProfileCounter(counter);

export const updateShinyCardBackgroundId = (id: number): void =>
  getRuntime().updateCardBackgroundId(id);

export const updateShinyCardSubtitleId = (id: number): void =>
  getRuntime().updateCardSubtitleId(id);

export const updateShinyCardProfileMons = (mons: string): void =>
  getRuntime().updateProfileMons(mons);

export const updateShinyCardStickers = (stickers: string): void =>
  getRuntime().updateCardStickers(stickers);

export const notifyShinyCardPlayerEmojiChange = (
  newId: string,
  newEmojiUrl: string,
  aura?: string,
): void => getRuntime().didClickAndChangePlayerEmoji(newId, newEmojiUrl, aura);

export const notifyShinyCardMonsChange = (): Promise<void> =>
  getRuntime().didUpdateIdCardMons();
