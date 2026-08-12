import type { InputModifier, Location } from "../utils/gameModels";

export type GameInputRuntime = {
  readonly isOnlineGame: boolean;
  readonly isWatchOnly: boolean;
  readonly isGameWithBot: boolean;
  readonly isWaitingForRematchResponse: boolean;
  didClickSquare(location: Location): void;
  didClickOutsideBoard(): void;
  didSelectInputModifier(inputModifier: InputModifier): void;
  canChangeEmoji(opponents: boolean): boolean;
  sendPlayerEmojiUpdate(newId: number, aura?: string): void;
  showItemsAfterChangingAssetsStyle(): void;
  cleanupCurrentInputs(): void;
  didClickInviteBotIntoLocalGameButton(): void;
  restoreBoardVariantAfterWaitingAnimation(): void;
  showNextWaitingAnimationBoardVariant(): void;
};

let runtime: GameInputRuntime | null = null;

const getRuntime = (): GameInputRuntime => {
  if (!runtime) {
    throw new Error("game-input-runtime-not-bound");
  }
  return runtime;
};

export const bindGameInputRuntime = (
  nextRuntime: GameInputRuntime,
): GameInputRuntime => {
  runtime = nextRuntime;
  return nextRuntime;
};

export const gameInputRuntime: GameInputRuntime = {
  get isOnlineGame() {
    return getRuntime().isOnlineGame;
  },
  get isWatchOnly() {
    return getRuntime().isWatchOnly;
  },
  get isGameWithBot() {
    return getRuntime().isGameWithBot;
  },
  get isWaitingForRematchResponse() {
    return getRuntime().isWaitingForRematchResponse;
  },
  didClickSquare(location) {
    const { didClickSquare } = getRuntime();
    didClickSquare(location);
  },
  didClickOutsideBoard() {
    const { didClickOutsideBoard } = getRuntime();
    didClickOutsideBoard();
  },
  didSelectInputModifier(inputModifier) {
    const { didSelectInputModifier } = getRuntime();
    didSelectInputModifier(inputModifier);
  },
  canChangeEmoji(opponents) {
    const { canChangeEmoji } = getRuntime();
    return canChangeEmoji(opponents);
  },
  sendPlayerEmojiUpdate(newId, aura) {
    const { sendPlayerEmojiUpdate } = getRuntime();
    sendPlayerEmojiUpdate(newId, aura);
  },
  showItemsAfterChangingAssetsStyle() {
    const { showItemsAfterChangingAssetsStyle } = getRuntime();
    showItemsAfterChangingAssetsStyle();
  },
  cleanupCurrentInputs() {
    const { cleanupCurrentInputs } = getRuntime();
    cleanupCurrentInputs();
  },
  didClickInviteBotIntoLocalGameButton() {
    const { didClickInviteBotIntoLocalGameButton } = getRuntime();
    didClickInviteBotIntoLocalGameButton();
  },
  restoreBoardVariantAfterWaitingAnimation() {
    const { restoreBoardVariantAfterWaitingAnimation } = getRuntime();
    restoreBoardVariantAfterWaitingAnimation();
  },
  showNextWaitingAnimationBoardVariant() {
    const { showNextWaitingAnimationBoardVariant } = getRuntime();
    showNextWaitingAnimationBoardVariant();
  },
};
