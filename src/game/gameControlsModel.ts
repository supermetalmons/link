import type { BoardViewMode } from "./boardViewPolicy";
import type { GameControlsState } from "../ui/controls/bottomControlsState";

export type GameControlsContext = {
  sessionId: number;
  isOnlineGame: boolean;
  isWatchOnly: boolean;
  isGameWithBot: boolean;
  puzzleMode: boolean;
  isGameOver: boolean;
  boardViewMode: BoardViewMode;
  isSeriesEnded: boolean;
  selectedPuzzleId: string | null;
};

export type GameControlsViewContext = GameControlsContext & {
  currentInviteEventId: string | null;
};

export type GameControlsPresentation = {
  gameControls: GameControlsState;
  endMatchVisible: boolean;
  endMatchConfirmed: boolean;
  inviteLinkVisible: boolean;
  inviteReadyToCopy: boolean;
  botGameVisible: boolean;
  watchOnlyVisible: boolean;
  homeVisible: boolean;
  navigationDimmed: boolean;
  appearanceDimmed: boolean;
  navigationVisible: boolean;
  waitingText: string;
  voiceReactionVisible: boolean;
  moveHistoryVisible: boolean;
  replayPuzzleVisible: boolean;
};

export type GameControlsSnapshot = {
  context: GameControlsContext;
  presentation: GameControlsPresentation;
};

export const createGameControlsContext = (): GameControlsContext => ({
  sessionId: 0,
  isOnlineGame: false,
  isWatchOnly: false,
  isGameWithBot: false,
  puzzleMode: false,
  isGameOver: false,
  boardViewMode: "activeLive",
  isSeriesEnded: false,
  selectedPuzzleId: null,
});

export const createGameControlsPresentation = (
  gameControls: GameControlsState,
): GameControlsPresentation => ({
  gameControls,
  endMatchVisible: false,
  endMatchConfirmed: false,
  inviteLinkVisible: false,
  inviteReadyToCopy: false,
  botGameVisible: false,
  watchOnlyVisible: false,
  homeVisible: false,
  navigationDimmed: false,
  appearanceDimmed: false,
  navigationVisible: false,
  waitingText: "",
  voiceReactionVisible: false,
  moveHistoryVisible: false,
  replayPuzzleVisible: false,
});

export const deriveGameControlsView = ({
  context,
  presentation,
}: GameControlsSnapshot) => ({
  canWagerInCurrentGame:
    context.isOnlineGame &&
    !context.isWatchOnly &&
    !context.isGameWithBot &&
    context.boardViewMode === "activeLive" &&
    !context.isGameOver,
  isWatchOnlyMatchFinished:
    context.isWatchOnly && context.isGameOver && context.isSeriesEnded,
  primaryActionText:
    presentation.gameControls.primaryAction === "joinGame"
      ? "Join Game"
      : presentation.gameControls.primaryAction === "rematch"
        ? context.puzzleMode
          ? "Next Lesson"
          : "Play Again"
        : "",
});
