export type BoardReactionMetadataApi = {
  showVoiceReactionText(reactionText: string, opponent: boolean): void;
  isMetadataSideDisplayedAtOpponentSlot(opponent: boolean): boolean;
  getPlayerUid(): string;
  getOpponentUid(): string;
};

let metadataApi: BoardReactionMetadataApi | null = null;
let showVideoReactionHandler: (
  opponent: boolean,
  stickerId: number,
) => void = () => {};

export const bindBoardReactionMetadataApi = (
  nextApi: BoardReactionMetadataApi,
): void => {
  metadataApi = nextApi;
};

export const bindBoardVideoReactionHandler = (
  handler: (opponent: boolean, stickerId: number) => void,
): void => {
  showVideoReactionHandler = handler;
};

export const resetBoardVideoReactionHandler = (): void => {
  showVideoReactionHandler = () => {};
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
  showVideoReactionHandler(opponent, stickerId);
