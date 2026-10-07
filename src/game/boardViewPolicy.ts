export type BoardViewMode = "activeLive" | "waitingLive" | "historicalView";

export type BoardViewUiContext = {
  mode: BoardViewMode;
  isOnlineGame: boolean;
  isWatchOnly: boolean;
  isGameWithBot: boolean;
  isGameOver: boolean;
  isWaitingForRematchResponse: boolean;
  isSeriesEnded: boolean;
};

export type BoardViewControls = {
  endMatchVisible: boolean | null;
  endMatchConfirmed: true | null;
  voiceReactionVisible: boolean | null;
  hideGameControls: boolean;
  automoveVisible: false | null;
  undoVisible: false | null;
  undoEnabled: false | null;
  hideTimers: boolean;
};

export const deriveBoardViewControls = ({
  mode,
  isOnlineGame,
  isWatchOnly,
  isGameWithBot,
  isGameOver,
  isWaitingForRematchResponse,
  isSeriesEnded,
}: BoardViewUiContext): BoardViewControls => {
  const isOnlineParticipant = isOnlineGame && !isWatchOnly;
  if (mode === "historicalView") {
    return {
      endMatchVisible:
        isOnlineParticipant &&
        (isSeriesEnded || isGameOver || isWaitingForRematchResponse),
      endMatchConfirmed: isOnlineParticipant && isSeriesEnded ? true : null,
      voiceReactionVisible: isGameWithBot || isOnlineParticipant,
      hideGameControls: true,
      automoveVisible: null,
      undoVisible: null,
      undoEnabled: null,
      hideTimers: true,
    };
  }
  if (mode === "waitingLive") {
    return {
      endMatchVisible: true,
      endMatchConfirmed: null,
      voiceReactionVisible: isOnlineParticipant,
      hideGameControls: false,
      automoveVisible: false,
      undoVisible: false,
      undoEnabled: false,
      hideTimers: true,
    };
  }
  return {
    endMatchVisible: null,
    endMatchConfirmed: null,
    voiceReactionVisible: isOnlineGame ? !isWatchOnly : null,
    hideGameControls: false,
    automoveVisible: null,
    undoVisible: null,
    undoEnabled: null,
    hideTimers: false,
  };
};
