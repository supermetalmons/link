export type BoardReactionMetadataApi = {
  showVoiceReactionText(reactionText: string, opponent: boolean): void;
  isMetadataSideDisplayedAtOpponentSlot(opponent: boolean): boolean;
  getPlayerUid(): string;
  getOpponentUid(): string;
};

export type BoardVideoReactionHandler = (
  opponent: boolean,
  stickerId: number,
) => void;

let metadataApi: BoardReactionMetadataApi | null = null;
let showVideoReactionHandler: BoardVideoReactionHandler | null = null;

export const bindBoardReactionMetadataApi = (
  nextApi: BoardReactionMetadataApi,
): void => {
  metadataApi = nextApi;
};

export const bindBoardVideoReactionHandler = (
  handler: BoardVideoReactionHandler,
): BoardVideoReactionHandler => {
  showVideoReactionHandler = handler;
  return handler;
};

export const unbindBoardVideoReactionHandler = (
  handler: BoardVideoReactionHandler,
): void => {
  if (showVideoReactionHandler === handler) {
    showVideoReactionHandler = null;
  }
};

export const resetBoardVideoReactionHandler = (): void => {
  showVideoReactionHandler = null;
};

export const showVoiceReactionText = (
  reactionText: string,
  opponent: boolean,
): void => metadataApi?.showVoiceReactionText(reactionText, opponent);

export const isMetadataSideDisplayedAtOpponentSlot = (
  opponent: boolean,
): boolean =>
  metadataApi?.isMetadataSideDisplayedAtOpponentSlot(opponent) ?? opponent;

export const getPlayerReactionUid = (): string =>
  metadataApi?.getPlayerUid() ?? "";

export const getOpponentReactionUid = (): string =>
  metadataApi?.getOpponentUid() ?? "";

export const showVideoReaction = (opponent: boolean, stickerId: number): void =>
  showVideoReactionHandler?.(opponent, stickerId);
