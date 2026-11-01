import type { Aura } from "@mons/shared/appearance";
import * as MonsRules from "mons-rules";
import {
  markMainGameContentReady,
  markMainGameError,
  markMainGameWaiting,
  onMainGameLoaded,
} from "./mainGameLoadState";
import { MATCH_TIMER_DURATION_SECONDS } from "@mons/shared/timers";
import { createMatchTimerController } from "./matchTimerController";
import { createRemoteMoveSyncController } from "./remoteMoveSyncController";
import {
  applyDisposedControlsPreset,
  applyGameplayControlsPreset,
  applyRouteControlsPreset,
} from "./sessionControls";
import { requestSmartAutomoveFromWorker } from "./automoveWorkerClient";
import type { WorkerAutomoveResult } from "./automoveWorkerProtocol";
import {
  getAutomoveWorkerFailurePolicy,
  getWatchAutomoveWorkerRetryDelayMs,
  type AutomoveWorkerFailurePolicy,
} from "./automoveWorkerFailurePolicy";
import * as Board from "./board";
import {
  tokensForSingleMoveEvents,
  MoveHistoryEntry,
} from "./moveEventStrings";
import {
  Location,
  Highlight,
  HighlightKind,
  AssistedInputKind,
  Sound,
  InputModifier,
  Trace,
} from "../utils/gameModels";
import { colors } from "../content/boardStyles";
import { playSounds, playReaction, newReactionOfKind } from "../content/sounds";
import {
  gameConnection as connection,
  isGameConnectionBound,
  type AutomatchResponse,
} from "./gameConnectionPort";
import {
  showMoveHistoryButton,
  setWatchOnlyVisible,
  showResignButton,
  showVoiceReactionButton,
  setUndoEnabled,
  setUndoVisible,
  disableAndHideUndoResignAndTimerControls,
  hideTimerButtons,
  showTimerButtonProgressing,
  enableTimerVictoryClaim,
  showPrimaryAction,
  PrimaryActionType,
  type PrimaryAction,
  setInviteLinkActionVisible,
  setAutomatchVisible,
  setHomeVisible,
  setIsReadyToCopyExistingInviteLink,
  setAutomoveActionVisible,
  setAutomoveActionEnabled,
  setAutomatchEnabled,
  setAutomatchWaitingState,
  setBotGameOptionVisible,
  setEndMatchVisible,
  setEndMatchConfirmed,
  showWaitingStateText,
  setBrushAndNavigationButtonDimmed,
  setNavigationListButtonVisible,
  setPlaySamePuzzleAgainButtonVisible,
  closeNavigationAndAppearancePopupIfAny,
} from "../ui/controls/bottomControlsPort";
import {
  triggerMoveHistoryPopupReload,
  isMoveHistoryPopupFollowingLatest,
} from "../ui/controls/moveHistoryPopupStore";
import { bindTutorialProgressSyncHandler } from "../ui/controls/tutorialProgressPort";
import {
  Match,
  MatchWagerState,
  HistoricalMatchPair,
  InviteReaction,
  RematchSeriesDescriptor,
  RematchSeriesMatchDescriptor,
} from "../connection/connectionModels";
import { recalculateRatingsLocallyForUids } from "../utils/playerMetadata";
import {
  getNextProblem,
  Problem,
  markProblemCompleted,
  getTutorialCompleted,
} from "../content/problems";
import { storage } from "../utils/storage";
import { hideNotificationBanner } from "../ui/identity/profileUiPort";
import { showVideoReaction } from "../ui/controls/boardReactionPort";
import { setIslandButtonDimmed } from "../runtime/islandButtonPort";
import {
  getWagerState,
  setCurrentWagerMatch,
  subscribeToWagerState,
} from "./wagerState";
import {
  isTransitionInProgress,
  transitionToHome,
} from "../session/sessionTransitionPort";
import { getCurrentSessionId, getSessionGuard } from "./matchSession";
import {
  batchGameControlsUpdates,
  updateGameControlsContext,
} from "./gameControlsStore";
import {
  createRematchViewing,
  type RematchSelectionRequest,
  type ViewedRematch,
} from "./rematchViewing";
import { syncOwnProfileMiningState } from "../services/ownProfileMiningHydration";
import { sessionAuth } from "../session/sessionAuth";
import {
  peekInitialIdentity,
  wasInitialIdentityConsumed,
} from "../services/initialIdentityBootstrap";
import { RouteState, getCurrentRouteState } from "../navigation/routeState";
import { INVALID_SNAPSHOT_ROUTE_ERROR } from "../session/sessionErrors";
import {
  buildGameSeedForStoredVariant,
  buildRandomGameSeed,
  createGameModelForStoredVariant,
  GameSeed,
  getAllGameVariantNames,
  legacyDefaultGameVariant,
  normalizeStoredGameVariant,
  StoredGameVariant,
} from "./gameVariants";
import { buildInitialRouteGameSeed } from "./gameSeedSelection";
import {
  BOARD_GRID_SIZE,
  BoardSquareType,
  BoardSquareTypeGrid,
  createLegacyBoardSquareTypeGrid,
  getDisplayedBoardSquareType,
} from "./boardSquareTypes";
import {
  getNextBotAutomoveMode,
  normalizeBotAutomoveMode,
  type BotAutomoveMode,
} from "./botAutomoveMode";
import {
  clearAllManagedGameTimeouts as clearManagedGameTimeouts,
  clearManagedGameTimeout,
  setManagedGameTimeout,
} from "./managedGameTimeouts";
import { bindGameInputRuntime } from "./gameInputPort";
import {
  buildGameFromMoveStreams,
  countRecordedMovesInHistoricalPair as resolveRecordedMoveCount,
  getHistoricalPairGameVariant,
  getHistoricalResignedColor as resolveHistoricalResignedColor,
  getHistoricalWinnerByTimerColor as resolveHistoricalTimerWinnerColor,
  getMatchMovesByColor as resolveMatchMovesByColor,
  getTrustedGameFromMatchPair as resolveTrustedGameFromMatchPair,
  normalizePersistedMoveHistory,
  toMonsColor,
  type TrustedMatchPairGame,
} from "./historicalMatchModels";
import {
  deriveBoardViewControls,
  type BoardViewControls,
  type BoardViewMode,
} from "./boardViewPolicy";

function publishGameControlsContext() {
  updateGameControlsContext({
    sessionId: getCurrentSessionId(),
    isOnlineGame,
    isWatchOnly,
    isGameWithBot,
    puzzleMode,
    isGameOver,
    boardViewMode,
    isSeriesEnded:
      isGameConnectionBound() && !!connection.rematchSeriesEndIsIndicated(),
    selectedPuzzleId: puzzleMode ? (selectedProblem?.id ?? null) : null,
  });
}

export let isWatchOnly = false;
export let isOnlineGame = false;
export let isGameWithBot = false;
export let isWaitingForRematchResponse = false;
let pendingRematchNavigationToLiveBoard = false;

export let puzzleMode = false;
let selectedProblem: Problem | null = null;
let didStartLocalGame = false;
let isGameOver = false;
let isReconnect = false;
let didConnect = false;
let isWaitingForInviteToGetAccepted = false;
let pendingAutomatchTransition = false;
let pendingOnlineReconnectInviteId: string | null = null;
let lastOnlineReconnectRequestedAtMs = 0;
const onlineReconnectRequestCooldownMs = 3000;

const watchOnlyListeners = new Set<(value: boolean) => void>();
const displayedBoardSquareTypeListeners = new Set<
  (squareTypes: BoardSquareTypeGrid | null) => void
>();
let displayedBoardSquareTypes: BoardSquareTypeGrid | null = null;
const waitingAnimationBoardSquareTypes = new Map<
  StoredGameVariant,
  BoardSquareTypeGrid
>();
let activeRouteState: RouteState = getCurrentRouteState();
const isCreateInviteRoute = () =>
  activeRouteState.mode === "home" || activeRouteState.mode === "event";
const isSnapshotRoute = () => activeRouteState.mode === "snapshot";
const isBotsRoute = () => activeRouteState.mode === "watch";
type AutomovePreference = BotAutomoveMode;
let botAutomoveMode: BotAutomoveMode = normalizeBotAutomoveMode(
  storage.getBotAutomoveMode("normal"),
);
const offMainThreadAutomoveRetryDelayMs = 15_000;
let offMainThreadAutomoveDisabledUntilMs = 0;
let consecutiveWatchAutomoveWorkerFailures = 0;
const automoveInFlightGames = new WeakSet<MonsRules.Game>();

const automoveAlreadyInProgressErrorMessage =
  "smart automove already in progress";
const isAutomoveDebugLoggingEnabled = import.meta.env.DEV;
const debugAutomove = (
  message: string,
  details?: Record<string, unknown>,
): void => {
  if (!isAutomoveDebugLoggingEnabled) {
    return;
  }
  if (details) {
    console.debug(`[automove] ${message}`, details);
    return;
  }
  console.debug(`[automove] ${message}`);
};

const boardSquareTypeGridsEqual = (
  a: BoardSquareTypeGrid | null,
  b: BoardSquareTypeGrid | null,
): boolean => {
  if (a === b) {
    return true;
  }
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  for (let row = 0; row < a.length; row += 1) {
    const aRow = a[row]!;
    const bRow = b[row]!;
    if (aRow.length !== bRow.length) {
      return false;
    }
    for (let col = 0; col < aRow.length; col += 1) {
      if (aRow[col] !== bRow[col]) {
        return false;
      }
    }
  }
  return true;
};

const normalizeBoardSquareType = (
  square: MonsRules.Square,
): BoardSquareType => {
  switch (square.kind) {
    case "mana-base":
      return "manaBase";
    case "supermana-base":
      return "supermanaBase";
    case "mana-pool":
      return "manaPool";
    case "consumable-base":
      return "consumableBase";
    case "mon-base":
      return "monBase";
    case "regular":
    default:
      return "regular";
  }
};

const buildBoardSquareTypeGrid = (
  gameModel: MonsRules.Game,
  _gameVariant: unknown = currentGameVariant,
): BoardSquareTypeGrid => {
  const squareTypes: BoardSquareTypeGrid = [];
  for (let row = 0; row < BOARD_GRID_SIZE; row += 1) {
    const squareTypeRow: BoardSquareType[] = [];
    for (let col = 0; col < BOARD_GRID_SIZE; col += 1) {
      const square = gameModel.squareAt({ row, column: col });
      squareTypeRow.push(
        getDisplayedBoardSquareType(normalizeBoardSquareType(square), true),
      );
    }
    squareTypes.push(squareTypeRow);
  }
  return squareTypes;
};

const getDisplayedBoardVariant = (
  inFlashbackMode: boolean = flashbackMode,
): StoredGameVariant => {
  const selection = rematchViewing.getSelection();
  if (inFlashbackMode && selection) {
    return getHistoricalPairGameVariant(selection.pair);
  }
  return currentGameVariant;
};

const setDisplayedBoardSquareTypes = (
  squareTypes: BoardSquareTypeGrid | null,
) => {
  if (boardSquareTypeGridsEqual(displayedBoardSquareTypes, squareTypes)) {
    return;
  }
  displayedBoardSquareTypes = squareTypes;
  displayedBoardSquareTypeListeners.forEach((listener) =>
    listener(squareTypes),
  );
};

const updateDisplayedBoardSquareTypes = (
  gameModel: MonsRules.Game | null | undefined,
  gameVariant: unknown = getDisplayedBoardVariant(),
) => {
  setDisplayedBoardSquareTypes(
    gameModel ? buildBoardSquareTypeGrid(gameModel, gameVariant) : null,
  );
};

const refreshDisplayedBoardSquareTypes = (
  inFlashbackMode: boolean = flashbackMode,
) => {
  updateDisplayedBoardSquareTypes(
    inFlashbackMode ? flashbackStateGame : game,
    getDisplayedBoardVariant(inFlashbackMode),
  );
};

const getWaitingAnimationBoardSquareTypes = (
  gameVariant: StoredGameVariant,
): BoardSquareTypeGrid => {
  const cachedSquareTypes = waitingAnimationBoardSquareTypes.get(gameVariant);
  if (cachedSquareTypes) {
    return cachedSquareTypes;
  }

  const gameModel = createGameModelForStoredVariant(gameVariant);
  const squareTypes = buildBoardSquareTypeGrid(gameModel, gameVariant);
  waitingAnimationBoardSquareTypes.set(gameVariant, squareTypes);
  return squareTypes;
};

const getManaBaseLayoutKey = (
  squareTypes: BoardSquareTypeGrid | null,
): string | null => {
  if (!squareTypes) {
    return null;
  }
  const locations: string[] = [];
  squareTypes.forEach((row, rowIndex) => {
    row.forEach((squareType, colIndex) => {
      if (squareType === "manaBase") {
        locations.push(`${rowIndex}:${colIndex}`);
      }
    });
  });
  return locations.length > 0 ? locations.join(",") : null;
};

export function showNextWaitingAnimationBoardVariant() {
  const currentLayout = getManaBaseLayoutKey(displayedBoardSquareTypes);
  const variantsToTry = [...getAllGameVariantNames()];
  while (variantsToTry.length > 0) {
    const variantIndex = Math.floor(Math.random() * variantsToTry.length);
    const [gameVariant] = variantsToTry.splice(variantIndex, 1);
    if (!gameVariant) {
      continue;
    }
    const squareTypes = getWaitingAnimationBoardSquareTypes(gameVariant);
    const candidateLayout = getManaBaseLayoutKey(squareTypes);
    if (!candidateLayout || candidateLayout === currentLayout) {
      continue;
    }
    setDisplayedBoardSquareTypes(squareTypes);
    return;
  }

  if (!currentLayout) {
    setDisplayedBoardSquareTypes(createLegacyBoardSquareTypeGrid());
  }
}

export function restoreBoardVariantAfterWaitingAnimation() {
  refreshDisplayedBoardSquareTypes();
}

export const getCurrentDisplayedBoardSquareTypes = () =>
  displayedBoardSquareTypes;

export const subscribeToDisplayedBoardSquareTypes = (
  listener: (squareTypes: BoardSquareTypeGrid | null) => void,
) => {
  displayedBoardSquareTypeListeners.add(listener);
  listener(displayedBoardSquareTypes);
  return () => {
    displayedBoardSquareTypeListeners.delete(listener);
  };
};

let currentWagerState: MatchWagerState | null = null;
let wagerOutcomeShown = false;
let wagerOutcomeAnimating = false;
let wagerOutcomeAnimTimer: number | null = null;
let wagerOutcomeAnimationAllowed = false;
let didSetupWagerSubscription = false;
let unsubscribeFromWagerState: (() => void) | null = null;

let wagerMatchId: string | null = null;

let game: MonsRules.Game;
let flashbackMode = false;
let flashbackStateGame: MonsRules.Game;
let botPlayerColor: MonsRules.Color;
let playerSideColor: MonsRules.Color;
let resignedColor: MonsRules.Color | undefined;
let winnerByTimerColor: MonsRules.Color | undefined;

const remoteMoveSync = createRemoteMoveSyncController({
  getGame: () => game,
  getActiveMatchId: () => connection.getActiveMatchId(),
  createSessionGuard: getSessionGuard,
  isGameOver: () => isGameOver,
  onReplayOutput: (output) => {
    applyOutput([], "", output, true, false, AssistedInputKind.None);
  },
});

let lastReactionTime = 0;
const botReactionVariationsWhenPlayerScores = [
  17, 20, 374, 429, 465, 900999,
] as const;
const botReactionVariationsWhenBotScores = [40, 63, 210, 900225] as const;
const botScoreReactionChance = 0.2;
const botScoreReactionPlayedTurns = new Set<number>();
const minimumIntervalBetweenBotMovesMs = 777;
const botTurnComputationDelayMs = 420;
let lastBotMoveTimestamp = 0;

const processedVoiceReactions = new Set<string>();
let lastObservedMatchSideFallbackWarningKey = "";

const resetBotScoreReactionState = () => {
  botScoreReactionPlayedTurns.clear();
};

const getRandomReactionVariation = (
  variations: readonly [number, ...number[]],
): number => {
  const variationIndex = Math.floor(Math.random() * variations.length);
  return variations[variationIndex]!;
};

const setCurrentVariant = (gameVariant: unknown): StoredGameVariant => {
  const normalizedVariant = normalizeStoredGameVariant(gameVariant);
  currentGameVariant = normalizedVariant;
  return normalizedVariant;
};

const applyGameSeedToCurrentGame = (seed: GameSeed): MonsRules.Game => {
  setCurrentVariant(seed.gameVariant);
  remoteMoveSync.clearHistories();
  game = createGameModelForStoredVariant(seed.gameVariant);
  return game;
};

const gameModelFromFen = (fen: unknown): MonsRules.Game | null => {
  if (typeof fen !== "string") {
    return null;
  }
  try {
    return MonsRules.Game.fromFen(fen) ?? null;
  } catch {
    return null;
  }
};

const installCurrentGameModel = (gameModel: MonsRules.Game): void => {
  setCurrentVariant(gameModel.variant);
  remoteMoveSync.clearHistories();
  game = gameModel;
};

const loadCurrentGameFromFen = (fen: string): boolean => {
  const gameFromFen = gameModelFromFen(fen);
  if (!gameFromFen) {
    return false;
  }
  installCurrentGameModel(gameFromFen);
  return true;
};

var currentInputs: Location[] = [];

let isInviteBotIntoLocalGameUnavailable = false;
let didMakeFirstLocalPlayerMoveOnLocalBoard = false;

let currentGameVariant: StoredGameVariant = legacyDefaultGameVariant;
let boardViewMode: BoardViewMode = "activeLive";
let isMoveHistoryPopupOpen = false;
let boardRenderSessionId = 0;
let moveHistoryFlipOverrideSessionId: number | null = null;
let moveHistoryFlipOverrideEnabled = false;
let moveHistoryFlipOverrideBaseBoardFlipped: boolean | null = null;
const matchTimers = createMatchTimerController({
  getContext: () => ({
    isOnlineGame,
    isReconnect,
    didConnect,
    isWatchOnly,
    isGameOver,
    hasWinner: game.winner !== undefined,
    hasTimerWinner: winnerByTimerColor !== undefined,
    isPlayerSideTurn: isPlayerSideTurn(),
    boardViewMode,
    turnNumber: game.turnNumber,
    activeColor:
      game.activeColor === MonsRules.Color.White
        ? "white"
        : game.activeColor === MonsRules.Color.Black
          ? "black"
          : null,
    activeMatchId: connection.getActiveMatchId(),
    fallbackMatchId: wagerMatchId,
  }),
  matchBelongsToCurrentInvite: (matchId) =>
    connection.matchBelongsToCurrentInvite(matchId),
  now: () => Date.now(),
  createSessionGuard: getSessionGuard,
  setTimeout: setManagedGameTimeout,
  clearTimeout: clearManagedGameTimeout,
  showCountdown: Board.showTimer,
  hideCountdown: Board.hideTimerCountdownDigits,
  hideButtons: hideTimerButtons,
  showProgress: showTimerButtonProgressing,
  enableVictoryClaim: enableTimerVictoryClaim,
  onTerminal: (onConnect, color) =>
    handleVictoryByTimer(onConnect, color, false),
});
const rematchViewing = createRematchViewing({
  loadMatchPair: (matchId) => connection.loadHistoricalMatchPair(matchId),
  buildHistoricalGame: buildHistoricalGameModel,
  countRecordedMoves: countRecordedMovesInHistoricalPair,
  createSessionGuard: getSessionGuard,
  setTimeout: setManagedGameTimeout,
  clearTimeout: clearManagedGameTimeout,
  wait: (delay) => new Promise((resolve) => window.setTimeout(resolve, delay)),
});

const boardViewDebugLogsEnabled = import.meta.env.DEV;
const summarizeWagerState = (state: MatchWagerState | null) => {
  const proposalKeys = Object.keys(state?.proposals || {});
  const agreed = state?.agreed
    ? {
        material: state.agreed.material,
        count: state.agreed.count,
        total: state.agreed.total,
        proposerId: state.agreed.proposerId,
        accepterId: state.agreed.accepterId,
      }
    : null;
  const resolved = state?.resolved
    ? {
        material: state.resolved.material,
        count: state.resolved.count,
        total: state.resolved.total,
        winnerId: state.resolved.winnerId,
        loserId: state.resolved.loserId,
      }
    : null;
  return {
    hasState: !!state,
    proposalKeys,
    agreed,
    resolved,
  };
};
const logWagerDebug = (
  event: string,
  payload: Record<string, unknown> = {},
) => {
  if (!boardViewDebugLogsEnabled) {
    return;
  }
  console.log("wager-debug", {
    event,
    boardViewMode,
    activeMatchId: connection.getActiveMatchId(),
    viewedRematchMatchId: rematchViewing.getSelection()?.matchId ?? null,
    wagerMatchId,
    isWatchOnly,
    isGameOver,
    isReconnect,
    ...payload,
  });
};

export type RematchSeriesNavigatorItem = {
  matchId: string;
  index: number;
  whiteScore: number | null;
  blackScore: number | null;
  isPendingResponse: boolean;
  isActiveMatch: boolean;
  isSelected: boolean;
  playerIsWhite: boolean;
};

const isFirstLocalRematchSeriesMatchActive = () => {
  const descriptor = getLocalRematchSeriesDescriptor();
  return !descriptor || descriptor.activeMatchId === descriptor.inviteId;
};

const shouldShowInviteBotIntoLocalGameButton = () => {
  if (
    isInviteBotIntoLocalGameUnavailable ||
    isOnlineGame ||
    isGameWithBot ||
    isWatchOnly ||
    puzzleMode ||
    isGameOver ||
    !didStartLocalGame ||
    !isCreateInviteRoute()
  ) {
    return false;
  }
  if (!didMakeFirstLocalPlayerMoveOnLocalBoard) {
    return false;
  }
  if (!isFirstLocalRematchSeriesMatchActive()) {
    return false;
  }
  return game.turnNumber <= 2;
};

const shouldShowBotStrengthControlButton = () =>
  !isOnlineGame &&
  isGameWithBot &&
  !isWatchOnly &&
  boardViewMode === "activeLive" &&
  !flashbackMode;

const syncBotStrengthControlButton = () => {
  Board.setBotStrengthControlMode(botAutomoveMode);
  Board.setBotStrengthControlVisible(shouldShowBotStrengthControlButton());
};

const syncInviteBotIntoLocalGameButton = () => {
  Board.setInviteBotButtonVisible(shouldShowInviteBotIntoLocalGameButton());
  syncBotStrengthControlButton();
};

const setWatchOnlyState = (value: boolean) => {
  if (isWatchOnly === value) {
    return;
  }
  isWatchOnly = value;
  publishGameControlsContext();
  watchOnlyListeners.forEach((listener) => listener(value));
};

export const subscribeToWatchOnly = (listener: (value: boolean) => void) => {
  watchOnlyListeners.add(listener);
  listener(isWatchOnly);
  return () => {
    watchOnlyListeners.delete(listener);
  };
};

export function didSyncTutorialProgress() {
  if (getTutorialCompleted()) {
    dismissNotificationBannerIfNeeded();
  }
  // TODO: update banner numbers if needed
}

bindTutorialProgressSyncHandler(didSyncTutorialProgress);

function hasMoveHistoryFlipOverrideForCurrentSession(): boolean {
  return (
    moveHistoryFlipOverrideEnabled &&
    moveHistoryFlipOverrideSessionId === boardRenderSessionId
  );
}

function clearMoveHistoryFlipOverrideForCurrentSession(): boolean {
  if (!hasMoveHistoryFlipOverrideForCurrentSession()) {
    return false;
  }
  const baseBoardFlipped = moveHistoryFlipOverrideBaseBoardFlipped;
  moveHistoryFlipOverrideEnabled = false;
  moveHistoryFlipOverrideSessionId = null;
  moveHistoryFlipOverrideBaseBoardFlipped = null;
  Board.setBoardMetadataDisplaySwapped(false);
  if (baseBoardFlipped !== null) {
    Board.setBoardFlipped(baseBoardFlipped);
  } else {
    Board.setBoardFlipped(!Board.isFlipped);
  }
  return true;
}

function nextBoardRenderSession(): number {
  boardRenderSessionId += 1;
  Board.setBoardMetadataDisplaySwapped(false);
  moveHistoryFlipOverrideEnabled = false;
  moveHistoryFlipOverrideSessionId = null;
  moveHistoryFlipOverrideBaseBoardFlipped = null;
  return boardRenderSessionId;
}

function isBoardRenderSessionActive(sessionId: number): boolean {
  return sessionId === boardRenderSessionId;
}

function shouldShowOnlineReactionButton(): boolean {
  return boardViewMode === "activeLive" && !isWatchOnly && isOnlineGame;
}

function playIncomingInviteReaction(
  reaction: InviteReaction,
  metadataIsOpponentSide: boolean,
): void {
  const displaySlotIsOpponent = Board.isMetadataSideDisplayedAtOpponentSlot(
    metadataIsOpponentSide,
  );
  if (reaction.kind === "sticker") {
    playSounds([Sound.EmoteReceived]);
    showVideoReaction(displaySlotIsOpponent, reaction.variation);
    return;
  }
  Board.showVoiceReactionText(reaction.kind, metadataIsOpponentSide);
  playReaction(reaction);
}

function applyBoardViewGameControlPolicy(controls: BoardViewControls) {
  if (controls.hideGameControls) {
    disableAndHideUndoResignAndTimerControls();
  }
  if (controls.automoveVisible !== null) {
    setAutomoveActionVisible(controls.automoveVisible);
  }
  if (controls.undoVisible !== null) {
    setUndoVisible(controls.undoVisible);
  }
  if (controls.undoEnabled !== null) {
    setUndoEnabled(controls.undoEnabled);
  }
  if (controls.hideTimers) {
    hideTimerButtons();
  }
}

function applyBoardUiForCurrentView() {
  const controls = deriveBoardViewControls({
    mode: boardViewMode,
    isOnlineGame,
    isWatchOnly,
    isGameWithBot,
    isGameOver,
    isWaitingForRematchResponse,
    isSeriesEnded:
      boardViewMode === "historicalView" &&
      !isWatchOnly &&
      isOnlineGame &&
      !!connection.rematchSeriesEndIsIndicated(),
  });
  if (boardViewMode === "historicalView") {
    matchTimers.cancelVictoryClaim();
    Board.stopMonsBoardAsDisplayAnimations();
    Board.showBoardPlayersInfo();
    showWaitingStateText("");
    if (controls.endMatchVisible !== null) {
      setEndMatchVisible(controls.endMatchVisible);
    }
    if (controls.endMatchConfirmed !== null) {
      setEndMatchConfirmed(controls.endMatchConfirmed);
    }
    if (controls.voiceReactionVisible !== null) {
      showVoiceReactionButton(controls.voiceReactionVisible);
    }
    applyBoardViewGameControlPolicy(controls);
    Board.hideTimerCountdownDigits();
    Board.hideAllMoveStatuses();
    syncInviteBotIntoLocalGameButton();
    return;
  }
  if (boardViewMode === "waitingLive") {
    matchTimers.cancelVictoryClaim();
    Board.runMonsBoardAsDisplayWaitingAnimation();
    Board.hideBoardPlayersInfo();
    if (controls.endMatchVisible !== null) {
      setEndMatchVisible(controls.endMatchVisible);
    }
    showWaitingStateText("");
    if (controls.voiceReactionVisible !== null) {
      showVoiceReactionButton(controls.voiceReactionVisible);
    }
    applyBoardViewGameControlPolicy(controls);
    Board.hideTimerCountdownDigits();
    Board.hideAllMoveStatuses();
    syncInviteBotIntoLocalGameButton();
    return;
  }
  Board.stopMonsBoardAsDisplayAnimations();
  Board.showBoardPlayersInfo();
  showWaitingStateText("");
  if (controls.voiceReactionVisible !== null) {
    showVoiceReactionButton(controls.voiceReactionVisible);
  }
  ensureBoardViewInvariants("applyBoardUiForCurrentView");
  syncInviteBotIntoLocalGameButton();
}

function clearBoardViewInputs() {
  currentInputs = [];
  Board.removeHighlights();
  Board.hideItemSelectionOrConfirmationOverlay();
}

function prepareLiveBoardView(mode: "activeLive" | "waitingLive") {
  nextBoardRenderSession();
  boardViewMode = mode;
  publishGameControlsContext();
  rematchViewing.clearSelection();
  connection.setWagerViewMatchId(null);
  flashbackMode = false;
  clearBoardViewInputs();
  Board.setBoardFlipped(activeBoardShouldBeFlipped());
  applyBoardUiForCurrentView();
}

function enterWaitingLiveView() {
  return batchGameControlsUpdates(() => {
    prepareLiveBoardView("waitingLive");
    refreshDisplayedMatchPresentation();
    if (boardViewDebugLogsEnabled) {
      console.log("[board-view] entered waitingLive");
    }
    triggerMoveHistoryPopupReload();
  });
}

function restoreLiveBoardView() {
  return batchGameControlsUpdates(() => {
    prepareLiveBoardView(
      isWaitingForRematchResponse ? "waitingLive" : "activeLive",
    );
    refreshDisplayedMatchPresentation();
    if (boardViewMode === "activeLive") {
      setNewBoard(false);
      const didRestoreTimerState = matchTimers.restore();
      applyWagerState();
      markKnownWagerInitialStateReceived();
      updateUndoButtonBasedOnGameState();
      if (!isWatchOnly && !isGameOver && game.winner === undefined) {
        if (isOnlineGame) {
          showResignButton();
          showMoveHistoryButton(true);
          if (isPlayerSideTurn()) {
            matchTimers.clearCooldown();
            hideTimerButtons();
            setUndoVisible(true);
            setAutomoveActionVisible(true);
          } else if (!didRestoreTimerState && !matchTimers.waitsForStashes()) {
            const timerMatchId = matchTimers.getMatchId();
            if (timerMatchId) {
              matchTimers.restoreCooldown(timerMatchId);
            } else {
              showTimerButtonProgressing(0, MATCH_TIMER_DURATION_SECONDS, true);
            }
          }
        } else if (didStartLocalGame) {
          if (!puzzleMode) {
            showResignButton();
          }
          showMoveHistoryButton(true);
          setUndoVisible(true);
          setAutomoveActionVisible(true);
          if (isGameWithBot) {
            showVoiceReactionButton(true);
            setAutomoveActionEnabled(isPlayerSideTurn());
          } else {
            showVoiceReactionButton(false);
            setAutomoveActionEnabled(true);
          }
        }
      }
    }
    if (boardViewDebugLogsEnabled) {
      console.log(`[board-view] restored ${boardViewMode}`);
    }
    triggerMoveHistoryPopupReload();
  });
}

function prepareForNewLocalLiveMatch() {
  prepareLiveBoardView("activeLive");
}

function enterHistoricalView(
  selection: ViewedRematch,
  request: RematchSelectionRequest,
): boolean {
  return batchGameControlsUpdates(() => {
    if (!request.isCurrent()) {
      return false;
    }
    const { matchId, pair, game: historicalGame } = selection;
    boardViewMode = "historicalView";
    publishGameControlsContext();
    if (!rematchViewing.commitSelection(request, selection)) {
      return false;
    }
    connection.setWagerViewMatchId(matchId);
    Board.setBoardFlipped(getViewedMatchBoardFlipped(matchId, pair));
    flashbackMode = true;
    flashbackStateGame = historicalGame;
    clearBoardViewInputs();
    applyBoardUiForCurrentView();
    applyWagerState();
    refreshDisplayedMatchPresentation();
    ensureBoardViewInvariants("enterHistoricalView");
    setNewBoard(true);
    scheduleHistoricalMatchArchiveRefresh();
    if (boardViewDebugLogsEnabled) {
      console.log(`[board-view] entered historicalView for ${matchId}`);
    }
    triggerMoveHistoryPopupReload();
    return true;
  });
}

function ensureBoardViewInvariants(source: string) {
  if (
    boardViewMode === "historicalView" &&
    Board.hasMonsBoardDisplayAnimationRunning()
  ) {
    Board.stopMonsBoardAsDisplayAnimations();
    if (boardViewDebugLogsEnabled) {
      console.warn(
        `[board-view] waiting animation stopped during historical view: ${source}`,
      );
    }
  }
}

function shouldPreserveHistoricalViewForCurrentInvite(): boolean {
  const selection = rematchViewing.getSelection();
  return (
    boardViewMode === "historicalView" &&
    selection !== null &&
    connection.matchBelongsToCurrentInvite(selection.matchId)
  );
}

function canTrackLocalRematchSeries(): boolean {
  if (isOnlineGame || isWatchOnly || puzzleMode) {
    return false;
  }
  return isCreateInviteRoute() || isGameWithBot;
}

function ensureLocalRematchSeriesInitialized() {
  if (canTrackLocalRematchSeries()) {
    rematchViewing.ensureLocalSeries();
  }
}

function resetLocalRematchSeriesState() {
  rematchViewing.resetLocalSeries();
  Board.resetLocalHumanSeriesOpponentAvatar();
}

function getLocalRematchSeriesDescriptor(): RematchSeriesDescriptor | null {
  if (!canTrackLocalRematchSeries()) {
    return null;
  }
  rematchViewing.ensureLocalSeries();
  return rematchViewing.getLocalSeriesDescriptor();
}

function getActiveRematchSeriesDescriptor(): RematchSeriesDescriptor | null {
  if (isOnlineGame) {
    return connection.getRematchSeriesDescriptor();
  }
  return getLocalRematchSeriesDescriptor();
}

function localColorFromMonsColor(
  color: MonsRules.Color | undefined,
): "white" | "black" | null {
  if (color === MonsRules.Color.White) {
    return "white";
  }
  if (color === MonsRules.Color.Black) {
    return "black";
  }
  return null;
}

function advanceLocalRematchSeriesToNextMatch() {
  if (!canTrackLocalRematchSeries()) {
    return;
  }
  rematchViewing.advanceLocalSeries({
    gameVariant: currentGameVariant,
    gameModel: game,
    boardFlipped: baseBoardShouldBeFlipped(),
    resignedColor: localColorFromMonsColor(resignedColor),
  });
}

function baseBoardShouldBeFlipped(): boolean {
  return playerSideColor === MonsRules.Color.Black;
}

function activeBoardShouldBeFlipped(): boolean {
  return hasMoveHistoryFlipOverrideForCurrentSession()
    ? !baseBoardShouldBeFlipped()
    : baseBoardShouldBeFlipped();
}

function canHandleLiveBoardInput(): boolean {
  return (
    boardViewMode === "activeLive" &&
    !flashbackMode &&
    (!isReconnect || didConnect) &&
    !isTransitionInProgress()
  );
}

function resetOnlineReconnectRequestState(): void {
  pendingOnlineReconnectInviteId = null;
  lastOnlineReconnectRequestedAtMs = 0;
}

function requestOnlineReconnect(inviteId: string, autojoin: boolean): void {
  const now = Date.now();
  if (
    pendingOnlineReconnectInviteId === inviteId &&
    now - lastOnlineReconnectRequestedAtMs < onlineReconnectRequestCooldownMs
  ) {
    return;
  }
  pendingOnlineReconnectInviteId = inviteId;
  lastOnlineReconnectRequestedAtMs = now;
  connection.signInIfNeededAndConnectToGame(inviteId, autojoin);
}

function getMoveHistorySourceGame(): MonsRules.Game {
  return rematchViewing.getSelection()?.game ?? game;
}

function getViewedMatchPlayerColor(
  matchId: string,
  pair: HistoricalMatchPair,
): "white" | "black" | null {
  if (isWatchOnly) {
    return null;
  }
  const localPlayerUid =
    Board.playerSideMetadata.uid || connection.getSameProfilePlayerUid();
  if (localPlayerUid) {
    const hostColorBySeries = connection.getHostColorForMatch(matchId);
    if (hostColorBySeries) {
      if (pair.hostPlayerId === localPlayerUid) {
        return hostColorBySeries;
      }
      if (pair.guestPlayerId === localPlayerUid) {
        return hostColorBySeries === "white" ? "black" : "white";
      }
    }
  }
  const colorBySeries = connection.getSameProfileColorForMatch(matchId);
  if (colorBySeries) {
    return colorBySeries;
  }
  if (!localPlayerUid) {
    return null;
  }
  if (pair.hostPlayerId === localPlayerUid) {
    if (
      pair.hostMatch?.color === "white" ||
      pair.hostMatch?.color === "black"
    ) {
      return pair.hostMatch.color;
    }
    return null;
  }
  if (pair.guestPlayerId === localPlayerUid) {
    if (
      pair.guestMatch?.color === "white" ||
      pair.guestMatch?.color === "black"
    ) {
      return pair.guestMatch.color;
    }
    return null;
  }
  return null;
}

function getRematchIndexByMatchId(matchId: string): number | null {
  const descriptor = getActiveRematchSeriesDescriptor();
  if (!descriptor) {
    return null;
  }
  const item = descriptor.matches.find(
    (candidate) => candidate.matchId === matchId,
  );
  if (!item) {
    return null;
  }
  return item.index;
}

function getViewedMatchBoardFlipped(
  matchId: string,
  pair: HistoricalMatchPair,
): boolean {
  const localSnapshot = rematchViewing.getLocalSnapshot(matchId);
  if (localSnapshot) {
    return localSnapshot.boardFlipped;
  }
  const targetIndex = getRematchIndexByMatchId(matchId);
  const activeDescriptor = getActiveRematchSeriesDescriptor();
  const activeMatchId =
    activeDescriptor?.activeMatchId ?? connection.getActiveMatchId();
  const activeIndex = activeMatchId
    ? getRematchIndexByMatchId(activeMatchId)
    : null;
  if (targetIndex !== null && activeIndex !== null) {
    const flipParityChanged = Math.abs(targetIndex - activeIndex) % 2 === 1;
    return flipParityChanged
      ? !activeBoardShouldBeFlipped()
      : activeBoardShouldBeFlipped();
  }
  const viewedPlayerColor = getViewedMatchPlayerColor(matchId, pair);
  if (viewedPlayerColor) {
    return viewedPlayerColor === "black";
  }
  return activeBoardShouldBeFlipped();
}

function getPreferredMatchFromHistoricalPair(
  pair: HistoricalMatchPair,
): Match | null {
  const hostMatch = pair.hostMatch;
  const guestMatch = pair.guestMatch;
  if (hostMatch && !guestMatch) {
    return isValidGameFen(hostMatch.fen) ? hostMatch : null;
  }
  if (!hostMatch && guestMatch) {
    return isValidGameFen(guestMatch.fen) ? guestMatch : null;
  }
  if (!hostMatch || !guestMatch) {
    return null;
  }
  const hostFenIsValid = isValidGameFen(hostMatch.fen);
  const guestFenIsValid = isValidGameFen(guestMatch.fen);
  if (hostFenIsValid && !guestFenIsValid) {
    return hostMatch;
  }
  if (!hostFenIsValid && guestFenIsValid) {
    return guestMatch;
  }
  if (!hostFenIsValid || !guestFenIsValid) {
    return null;
  }
  const localPlayerUid = isWatchOnly
    ? null
    : Board.playerSideMetadata.uid || connection.getSameProfilePlayerUid();
  if (localPlayerUid) {
    if (pair.hostPlayerId === localPlayerUid) {
      return hostMatch;
    }
    if (pair.guestPlayerId === localPlayerUid) {
      return guestMatch;
    }
  }
  const hostMovesLength =
    typeof hostMatch.flatMovesString === "string"
      ? hostMatch.flatMovesString.length
      : 0;
  const guestMovesLength =
    typeof guestMatch.flatMovesString === "string"
      ? guestMatch.flatMovesString.length
      : 0;
  if (guestMovesLength > hostMovesLength) {
    return guestMatch;
  }
  return hostMatch;
}

function isValidGameFen(fen: unknown): boolean {
  return gameModelFromFen(fen) !== null;
}

function getTrustedGameFromMatchPair(
  pair: HistoricalMatchPair,
): TrustedMatchPairGame | null {
  return resolveTrustedGameFromMatchPair(pair, gameModelFromFen);
}

function getReconstructedGameFromPair(
  matchId: string,
  pair: HistoricalMatchPair,
): MonsRules.Game | null {
  if (!pair.hostMatch || !pair.guestMatch) {
    return null;
  }
  const { whiteMoves, blackMoves } = getMatchMovesByColor(matchId, pair);
  if (whiteMoves === null || blackMoves === null) {
    return null;
  }
  const normalizedWhiteMoves = normalizePersistedMoveHistory(whiteMoves);
  const normalizedBlackMoves = normalizePersistedMoveHistory(blackMoves);
  if (normalizedWhiteMoves === null || normalizedBlackMoves === null) {
    return null;
  }
  return buildGameFromMoveStreams(
    getHistoricalPairGameVariant(pair),
    normalizedWhiteMoves,
    normalizedBlackMoves,
  );
}

function getBestHistoricalGameModel(
  matchId: string,
  pair: HistoricalMatchPair,
): MonsRules.Game | null {
  const trustedGame = getTrustedGameFromMatchPair(pair);
  if (trustedGame) {
    return trustedGame.gameModel;
  }
  const preferredMatch = getPreferredMatchFromHistoricalPair(pair);
  if (preferredMatch) {
    const baseGame = gameModelFromFen(preferredMatch.fen);
    if (baseGame) {
      return baseGame;
    }
  }
  const reconstructedGame = getReconstructedGameFromPair(matchId, pair);
  if (reconstructedGame) {
    return reconstructedGame;
  }
  return null;
}

function scheduleHistoricalMatchArchiveRefresh(): void {
  if (!isOnlineGame) return;
  rematchViewing.refreshSelectedArchive(
    () => boardViewMode === "historicalView",
    () => {
      refreshDisplayedMatchPresentation();
      triggerMoveHistoryPopupReload();
    },
    (error) =>
      console.error("Error refreshing historical match appearance:", error),
  );
}

function getMatchMovesByColor(
  matchId: string,
  pair: HistoricalMatchPair,
): { whiteMoves: string | null; blackMoves: string | null } {
  return resolveMatchMovesByColor(
    pair,
    connection.getHostColorForMatch(matchId),
  );
}

function countRecordedMovesInHistoricalPair(
  matchId: string,
  pair: HistoricalMatchPair,
): number {
  return resolveRecordedMoveCount(
    pair,
    connection.getHostColorForMatch(matchId),
  );
}

function buildHistoricalGameModel(
  matchId: string,
  pair: HistoricalMatchPair,
): MonsRules.Game | null {
  return getBestHistoricalGameModel(matchId, pair);
}

function getHistoricalResignedColor(
  matchId: string,
  pair: HistoricalMatchPair,
): MonsRules.Color | undefined {
  return resolveHistoricalResignedColor(
    pair,
    connection.getHostColorForMatch(matchId),
  );
}

function getHistoricalWinnerByTimerColor(
  matchId: string,
  pair: HistoricalMatchPair,
): MonsRules.Color | undefined {
  return resolveHistoricalTimerWinnerColor(
    pair,
    connection.getHostColorForMatch(matchId),
  );
}

function getDisplayResignedColor(
  inFlashbackMode: boolean,
): MonsRules.Color | undefined {
  const selection = rematchViewing.getSelection();
  if (boardViewMode === "historicalView" && inFlashbackMode && selection) {
    const localSnapshot = rematchViewing.getLocalSnapshot(selection.matchId);
    if (localSnapshot?.resignedColor === "white") {
      return MonsRules.Color.White;
    }
    if (localSnapshot?.resignedColor === "black") {
      return MonsRules.Color.Black;
    }
    return getHistoricalResignedColor(selection.matchId, selection.pair);
  }
  return resignedColor;
}

function getDisplayWinnerByTimerColor(
  inFlashbackMode: boolean,
): MonsRules.Color | undefined {
  if (boardViewMode === "historicalView" && inFlashbackMode) {
    const selection = rematchViewing.getSelection();
    return selection
      ? getHistoricalWinnerByTimerColor(selection.matchId, selection.pair)
      : undefined;
  }
  return winnerByTimerColor;
}

function shouldShowTerminalIndicators(
  inFlashbackMode: boolean,
  displayGame: MonsRules.Game,
): boolean {
  if (!flashbackMode || !inFlashbackMode) {
    return true;
  }
  return displayGame.toFen() === getMoveHistorySourceGame().toFen();
}

function hasTerminalResultForDisplayedGame(
  displayGame: MonsRules.Game,
  inFlashbackMode: boolean,
): boolean {
  if (!shouldShowTerminalIndicators(inFlashbackMode, displayGame)) {
    return false;
  }
  const displayResignedColor = getDisplayResignedColor(inFlashbackMode);
  const displayWinnerByTimerColor =
    getDisplayWinnerByTimerColor(inFlashbackMode);
  return (
    displayGame.winner !== undefined ||
    displayResignedColor !== undefined ||
    displayWinnerByTimerColor !== undefined
  );
}

function shouldHideBoardMoveStatuses(
  displayGame: MonsRules.Game,
  inFlashbackMode: boolean,
): boolean {
  if (boardViewMode === "waitingLive") {
    return true;
  }
  if (isMoveHistoryPopupOpen) {
    return false;
  }
  if (boardViewMode === "historicalView") {
    return true;
  }
  return hasTerminalResultForDisplayedGame(displayGame, inFlashbackMode);
}

export function getRematchSeriesNavigatorItems(): RematchSeriesNavigatorItem[] {
  const descriptor = getActiveRematchSeriesDescriptor();
  if (!descriptor || !descriptor.hasSeries) {
    return [];
  }
  const activeMatchId = descriptor.activeMatchId;
  const selectedMatchId =
    rematchViewing.getSelection()?.matchId ?? activeMatchId;
  const activeMatchDescriptor = descriptor.matches.find(
    (m: RematchSeriesMatchDescriptor) => m.isActiveMatch,
  );
  const activeMatchIndex = activeMatchDescriptor
    ? activeMatchDescriptor.index
    : 0;
  const activePlayerIsWhite = playerSideColor !== MonsRules.Color.Black;
  return descriptor.matches.map(
    (descriptorItem: RematchSeriesMatchDescriptor) => {
      let whiteScore: number | null = null;
      let blackScore: number | null = null;
      if (descriptorItem.matchId === activeMatchId) {
        whiteScore = game.scores[MonsRules.Color.White];
        blackScore = game.scores[MonsRules.Color.Black];
      } else {
        const localSnapshot = rematchViewing.getLocalSnapshot(
          descriptorItem.matchId,
        );
        if (localSnapshot) {
          whiteScore = localSnapshot.whiteScore;
          blackScore = localSnapshot.blackScore;
        }
        const cachedScore = rematchViewing.getScore(descriptorItem.matchId);
        if (!localSnapshot && cachedScore) {
          whiteScore = cachedScore.white;
          blackScore = cachedScore.black;
        }
      }
      const indexDiff = Math.abs(descriptorItem.index - activeMatchIndex);
      const playerIsWhite =
        indexDiff % 2 === 0 ? activePlayerIsWhite : !activePlayerIsWhite;
      return {
        matchId: descriptorItem.matchId,
        index: descriptorItem.index,
        whiteScore,
        blackScore,
        isPendingResponse: descriptorItem.isPendingResponse,
        isActiveMatch: descriptorItem.isActiveMatch,
        isSelected: selectedMatchId === descriptorItem.matchId,
        playerIsWhite,
      };
    },
  );
}

export async function preloadRematchSeriesScores(): Promise<boolean> {
  if (!isOnlineGame) {
    return false;
  }
  const descriptor = connection.getRematchSeriesDescriptor();
  if (!descriptor || !descriptor.hasSeries) {
    return false;
  }
  const targetMatchIds = descriptor.matches
    .filter(
      (descriptorItem) => descriptorItem.matchId !== descriptor.activeMatchId,
    )
    .map((descriptorItem) => descriptorItem.matchId);
  return rematchViewing.prefetchScores(
    descriptor.activeMatchId,
    targetMatchIds,
    triggerMoveHistoryPopupReload,
  );
}

export async function didSelectRematchSeriesMatch(
  matchId: string,
): Promise<boolean> {
  const startedFromHistoricalView = boardViewMode === "historicalView";
  const hadMoveHistoryFlipOverride =
    hasMoveHistoryFlipOverrideForCurrentSession();
  const descriptor = getActiveRematchSeriesDescriptor();
  const activeMatchId = descriptor?.activeMatchId ?? null;
  if (!activeMatchId) {
    return false;
  }
  const selectedMatchId = rematchViewing.getSelection()?.matchId ?? null;
  if (boardViewMode === "historicalView" && selectedMatchId === matchId) {
    return false;
  }
  if (matchId === activeMatchId) {
    const didHaveHistoricalSelection =
      boardViewMode === "historicalView" ||
      selectedMatchId !== null ||
      flashbackMode;
    if (!didHaveHistoricalSelection) {
      return false;
    }
    restoreLiveBoardView();
    return didHaveHistoricalSelection;
  }
  if (
    hadMoveHistoryFlipOverride &&
    clearMoveHistoryFlipOverrideForCurrentSession()
  ) {
    setNewBoard(startedFromHistoricalView);
    triggerMoveHistoryPopupReload();
  }
  const renderSessionId = nextBoardRenderSession();
  const request = rematchViewing.beginSelection(() =>
    isBoardRenderSessionActive(renderSessionId),
  );
  if (!startedFromHistoricalView) {
    Board.setBoardFlipped(activeBoardShouldBeFlipped());
  }
  const selection = await rematchViewing.loadSelection(request, matchId, {
    online: isOnlineGame,
    localPlayerUid: Board.playerSideMetadata.uid,
  });
  return selection ? enterHistoricalView(selection, request) : false;
}

export function getVerboseTrackingEntities(): MoveHistoryEntry[] {
  const entities = getMoveHistorySourceGame().trackingEntries;
  if (entities.length === 0) {
    return [{ segments: [], hasTurnSeparator: false }];
  }
  return entities.map((entity) => {
    return tokensForSingleMoveEvents(entity.events, entity.color);
  });
}

export function getFenForMoveHistoryIndex(index: number): string | null {
  const entities = getMoveHistorySourceGame().trackingEntries;
  const entity = entities[index];
  if (!entity) {
    return null;
  }
  const isLatest = index === entities.length - 1;
  if (isLatest) {
    return getMoveHistorySourceGame().toFen();
  }
  return entity.fen;
}

export function didToggleMoveHistoryBoardFlip(
  selectedMoveHistoryIndex?: number,
) {
  if (clearMoveHistoryFlipOverrideForCurrentSession()) {
    const inFlashbackMode = flashbackMode;
    setNewBoard(inFlashbackMode);
    if (isMoveHistoryPopupOpen && inFlashbackMode) {
      const entities = getMoveHistorySourceGame().trackingEntries;
      const selectedIndex =
        selectedMoveHistoryIndex !== undefined &&
        selectedMoveHistoryIndex >= 0 &&
        selectedMoveHistoryIndex < entities.length
          ? selectedMoveHistoryIndex
          : -1;
      if (selectedIndex >= 0) {
        updateWagerDisplayForMoveNavigation(selectedIndex, entities.length);
      }
    } else {
      applyWagerState();
    }
    triggerMoveHistoryPopupReload();
    return;
  }

  moveHistoryFlipOverrideSessionId = boardRenderSessionId;
  moveHistoryFlipOverrideEnabled = true;
  moveHistoryFlipOverrideBaseBoardFlipped = Board.isFlipped;
  Board.setBoardMetadataDisplaySwapped(true);
  Board.setBoardFlipped(!Board.isFlipped);
  const inFlashbackMode = flashbackMode;
  setNewBoard(inFlashbackMode);
  if (isMoveHistoryPopupOpen && inFlashbackMode) {
    const entities = getMoveHistorySourceGame().trackingEntries;
    const selectedIndex =
      selectedMoveHistoryIndex !== undefined &&
      selectedMoveHistoryIndex >= 0 &&
      selectedMoveHistoryIndex < entities.length
        ? selectedMoveHistoryIndex
        : -1;
    if (selectedIndex >= 0) {
      updateWagerDisplayForMoveNavigation(selectedIndex, entities.length);
    }
  } else {
    applyWagerState();
  }
  triggerMoveHistoryPopupReload();
}

export function didSelectVerboseTrackingEntity(index: number) {
  const entities = getMoveHistorySourceGame().trackingEntries;
  const entity = entities[index];
  if (!entity) {
    return;
  }

  const isLatest = index === entities.length - 1;
  if (isLatest && boardViewMode === "activeLive") {
    flashbackMode = false;
    currentInputs = [];
    Board.removeHighlights();
    Board.hideItemSelectionOrConfirmationOverlay();
    setNewBoard(false);
    applyWagerState();
    syncInviteBotIntoLocalGameButton();
    return;
  }

  flashbackMode = true;
  const gameFen = entity.fen;
  flashbackStateGame = MonsRules.Game.fromFen(gameFen)!;
  currentInputs = [];
  Board.removeHighlights();
  Board.hideItemSelectionOrConfirmationOverlay();
  setNewBoard(true);
  updateWagerDisplayForMoveNavigation(index, entities.length);
  syncInviteBotIntoLocalGameButton();
}

function updateWagerDisplayForMoveNavigation(
  selectedIndex: number,
  totalEntities: number,
) {
  if (shouldDeferWagerStateForUninstalledMatch()) {
    return;
  }
  if (!currentWagerState || !currentWagerState.resolved) {
    return;
  }
  const resolved = currentWagerState.resolved;
  const material =
    resolved.material || currentWagerState.agreed?.material || null;
  if (!material) {
    return;
  }
  const stakeCount = normalizeWagerStakeCount(
    resolved.count,
    resolved.total ?? currentWagerState.agreed?.total,
  );
  if (!stakeCount) {
    return;
  }
  const isAtEnd = selectedIndex === totalEntities - 1;
  if (isAtEnd) {
    const winnerIsOpponent =
      resolved.winnerId === Board.opponentSideMetadata.uid;
    Board.showResolvedWager(winnerIsOpponent, material, stakeCount, true);
  } else {
    Board.suppressWagerPileTransition();
    Board.setWagerPiles({
      player: { material, count: stakeCount, pending: false },
      opponent: { material, count: stakeCount, pending: false },
    });
  }
}

export function didOpenMoveHistoryPopup() {
  if (isMoveHistoryPopupOpen) {
    return;
  }
  isMoveHistoryPopupOpen = true;
  const displayGame = flashbackMode
    ? flashbackStateGame
    : getMoveHistorySourceGame();
  updateBoardMoveStatuses(displayGame, flashbackMode);
}

export function didDismissMoveHistoryPopup() {
  isMoveHistoryPopupOpen = false;
  if (boardViewMode === "historicalView") {
    const selection = rematchViewing.getSelection();
    if (selection) {
      flashbackMode = true;
      flashbackStateGame = selection.game;
      currentInputs = [];
      Board.removeHighlights();
      Board.hideItemSelectionOrConfirmationOverlay();
      setNewBoard(true);
    }
    applyWagerState();
    syncInviteBotIntoLocalGameButton();
    return;
  }
  rematchViewing.clearSelection();
  if (flashbackMode) {
    flashbackMode = false;
    Board.setBoardFlipped(activeBoardShouldBeFlipped());
    setNewBoard(false);
    applyWagerState();
    syncInviteBotIntoLocalGameButton();
    return;
  }
  updateBoardMoveStatuses(game, false);
  applyWagerState();
  syncInviteBotIntoLocalGameButton();
}

function dismissNotificationBannerIfNeeded() {
  hideNotificationBanner();
}

export function didAttemptAuthentication() {
  if (
    !isOnlineGame &&
    !didStartLocalGame &&
    isCreateInviteRoute() &&
    !isWaitingForInviteToGetAccepted &&
    !didConnect
  ) {
    if (!getTutorialCompleted()) {
      if (storage.isFirstLaunch()) {
        storage.trackFirstLaunch();
      }
    }
  }
}

function cancelSessionPreload() {
  initialWagersMatchId = null;
  cancelRematchScoresPreload?.();
  cancelRematchScoresPreload = null;
}

function resetSessionBoardState() {
  clearManagedGameTimeouts();
  matchTimers.cancelVictoryClaim();
  resetBotScoreReactionState();
  isGameWithBot = false;
  nextBoardRenderSession();
  boardViewMode = "activeLive";
  rematchViewing.reset();
  Board.resetLocalHumanSeriesOpponentAvatar();
  Board.resetPlayersMetadataForSession();
  Board.setBoardFlipped(false);
  publishGameControlsContext();
}

function resetSessionFlags() {
  isOnlineGame = false;
  isGameWithBot = false;
  isWaitingForRematchResponse = false;
  pendingRematchNavigationToLiveBoard = false;
  puzzleMode = false;
  didStartLocalGame = false;
  isGameOver = false;
  isReconnect = false;
  didConnect = false;
  publishGameControlsContext();
}

function resetSessionState(
  phase: "start" | "dispose",
  preserveAutomatchUi = false,
): boolean {
  resetSessionBoardState();
  setIslandButtonDimmed(preserveAutomatchUi);
  if (phase === "dispose") {
    if (unsubscribeFromWagerState) {
      unsubscribeFromWagerState();
      unsubscribeFromWagerState = null;
    }
    didSetupWagerSubscription = false;
    if (wagerOutcomeAnimTimer !== null) {
      clearManagedGameTimeout(wagerOutcomeAnimTimer);
      wagerOutcomeAnimTimer = null;
    }
  }
  resetSessionFlags();
  if (phase === "dispose") {
    selectedProblem = null;
    publishGameControlsContext();
  }
  isWaitingForInviteToGetAccepted = preserveAutomatchUi;
  const isAutomatchTransition = phase === "start" && pendingAutomatchTransition;
  if (phase === "start") {
    pendingAutomatchTransition = false;
  }
  resetOnlineReconnectRequestState();
  isInviteBotIntoLocalGameUnavailable = false;
  didMakeFirstLocalPlayerMoveOnLocalBoard = false;
  if (phase === "dispose") {
    setWatchOnlyState(false);
    currentWagerState = null;
    wagerOutcomeShown = false;
    wagerOutcomeAnimating = false;
    wagerOutcomeAnimationAllowed = false;
    remoteMoveSync.resetProgress();
    wagerMatchId = null;
  }
  flashbackMode = false;
  if (phase === "dispose") {
    lastObservedMatchSideFallbackWarningKey = "";
  }
  resignedColor = undefined;
  winnerByTimerColor = undefined;
  if (phase === "dispose") {
    lastReactionTime = 0;
    lastBotMoveTimestamp = 0;
    processedVoiceReactions.clear();
  }
  currentInputs = [];
  if (phase === "start") {
    setCurrentWagerMatch(null);
    connection.setWagerViewMatchId(null);
    setWatchOnlyState(false);
  }
  matchTimers.reset(null);
  if (phase === "dispose") {
    setCurrentWagerMatch(null);
    connection.setWagerViewMatchId(null);
  } else {
    lastObservedMatchSideFallbackWarningKey = "";
  }
  return isAutomatchTransition;
}

export async function go(routeStateOverride?: RouteState) {
  return batchGameControlsUpdates(() => {
    cancelSessionPreload();
    const routeState = routeStateOverride ?? getCurrentRouteState();
    activeRouteState = routeState;
    const isAutomatchTransition = resetSessionState("start");
    Board.setBotStrengthControlVisible(false);
    triggerMoveHistoryPopupReload();
    if (!didSetupWagerSubscription) {
      didSetupWagerSubscription = true;
      unsubscribeFromWagerState = subscribeToWagerState((state) => {
        currentWagerState = state;
        logWagerDebug("subscription:update", {
          state: summarizeWagerState(state),
        });
        applyWagerState();
        if (
          !shouldDeferWagerStateForUninstalledMatch() &&
          isGameOver &&
          !(isMoveHistoryPopupOpen && flashbackMode)
        ) {
          const outcomeState = syncWagerOutcome();
          logWagerDebug("subscription:sync-on-gameover", { outcomeState });
        }
      });
    }
    Board.setupBoard();
    Board.setPreserveDisplayAnimation(false);
    Board.setBotStrengthControlMode(botAutomoveMode);
    Board.setBotStrengthControlVisible(false);

    playerSideColor = MonsRules.Color.White;
    const initialRouteGameSeed = buildInitialRouteGameSeed(routeState);
    applyGameSeedToCurrentGame(initialRouteGameSeed);
    connection.setupConnection(false, routeState);

    if (isAutomatchTransition) {
      isOnlineGame = true;
      publishGameControlsContext();
      isWaitingForInviteToGetAccepted = true;
      applyRouteControlsPreset("automatchTransition");
      Board.runMonsBoardAsDisplayWaitingAnimation();
    }

    if (isBotsRoute()) {
      game.contentPositions().forEach((position) => {
        const location = new Location(position.row, position.column);
        updateLocation(location);
      });
      updateDisplayedBoardSquareTypes(game);

      didStartLocalGame = true;
      applyRouteControlsPreset("watch");

      setWatchOnlyState(true);
      lastBotMoveTimestamp = 0;
      consecutiveWatchAutomoveWorkerFailures = 0;
      scheduleWatchAutomove();
    } else if (isSnapshotRoute()) {
      const snapshot = routeState.snapshotId ?? "";
      if (!loadCurrentGameFromFen(snapshot)) {
        throw new Error(INVALID_SNAPSHOT_ROUTE_ERROR);
      }
      game.contentPositions().forEach((position) => {
        const location = new Location(position.row, position.column);
        updateLocation(location);
      });
      updateDisplayedBoardSquareTypes(game);
      didStartLocalGame = true;
      applyRouteControlsPreset("snapshot");
    } else if (isCreateInviteRoute()) {
      ensureLocalRematchSeriesInitialized();
      game.contentPositions().forEach((position) => {
        const location = new Location(position.row, position.column);
        updateLocation(location);
      });
      updateDisplayedBoardSquareTypes(game);
      applyRouteControlsPreset("lobby");
    } else {
      isOnlineGame = true;
      publishGameControlsContext();
      applyRouteControlsPreset("invite");

      if (isAutomatchTransition) {
        isWaitingForInviteToGetAccepted = true;
        setAutomatchWaitingState(true);
        Board.runMonsBoardAsDisplayWaitingAnimation();
      } else if (!Board.hasMonsBoardDisplayAnimationRunning()) {
        updateDisplayedBoardSquareTypes(game);
      }
    }

    Board.setupGameInfoElements(
      !isCreateInviteRoute() && !isSnapshotRoute() && !isBotsRoute(),
    );
    if (isSnapshotRoute() || isBotsRoute()) {
      updateBoardMoveStatuses();
      Board.updateScore(
        game.scores[MonsRules.Color.White],
        game.scores[MonsRules.Color.Black],
        game.winner,
        resignedColor,
        winnerByTimerColor,
      );
    }

    if (isBotsRoute()) {
      Board.showRandomEmojisForLoopMode();
    }
    syncInviteBotIntoLocalGameButton();
    if (isCreateInviteRoute() || isSnapshotRoute() || isBotsRoute()) {
      markMainGameContentReady(
        !isBotsRoute() && !isGameOver && game.winner === undefined,
      );
    }
  });
}

export function disposeGameSession(nextRouteState?: RouteState) {
  return batchGameControlsUpdates(() => {
    cancelSessionPreload();
    remoteMoveSync.clearHistories();
    const preserveAutomatchUi = pendingAutomatchTransition;
    const wasWaitingAnimationRunning =
      Board.hasMonsBoardDisplayAnimationRunning();
    const preserveManualInviteAnimation =
      wasWaitingAnimationRunning &&
      isCreateInviteRoute() &&
      nextRouteState?.mode === "invite" &&
      !nextRouteState.autojoin &&
      !!nextRouteState.inviteId &&
      connection.hasPendingInviteCreationFor(nextRouteState.inviteId);
    const preserveWaitingAnimation =
      preserveAutomatchUi || preserveManualInviteAnimation;
    resetSessionState("dispose", preserveAutomatchUi);
    applyDisposedControlsPreset(preserveAutomatchUi);
    Board.setPreserveDisplayAnimation(preserveWaitingAnimation);
    Board.stopMonsBoardAsDisplayAnimations();
    currentGameVariant = legacyDefaultGameVariant;
    if (!preserveWaitingAnimation) {
      setDisplayedBoardSquareTypes(
        wasWaitingAnimationRunning ? createLegacyBoardSquareTypeGrid() : null,
      );
    }
    Board.hideTimerCountdownDigits();
    Board.hideAllMoveStatuses();
    Board.setInviteBotButtonVisible(false);
    Board.setBotStrengthControlVisible(false);
    Board.removeHighlights();
    Board.hideItemSelectionOrConfirmationOverlay();
    triggerMoveHistoryPopupReload();
  });
}

export function failedToCreateRematchProposal() {
  return batchGameControlsUpdates(() => {
    isWaitingForRematchResponse = false;
    pendingRematchNavigationToLiveBoard = false;
    boardViewMode = "activeLive";
    publishGameControlsContext();
    nextBoardRenderSession();
    Board.setBoardFlipped(activeBoardShouldBeFlipped());
    applyBoardUiForCurrentView();
    setNewBoard(false);
    setEndMatchVisible(true);
    showPrimaryAction(PrimaryActionType.Rematch);
  });
}

function rematchInLoopMode() {
  return batchGameControlsUpdates(() => {
    isGameOver = false;
    publishGameControlsContext();
    applyGameSeedToCurrentGame(buildRandomGameSeed());
    Board.toggleBoardFlipped();
    playerSideColor =
      playerSideColor === MonsRules.Color.White
        ? MonsRules.Color.Black
        : MonsRules.Color.White;
    Board.resetForNewGame();
    Board.didToggleItemsStyleSet(false);
    Board.showRandomEmojisForLoopMode();
    setNewBoard(false);
    lastBotMoveTimestamp = 0;
    scheduleWatchAutomove();
  });
}

function resetMatchConnectionFlags(waitingForRematch: boolean) {
  isReconnect = false;
  didConnect = false;
  isWaitingForInviteToGetAccepted = false;
  isWaitingForRematchResponse = waitingForRematch;
}

function initializeLocalMatch(mode: "local" | "bot") {
  prepareForNewLocalLiveMatch();
  resetBotScoreReactionState();
  isGameOver = false;
  resetMatchConnectionFlags(false);
  flashbackMode = false;
  resignedColor = undefined;
  winnerByTimerColor = undefined;
  isInviteBotIntoLocalGameUnavailable = mode === "bot";
  didMakeFirstLocalPlayerMoveOnLocalBoard = false;
  didStartLocalGame = true;
  isGameWithBot = mode === "bot";
  remoteMoveSync.resetProgress();
  currentInputs = [];
  matchTimers.reset(null);
  publishGameControlsContext();
  applyGameplayControlsPreset("localMatch");
}

function startFreshLocalMatch() {
  return batchGameControlsUpdates(() => {
    ensureLocalRematchSeriesInitialized();
    const activeLocalMatchIndex =
      rematchViewing
        .getLocalSeriesDescriptor()
        ?.matches.find((match) => match.isActiveMatch)?.index ?? -1;
    const playerStartsAsBlackInThisMatch =
      activeLocalMatchIndex >= 0 && activeLocalMatchIndex % 2 === 1;
    playerSideColor = playerStartsAsBlackInThisMatch
      ? MonsRules.Color.Black
      : MonsRules.Color.White;
    initializeLocalMatch("local");
    showVoiceReactionButton(false);
    setEndMatchVisible(false);
    setEndMatchConfirmed(false);
    showWaitingStateText("");
    Board.setBoardFlipped(activeBoardShouldBeFlipped());
    Board.resetForNewGame();
    applyGameSeedToCurrentGame(
      buildGameSeedForStoredVariant(legacyDefaultGameVariant),
    );
    setNewBoard(false);
    updateUndoButtonBasedOnGameState();
    syncInviteBotIntoLocalGameButton();
    triggerMoveHistoryPopupReload();
  });
}

function startBotMatch(botColor: MonsRules.Color) {
  return batchGameControlsUpdates(() => {
    const nextSeed = buildRandomGameSeed();
    ensureLocalRematchSeriesInitialized();
    initializeLocalMatch("bot");
    Board.setBoardFlipped(botColor === MonsRules.Color.White);
    Board.showOpponentAsBotPlayer();
    Board.resetForNewGame();
    applyGameSeedToCurrentGame(nextSeed);
    setNewBoard(false);
    botPlayerColor = botColor;
    playerSideColor =
      botColor === MonsRules.Color.White
        ? MonsRules.Color.Black
        : MonsRules.Color.White;
    showVoiceReactionButton(true);
    lastBotMoveTimestamp = 0;
    updateUndoButtonBasedOnGameState();
    syncInviteBotIntoLocalGameButton();
    if (game.activeColor === botPlayerColor) {
      automove();
    }
  });
}

export function didJustCreateRematchProposalSuccessfully(
  inviteId: string,
  nextMatch: Match,
  previousMatchId: string | null,
  previousMatchPair: HistoricalMatchPair | null,
) {
  return batchGameControlsUpdates(() => {
    if (boardViewMode !== "historicalView") {
      rematchViewing.clearSelection();
    }
    const hasCompleteHistoricalPair = !!(
      previousMatchPair?.hostMatch && previousMatchPair?.guestMatch
    );
    if (previousMatchId && previousMatchPair && hasCompleteHistoricalPair) {
      rematchViewing.seedProvisional(previousMatchPair);
    }
    if (previousMatchId) {
      rematchViewing.setScore(previousMatchId, {
        white: game.scores[MonsRules.Color.White],
        black: game.scores[MonsRules.Color.Black],
      });
    }
    resetBotScoreReactionState();
    setEndMatchVisible(true);
    showWaitingStateText("");

    isGameOver = false;
    publishGameControlsContext();
    resetMatchConnectionFlags(true);
    remoteMoveSync.resetProgress();
    playerSideColor =
      nextMatch.color === "black"
        ? MonsRules.Color.Black
        : MonsRules.Color.White;
    if (!loadCurrentGameFromFen(nextMatch.fen)) {
      applyGameSeedToCurrentGame(
        buildGameSeedForStoredVariant(nextMatch.gameVariant),
      );
    }

    resignedColor = undefined;
    winnerByTimerColor = undefined;

    lastReactionTime = 0;
    currentInputs = [];
    matchTimers.reset(null);

    if (boardViewMode !== "historicalView") {
      enterWaitingLiveView();
    }
    connection.signInIfNeededAndConnectToGame(inviteId, true);
    triggerMoveHistoryPopupReload();
  });
}

export function didDiscoverExistingRematchProposalWaitingForResponse() {
  return batchGameControlsUpdates(() => {
    isWaitingForRematchResponse = true;
    if (boardViewMode !== "historicalView") {
      enterWaitingLiveView();
      markMainGameWaiting();
    }
    triggerMoveHistoryPopupReload();
  });
}

export function didFindYourOwnInviteThatNobodyJoined(isAutomatch: boolean) {
  Board.setupPlayerId("", true);
  if (!isAutomatch) {
    setInviteLinkActionVisible(true);
    setIsReadyToCopyExistingInviteLink();
    Board.runMonsBoardAsDisplayWaitingAnimation();
  } else if (!isCreateInviteRoute()) {
    setAutomatchWaitingState(true);
    Board.runMonsBoardAsDisplayWaitingAnimation();
  }
  markMainGameWaiting();
}

export function didClickStartBotGameButton() {
  dismissNotificationBannerIfNeeded();
  startBotMatch(MonsRules.Color.White);
}

export function didClickInviteBotIntoLocalGameButton() {
  return batchGameControlsUpdates(() => {
    if (
      isOnlineGame ||
      isWatchOnly ||
      isGameWithBot ||
      puzzleMode ||
      isGameOver ||
      !didStartLocalGame ||
      isInviteBotIntoLocalGameUnavailable ||
      !isCreateInviteRoute() ||
      !didMakeFirstLocalPlayerMoveOnLocalBoard ||
      !isFirstLocalRematchSeriesMatchActive() ||
      game.turnNumber > 2
    ) {
      return;
    }
    const shouldSendInviteYoReaction =
      game.activeColor === MonsRules.Color.White && game.turnNumber === 1;
    resetBotScoreReactionState();
    isInviteBotIntoLocalGameUnavailable = true;
    isGameWithBot = true;
    publishGameControlsContext();
    botPlayerColor = MonsRules.Color.Black;
    playerSideColor = MonsRules.Color.White;
    const boardWasFlippedBeforeTransition = Board.isFlipped;
    const didClearMoveHistoryFlipOverride =
      clearMoveHistoryFlipOverrideForCurrentSession();
    Board.setBoardFlipped(activeBoardShouldBeFlipped());
    Board.showOpponentAsBotPlayer();
    if (Board.isFlipped !== boardWasFlippedBeforeTransition) {
      setNewBoard(false);
    }
    if (didClearMoveHistoryFlipOverride) {
      triggerMoveHistoryPopupReload();
    }
    showResignButton();
    showVoiceReactionButton(true);
    setAutomoveActionVisible(true);
    setAutomoveActionEnabled(isPlayerSideTurn());
    updateUndoButtonBasedOnGameState();
    syncInviteBotIntoLocalGameButton();
    if (shouldSendInviteYoReaction) {
      const inviteReactionGuard = getSessionGuard();
      setManagedGameTimeout(
        () => {
          if (!isGameWithBot || isGameOver) {
            return;
          }
          const reaction = newReactionOfKind("yo");
          playReaction(reaction);
          Board.showVoiceReactionText("yo", true);
        },
        500,
        inviteReactionGuard,
      );
    }
    lastBotMoveTimestamp = 0;
    if (game.activeColor === botPlayerColor) {
      automove();
    }
  });
}

export function didClickBotStrengthControlButton() {
  botAutomoveMode = getNextBotAutomoveMode(botAutomoveMode);
  storage.setBotAutomoveMode(botAutomoveMode);
  syncBotStrengthControlButton();
}

export function handleFreshlySignedInProfileInGameIfNeeded() {
  void connection.seeIfFreshlySignedInProfileIsOneOfThePlayers();
}

export function didFindInviteThatCanBeJoined() {
  showPrimaryAction(PrimaryActionType.JoinGame);
  Board.runMonsBoardAsDisplayWaitingAnimation();
  markMainGameWaiting();
}

export function didClickAutomatchButton(
  onAutomatchResponse?: (response: AutomatchResponse) => void,
) {
  batchGameControlsUpdates(() => {
    applyGameplayControlsPreset("automatchRequest");
    dismissNotificationBannerIfNeeded();
    setNavigationListButtonVisible(false);
    Board.hideBoardPlayersInfo();
    Board.removeHighlights();
    Board.hideAllMoveStatuses();
    isWaitingForInviteToGetAccepted = true;
    pendingAutomatchTransition = true;
    Board.runMonsBoardAsDisplayWaitingAnimation();
  });
  const sessionGuard = getSessionGuard();

  connection
    .automatch()
    .then((response) => {
      return batchGameControlsUpdates(() => {
        if (!sessionGuard() || !pendingAutomatchTransition) {
          return;
        }
        onAutomatchResponse?.(response);
        const automatchInviteId = response.ok ? response.inviteId : null;
        if (automatchInviteId) {
          connection.connectToAutomatch(automatchInviteId);
        } else {
          pendingAutomatchTransition = false;
        }
      });
    })
    .catch(() => {
      return batchGameControlsUpdates(() => {
        if (!sessionGuard() || !pendingAutomatchTransition) {
          return;
        }
        pendingAutomatchTransition = false;
        setAutomatchEnabled(true);
      });
    });
}

export function dismissPendingAutomatchTransition() {
  return batchGameControlsUpdates(() => {
    if (!pendingAutomatchTransition) {
      return;
    }
    pendingAutomatchTransition = false;
    isWaitingForInviteToGetAccepted = false;
    setAutomatchWaitingState(false);
    setAutomatchEnabled(true);
  });
}

function showRematchInterface() {
  if (connection.isCurrentInviteEventOwned()) {
    didReceiveRematchesSeriesEndIndicator();
    return;
  }
  if (isWatchOnly) {
    return;
  }
  if (connection.rematchSeriesEndIsIndicated()) {
    didReceiveRematchesSeriesEndIndicator();
  } else {
    showPrimaryAction(PrimaryActionType.Rematch);
    if (isOnlineGame) {
      setEndMatchVisible(true);
    }
  }
}

export function showItemsAfterChangingAssetsStyle() {
  game.contentPositions().forEach((position) => {
    const location = new Location(position.row, position.column);
    updateLocation(location, flashbackMode);
  });

  const inputsToReapply = currentInputs;
  currentInputs = [];
  for (const input of inputsToReapply) {
    didClickSquare(input);
  }
}

function navigateFromWaitingLiveToLastCompletedMatch() {
  boardViewMode = "activeLive";
  publishGameControlsContext();
  const renderSessionId = nextBoardRenderSession();
  Board.setBoardFlipped(activeBoardShouldBeFlipped());
  const descriptor = getActiveRematchSeriesDescriptor();
  const completedMatches =
    descriptor?.matches.filter(
      (m: RematchSeriesMatchDescriptor) => !m.isPendingResponse,
    ) ?? [];
  const lastMatch =
    completedMatches.length > 0
      ? completedMatches[completedMatches.length - 1]
      : null;
  let didNavigate = false;
  if (lastMatch) {
    const selection = rematchViewing.getCachedSelection(lastMatch.matchId);
    if (selection) {
      const request = rematchViewing.beginSelection(() =>
        isBoardRenderSessionActive(renderSessionId),
      );
      didNavigate = enterHistoricalView(selection, request);
    }
  }
  if (!didNavigate) {
    applyBoardUiForCurrentView();
  }
}

function tryRestoreLiveViewAfterRematchAcceptance() {
  if (!isOnlineGame || isWatchOnly) {
    return;
  }
  if (!isWaitingForRematchResponse && !pendingRematchNavigationToLiveBoard) {
    return;
  }
  const descriptor = getActiveRematchSeriesDescriptor();
  const activeMatchId = descriptor?.activeMatchId ?? null;
  if (!descriptor || !activeMatchId) {
    return;
  }
  const activeMatch = descriptor.matches.find(
    (item) => item.matchId === activeMatchId,
  );
  if (!activeMatch || activeMatch.isPendingResponse) {
    return;
  }
  isWaitingForRematchResponse = false;
  pendingRematchNavigationToLiveBoard = false;
  if (boardViewMode === "historicalView") {
    void didSelectRematchSeriesMatch(activeMatchId);
  } else if (boardViewMode === "waitingLive") {
    restoreLiveBoardView();
  }
  setEndMatchVisible(false);
}

export function didReceiveRematchesSeriesEndIndicator() {
  return batchGameControlsUpdates(() => {
    publishGameControlsContext();
    if (isWatchOnly) {
      setEndMatchVisible(true);
      setEndMatchConfirmed(true);
      return;
    }
    const wasWaitingForRematch =
      isWaitingForRematchResponse && boardViewMode !== "historicalView";
    isWaitingForRematchResponse = false;
    pendingRematchNavigationToLiveBoard = false;
    showPrimaryAction(PrimaryActionType.None);
    setEndMatchVisible(true);
    setEndMatchConfirmed(true);
    if (wasWaitingForRematch) {
      navigateFromWaitingLiveToLastCompletedMatch();
    } else {
      applyBoardUiForCurrentView();
    }
    triggerMoveHistoryPopupReload();
  });
}

export function didUpdateRematchSeriesMetadata() {
  return batchGameControlsUpdates(() => {
    publishGameControlsContext();
    if (isWatchOnly) {
      const didNavigate =
        connection.tryNavigateWatchOnlyToLatestApprovedMatch();
      if (didNavigate) {
        didConnect = false;
        isGameOver = false;
        publishGameControlsContext();
        remoteMoveSync.resetProgress();
        resignedColor = undefined;
        winnerByTimerColor = undefined;
        currentInputs = [];
        restoreLiveBoardView();
      }
      triggerMoveHistoryPopupReload();
      return;
    }
    tryRestoreLiveViewAfterRematchAcceptance();
    triggerMoveHistoryPopupReload();
  });
}

type ResolvedAutomoveOutput =
  | WorkerAutomoveResult
  | {
      kind: "worker-retry";
      retryInMs: number;
    };

const resolveAutomoveFromMainThread = async (
  gameModel: MonsRules.Game,
  preference: AutomovePreference,
): Promise<ResolvedAutomoveOutput> => {
  const suggestion = gameModel.suggestMove(preference);
  if (suggestion) {
    return {
      kind: "events",
      inputFen: suggestion.inputFen,
    };
  }
  return { kind: "other" };
};

const resolveAutomoveOutput = async (
  gameModel: MonsRules.Game,
  fen: string,
  preference: AutomovePreference,
  workerFailurePolicy: AutomoveWorkerFailurePolicy,
): Promise<ResolvedAutomoveOutput> => {
  if (automoveInFlightGames.has(gameModel)) {
    debugAutomove("ignoring concurrent automove request", {
      preference,
      fenLength: fen.length,
    });
    throw new Error(automoveAlreadyInProgressErrorMessage);
  }
  automoveInFlightGames.add(gameModel);
  try {
    const now = Date.now();
    if (
      workerFailurePolicy === "pause-and-retry" ||
      now >= offMainThreadAutomoveDisabledUntilMs
    ) {
      const workerStartedAtMs = Date.now();
      debugAutomove("requesting worker automove", {
        preference,
        fenLength: fen.length,
      });
      try {
        const result = await requestSmartAutomoveFromWorker(fen, preference);
        offMainThreadAutomoveDisabledUntilMs = 0;
        if (workerFailurePolicy === "pause-and-retry") {
          consecutiveWatchAutomoveWorkerFailures = 0;
        }
        debugAutomove("worker automove resolved", {
          preference,
          resultKind: result.kind,
          durationMs: Date.now() - workerStartedAtMs,
        });
        return result;
      } catch (error) {
        if (workerFailurePolicy === "pause-and-retry") {
          const retryInMs = getWatchAutomoveWorkerRetryDelayMs(
            consecutiveWatchAutomoveWorkerFailures,
          );
          consecutiveWatchAutomoveWorkerFailures += 1;
          debugAutomove("worker automove failed", {
            preference,
            retryDelayMs: retryInMs,
            workerFailurePolicy,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
          console.warn(
            "[automove] worker path failed; pausing before restarting the worker",
            error,
          );
          return {
            kind: "worker-retry",
            retryInMs,
          };
        }
        offMainThreadAutomoveDisabledUntilMs =
          Date.now() + offMainThreadAutomoveRetryDelayMs;
        debugAutomove("worker automove failed", {
          preference,
          retryDelayMs: offMainThreadAutomoveRetryDelayMs,
          disabledUntilMs: offMainThreadAutomoveDisabledUntilMs,
          workerFailurePolicy,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        console.warn(
          "[automove] worker path failed, falling back to main-thread automove temporarily",
          error,
        );
      }
    } else {
      debugAutomove("worker automove temporarily disabled; using fallback", {
        preference,
        retryInMs: Math.max(0, offMainThreadAutomoveDisabledUntilMs - now),
      });
    }
    const fallbackStartedAtMs = Date.now();
    debugAutomove("requesting main-thread automove", {
      preference,
    });
    const fallbackResult = await resolveAutomoveFromMainThread(
      gameModel,
      preference,
    );
    debugAutomove("main-thread automove resolved", {
      preference,
      resultKind: fallbackResult.kind,
      durationMs: Date.now() - fallbackStartedAtMs,
    });
    return fallbackResult;
  } finally {
    automoveInFlightGames.delete(gameModel);
  }
};

function automove(onAutomoveButtonClick: boolean = false) {
  if (isReconnect && !didConnect) {
    return;
  }
  const sessionGuard = getSessionGuard();
  const shouldUseSelectedBotMode =
    isBotsRoute() || (isGameWithBot && game.activeColor === botPlayerColor);
  const preference: AutomovePreference = onAutomoveButtonClick
    ? "fast"
    : shouldUseSelectedBotMode
      ? botAutomoveMode
      : "normal";
  const expectedMatchId = getExpectedOnlineMatchIdOrReconnect();
  if (isOnlineGame && !expectedMatchId) {
    return;
  }
  const shouldEnforceBotMovePacing =
    isBotsRoute() || (isGameWithBot && game.activeColor === botPlayerColor);
  const gameBeforeAutomove = game;
  const fenBeforeAutomove = gameBeforeAutomove.toFen();
  const workerFailurePolicy = getAutomoveWorkerFailurePolicy(isBotsRoute());
  const takebacksBeforeAutomove = gameBeforeAutomove.takebackFens;
  const inputColorBeforeAutomove = gameBeforeAutomove.activeColor;
  const syncAutomoveActionState = () => {
    if (isBotsRoute()) {
      return;
    }
    if (!isGameWithBot || isPlayerSideTurn()) {
      setAutomoveActionEnabled(true);
    } else {
      setAutomoveActionEnabled(false);
    }
  };
  resolveAutomoveOutput(
    gameBeforeAutomove,
    fenBeforeAutomove,
    preference,
    workerFailurePolicy,
  )
    .then((output: ResolvedAutomoveOutput) => {
      let showedEndTurnConfirmation = false;
      if (!sessionGuard()) {
        return;
      }
      if (output.kind === "worker-retry") {
        syncAutomoveActionState();
        setManagedGameTimeout(
          () => {
            if (
              isGameOver ||
              !isBotsRoute() ||
              game !== gameBeforeAutomove ||
              game.toFen() !== fenBeforeAutomove
            ) {
              return;
            }
            automove();
          },
          output.retryInMs,
          sessionGuard,
        );
        return;
      }
      if (output.kind === "events") {
        const applyOutputWhenReady = () => {
          if (!sessionGuard()) {
            return;
          }
          if (isReconnect && !didConnect) {
            syncAutomoveActionState();
            return;
          }
          if (!isGameOver && game.toFen() === fenBeforeAutomove) {
            if (handleStaleOnlineLocalOutput(expectedMatchId)) {
              syncAutomoveActionState();
              return;
            }
            if (shouldEnforceBotMovePacing) {
              lastBotMoveTimestamp = Date.now();
            }
            const appliedOutput = game.playFen(output.inputFen);
            const takebacksBeforeMove = onAutomoveButtonClick
              ? takebacksBeforeAutomove
              : [];
            const fenBeforeMove = onAutomoveButtonClick
              ? fenBeforeAutomove
              : "";
            const forceTurnConfirmation =
              onAutomoveButtonClick &&
              appliedOutput.kind === "complete" &&
              shouldConfirmAutomoveManaEndTurn(appliedOutput.events);
            showedEndTurnConfirmation = applyOutput(
              takebacksBeforeMove,
              fenBeforeMove,
              appliedOutput,
              false,
              true,
              AssistedInputKind.None,
              undefined,
              inputColorBeforeAutomove,
              expectedMatchId,
              forceTurnConfirmation,
            );
          }
          syncAutomoveActionState();
        };
        const delayBeforeApplyMs = shouldEnforceBotMovePacing
          ? Math.max(
              0,
              lastBotMoveTimestamp +
                minimumIntervalBetweenBotMovesMs -
                Date.now(),
            )
          : 0;
        if (delayBeforeApplyMs > 0) {
          setManagedGameTimeout(
            applyOutputWhenReady,
            delayBeforeApplyMs,
            sessionGuard,
          );
        } else {
          applyOutputWhenReady();
        }
      } else {
        syncAutomoveActionState();
      }

      if (!showedEndTurnConfirmation) {
        Board.hideItemSelectionOrConfirmationOverlay();
      }
    })
    .catch((e: unknown) => {
      if (String(e).includes(automoveAlreadyInProgressErrorMessage)) {
        return;
      }
      throw e;
    });
}

function scheduleWatchAutomove() {
  const watchAutomoveGuard = getSessionGuard();
  setManagedGameTimeout(
    () => {
      if (isGameOver || !isBotsRoute()) {
        return;
      }
      automove();
    },
    botTurnComputationDelayMs,
    watchAutomoveGuard,
  );
}

function didConfirmRematchProposal() {
  return batchGameControlsUpdates(() => {
    if (isReconnect && !didConnect) {
      return;
    }
    if (puzzleMode) {
      const nextProblem = getNextProblem(selectedProblem!.id);
      if (nextProblem) {
        showNextProblem(nextProblem);
        return;
      }
    }

    if (isGameWithBot) {
      advanceLocalRematchSeriesToNextMatch();
      const nextBotColor =
        botPlayerColor === MonsRules.Color.White
          ? MonsRules.Color.Black
          : MonsRules.Color.White;
      startBotMatch(nextBotColor);
      return;
    }

    if (!isOnlineGame) {
      if (canTrackLocalRematchSeries()) {
        advanceLocalRematchSeriesToNextMatch();
        startFreshLocalMatch();
        return;
      }
      void transitionToHome({ forceMatchScopeReset: true });
      return;
    }

    if (boardViewMode === "historicalView") {
      isWaitingForRematchResponse = true;
      enterWaitingLiveView();
    }

    setEndMatchVisible(false);
    Board.runMonsBoardAsDisplayWaitingAnimation();
    connection.sendRematchProposal();
    Board.hideBoardPlayersInfo();
  });
}

export function didClickEndMatchButton(): boolean {
  return batchGameControlsUpdates(() => {
    if (isReconnect && !didConnect) {
      return false;
    }
    if (!connection.sendEndMatchIndicator()) {
      return false;
    }
    const wasWaitingForRematch =
      isWaitingForRematchResponse && boardViewMode !== "historicalView";
    showPrimaryAction(PrimaryActionType.None);
    setEndMatchConfirmed(true);
    showWaitingStateText("");
    Board.stopMonsBoardAsDisplayAnimations();
    isWaitingForRematchResponse = false;
    pendingRematchNavigationToLiveBoard = false;
    if (wasWaitingForRematch) {
      navigateFromWaitingLiveToLastCompletedMatch();
    }
    triggerMoveHistoryPopupReload();
    return true;
  });
}

export function didClickPrimaryActionButton(action: PrimaryAction) {
  switch (action) {
    case PrimaryActionType.JoinGame:
      connection.setupConnection(true);
      break;
    case PrimaryActionType.Rematch:
      didConfirmRematchProposal();
      break;
    default:
      break;
  }
}

export function didClickClaimVictoryByTimerButton() {
  if (!canHandleLiveBoardInput()) {
    return;
  }
  if (isOnlineGame && !isWatchOnly) {
    const sessionGuard = getSessionGuard();
    connection
      .claimVictoryByTimer()
      .then((res) => {
        if (!sessionGuard()) {
          return;
        }
        if (res.ok) {
          handleVictoryByTimer(
            false,
            playerSideColor === MonsRules.Color.White ? "white" : "black",
            true,
          );
        }
      })
      .catch(() => {});
  }
}

export function didClickHomeButton() {
  dismissPendingAutomatchTransition();
  void transitionToHome({ forceMatchScopeReset: true });
}

export function didClickStartTimerButton() {
  if (!canHandleLiveBoardInput()) {
    return;
  }
  if (isOnlineGame && !isWatchOnly && !isPlayerSideTurn()) {
    const requestedMatchId = matchTimers.getMatchId();
    if (!requestedMatchId) {
      return;
    }
    const requestedTurnNumber = game.turnNumber;
    const sessionGuard = getSessionGuard();
    connection
      .startTimer()
      .then((res) => {
        if (!sessionGuard()) {
          return;
        }
        if (res.ok) {
          const activeMatchId = connection.getActiveMatchId();
          if (activeMatchId && activeMatchId !== requestedMatchId) {
            return;
          }
          if (
            !activeMatchId &&
            !connection.matchBelongsToCurrentInvite(requestedMatchId)
          ) {
            return;
          }
          if (
            game.turnNumber !== requestedTurnNumber ||
            isPlayerSideTurn() ||
            isGameOver
          ) {
            return;
          }
          const timerColor =
            playerSideColor === MonsRules.Color.White ? "white" : "black";
          matchTimers.setStash(requestedMatchId, timerColor, res.timer);
          if (boardViewMode === "activeLive") {
            matchTimers.showCountdown(
              false,
              res.timer,
              timerColor,
              res.duration,
            );
          }
        }
      })
      .catch(() => {});
  }
}

export function didClickConfirmResignButton() {
  if (!canHandleLiveBoardInput()) {
    return;
  }
  if (!isOnlineGame) {
    if (isGameWithBot) {
      handleResignStatus(false, "");
      return;
    }
    const activeColor = game.activeColor;
    let activeColorString = "";
    if (activeColor === MonsRules.Color.White) {
      activeColorString = "white";
    } else if (activeColor === MonsRules.Color.Black) {
      activeColorString = "black";
    }
    handleResignStatus(false, activeColorString);
    return;
  }
  const didQueueSurrender = connection.surrender();
  if (!didQueueSurrender) {
    return;
  }
  handleResignStatus(false, "");
}

export function canHandleUndo(): boolean {
  if (!canHandleLiveBoardInput() || isWatchOnly || isGameOver) {
    return false;
  } else if (isOnlineGame || isGameWithBot) {
    return game.canTakeback(playerSideColor);
  } else {
    return game.canTakeback(game.activeColor);
  }
}

export function didClickUndoButton() {
  if (!canHandleLiveBoardInput()) {
    return;
  }
  if (canHandleUndo()) {
    const expectedMatchId = getExpectedOnlineMatchIdOrReconnect();
    if (isOnlineGame && !expectedMatchId) {
      return;
    }
    const output = game.takeback();
    applyOutput(
      [],
      "",
      output,
      false,
      false,
      AssistedInputKind.None,
      undefined,
      undefined,
      expectedMatchId,
    );
  }
}

export function canChangeEmoji(opponents: boolean): boolean {
  if ((storage.getLoginId("") && !opponents) || isBotsRoute()) {
    return false;
  }
  if (isOnlineGame || isGameWithBot) {
    return opponents ? false : !isWatchOnly;
  } else {
    return true;
  }
}

export function sendPlayerEmojiUpdate(newId: number, aura?: Aura) {
  const auraToSend = aura ?? storage.getPlayerEmojiAura("none");
  connection.updateEmoji(newId, false, auraToSend);
}

function isPlayerSideTurn(): boolean {
  return game.activeColor === playerSideColor;
}

export function didSelectInputModifier(inputModifier: InputModifier) {
  if (
    !canHandleLiveBoardInput() ||
    (isOnlineGame && !didConnect) ||
    isWatchOnly ||
    isGameOver ||
    isWaitingForInviteToGetAccepted
  ) {
    return;
  }
  processInput(AssistedInputKind.None, inputModifier);
}

export function didClickSquare(location: Location) {
  if (puzzleMode) {
    Board.fastForwardInstructionsIfNeeded();
  }
  if (
    !canHandleLiveBoardInput() ||
    (isOnlineGame && !didConnect) ||
    isWatchOnly ||
    isGameOver ||
    isWaitingForInviteToGetAccepted
  ) {
    return;
  }
  processInput(AssistedInputKind.None, InputModifier.None, location);
}

export function didClickOutsideBoard() {
  if (puzzleMode && Board.fastForwardInstructionsIfNeeded()) {
    return;
  }
  if (
    !canHandleLiveBoardInput() ||
    (isOnlineGame && !didConnect) ||
    isWatchOnly ||
    isGameOver ||
    isWaitingForInviteToGetAccepted
  ) {
    return;
  }
  processInput(AssistedInputKind.None, InputModifier.None, undefined, true);
}

function turnShouldBeConfirmedForOutputEvents(
  events: readonly MonsRules.GameEvent[],
  fenBeforeMove: string,
): boolean {
  const wasFirstTurn = game.turnNumber === 2;
  const hasNextTurn = events.some((event) => event.kind === "next-turn");
  const hasGameOver = events.some((event) => event.kind === "game-over");
  const hasManaMove = events.some((event) => event.kind === "mana-move");

  if (wasFirstTurn || hasGameOver || !hasNextTurn || !hasManaMove) {
    return false;
  }

  const gameBeforeMove = MonsRules.Game.fromFen(fenBeforeMove);
  if (!gameBeforeMove) {
    return false;
  }

  const moveCounts = gameBeforeMove.availableMoveCounts();
  const hasMoves = moveCounts.monMoves > 0;
  let actuallyHasPossibleAction = false;
  if (!hasMoves && moveCounts.actions > 0) {
    const output = gameBeforeMove.preview([]);
    if (output.kind === "awaiting-start") {
      for (const position of output.positions) {
        const nextOutput = gameBeforeMove.preview([
          { kind: "position", position },
        ]);
        if (nextOutput.kind === "awaiting-input") {
          if (
            nextOutput.options.some(
              (option) =>
                option.action === "mystic-action" ||
                option.action === "demon-action" ||
                option.action === "spirit-target-capture",
            )
          ) {
            actuallyHasPossibleAction = true;
            break;
          }
        }
      }
    }
  }

  return hasMoves || actuallyHasPossibleAction;
}

function getTurnConfirmationFinishLocation(
  events: readonly MonsRules.GameEvent[],
): Location | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind === "mana-move") {
      return location(event.to);
    }
  }
  return undefined;
}

function getTurnConfirmationStartLocation(
  events: readonly MonsRules.GameEvent[],
): Location | undefined {
  for (const event of events) {
    if (event.kind === "mana-move") {
      return location(event.from);
    }
  }
  return undefined;
}

function applyTurnConfirmationSourceHighlight(
  fenBeforeMove: string,
  events: readonly MonsRules.GameEvent[],
  isBotInput: boolean,
  inputColorBeforeMove?: MonsRules.Color,
  expectedMatchId: string | null = null,
): void {
  const startLocation = getTurnConfirmationStartLocation(events);
  if (!startLocation) {
    return;
  }

  const gameBeforeMove = MonsRules.Game.fromFen(fenBeforeMove);
  if (!gameBeforeMove) {
    return;
  }

  const previewBaseGame = game;
  try {
    const previewOutput = gameBeforeMove.preview([
      { kind: "position", position: position(startLocation) },
    ]);
    if (previewOutput.kind !== "awaiting-input") {
      return;
    }

    game = gameBeforeMove;
    currentInputs = [startLocation];
    applyOutput(
      [],
      "",
      previewOutput,
      false,
      isBotInput,
      AssistedInputKind.None,
      startLocation,
      inputColorBeforeMove,
      expectedMatchId,
      false,
    );
  } finally {
    game = previewBaseGame;
  }
}

function shouldConfirmAutomoveManaEndTurn(
  events: readonly MonsRules.GameEvent[],
): boolean {
  const hasManaMove = events.some((event) => event.kind === "mana-move");
  if (!hasManaMove) {
    return false;
  }

  return events.some(
    (event) => event.kind === "next-turn" || event.kind === "game-over",
  );
}

function applyOutput(
  takebackFensBeforeMove: readonly string[],
  fenBeforeMove: string,
  output: MonsRules.InputResolution,
  isRemoteInput: boolean,
  isBotInput: boolean,
  assistedInputKind: AssistedInputKind,
  inputLocation?: Location,
  inputColorBeforeMove?: MonsRules.Color,
  expectedMatchId: string | null = null,
  forceTurnConfirmation: boolean = false,
): boolean {
  switch (output.kind) {
    case "invalid": {
      const shouldTryToReselect =
        assistedInputKind === AssistedInputKind.None &&
        currentInputs.length > 1 &&
        inputLocation &&
        !currentInputs[0]!.equals(inputLocation);
      const shouldHelpFindOptions =
        assistedInputKind === AssistedInputKind.None &&
        currentInputs.length === 1;
      currentInputs = [];
      Board.removeHighlights();
      if (shouldTryToReselect) {
        processInput(
          AssistedInputKind.ReselectLastInvalidInput,
          InputModifier.None,
          inputLocation,
        );
      } else if (shouldHelpFindOptions) {
        processInput(
          AssistedInputKind.FindStartLocationsAfterInvalidInput,
          InputModifier.None,
        );
      }
      break;
    }
    case "awaiting-start": {
      const startFromHighlights: Highlight[] = output.positions.map(
        (position) =>
          new Highlight(
            location(position),
            HighlightKind.StartFromSuggestion,
            colors.startFromSuggestion,
          ),
      );
      Board.removeHighlights();
      Board.applyHighlights(startFromHighlights);
      break;
    }
    case "awaiting-input": {
      const nextInputs = output.options;

      if (nextInputs[0]?.action === "select-consumable") {
        Board.removeHighlights();
        playSounds([Sound.ChoosePickup]);
        Board.showItemSelection();
        return false;
      }

      const nextInputHighlights = nextInputs.flatMap((input) => {
        if (input.input.kind !== "position") return [];
        const inputLocation = location(input.input.position);
        let color: string;
        let highlightKind: HighlightKind;
        switch (input.action) {
          case "mon-move":
            highlightKind =
              hasItemAt(inputLocation) ||
              Board.hasBasePlaceholder(inputLocation)
                ? HighlightKind.TargetSuggestion
                : HighlightKind.EmptySquare;
            color = colors.destination;
            break;
          case "mana-move":
            highlightKind = hasItemAt(inputLocation)
              ? HighlightKind.TargetSuggestion
              : HighlightKind.EmptySquare;
            color = colors.destination;
            break;
          case "mystic-action":
            highlightKind = HighlightKind.TargetSuggestion;
            color = colors.attackTarget;
            break;
          case "demon-action":
            highlightKind = HighlightKind.TargetSuggestion;
            color = colors.attackTarget;
            break;
          case "demon-additional-step":
            highlightKind = Board.hasBasePlaceholder(inputLocation)
              ? HighlightKind.TargetSuggestion
              : HighlightKind.EmptySquare;
            color = colors.attackTarget;
            break;
          case "spirit-target-capture":
            highlightKind = HighlightKind.TargetSuggestion;
            color = colors.spiritTarget;
            break;
          case "spirit-target-move":
            highlightKind =
              hasItemAt(inputLocation) ||
              Board.hasBasePlaceholder(inputLocation)
                ? HighlightKind.TargetSuggestion
                : HighlightKind.EmptySquare;
            color = colors.spiritTarget;
            break;
          case "bomb-attack":
            highlightKind = HighlightKind.TargetSuggestion;
            color = colors.attackTarget;
            break;
          default:
            return [];
        }
        return new Highlight(inputLocation, highlightKind, color);
      });

      const selectedItemsHighlights = currentInputs.map((input, index) => {
        let color: string;
        if (index > 0) {
          switch (nextInputs[nextInputs.length - 1]?.action) {
            case "demon-additional-step":
              color = colors.attackTarget;
              break;
            case "spirit-target-move":
              color = colors.spiritTarget;
              break;
            default:
              color = colors.selectedItem;
              break;
          }
        } else {
          color = colors.selectedItem;
        }
        return new Highlight(input, HighlightKind.Selected, color);
      });

      Board.removeHighlights();
      Board.applyHighlights([
        ...selectedItemsHighlights,
        ...nextInputHighlights,
      ]);
      break;
    }
    case "complete": {
      if (!isRemoteInput && handleStaleOnlineLocalOutput(expectedMatchId)) {
        return false;
      }
      const moveFen = output.inputFen;
      const gameFen = game.toFen();

      const events = output.events;

      if (
        !isRemoteInput &&
        fenBeforeMove !== "" &&
        (forceTurnConfirmation ||
          turnShouldBeConfirmedForOutputEvents(events, fenBeforeMove))
      ) {
        if (forceTurnConfirmation) {
          applyTurnConfirmationSourceHighlight(
            fenBeforeMove,
            events,
            isBotInput,
            inputColorBeforeMove,
            expectedMatchId,
          );
        }
        const finishLocation =
          getTurnConfirmationFinishLocation(events) ??
          currentInputs[currentInputs.length - 1];
        if (finishLocation) {
          const targetGameToConfirm = game;
          game = game.previousTurn(takebackFensBeforeMove)!;

          playSounds([Sound.ConfirmEarlyEndTurn]);

          Board.showEndTurnConfirmationOverlay(
            game.activeColor === MonsRules.Color.Black,
            finishLocation,
            () => {
              if (!canHandleLiveBoardInput()) {
                return;
              }
              if (handleStaleOnlineLocalOutput(expectedMatchId)) {
                return;
              }
              game = targetGameToConfirm;
              applyOutput(
                [],
                "",
                output,
                isRemoteInput,
                isBotInput,
                assistedInputKind,
                inputLocation,
                inputColorBeforeMove,
                expectedMatchId,
                false,
              );
            },
            () => {
              currentInputs = [];
              Board.removeHighlights();
            },
          );
          return true;
        }
      }

      if (isOnlineGame && !isRemoteInput) {
        if (!expectedMatchId) {
          console.warn(
            "online-move-send-skipped: no expected match id at Events output",
          );
          void getExpectedOnlineMatchIdOrReconnect();
        } else {
          connection.sendMove(moveFen, gameFen, expectedMatchId);
        }
      }

      if (!isOnlineGame && !didStartLocalGame) {
        batchGameControlsUpdates(() => {
          ensureLocalRematchSeriesInitialized();
          dismissNotificationBannerIfNeeded();
          didStartLocalGame = true;
          setHomeVisible(true);
          setIslandButtonDimmed(true);

          setBrushAndNavigationButtonDimmed(true);
          setUndoVisible(true);
          setInviteLinkActionVisible(false);
          setAutomatchVisible(false);
          setBotGameOptionVisible(false);
          if (!puzzleMode) {
            setNavigationListButtonVisible(false);
          }
          setAutomoveActionVisible(true);
          showMoveHistoryButton(true);
          if (!puzzleMode) {
            showResignButton();
          }
        });
      }

      currentInputs = [];

      let locationsToUpdate: Location[] = [];
      let mightKeepHighlightOnLocation: Location | undefined;
      let mustReleaseHighlight = isRemoteInput || isBotInput;
      let sounds: Sound[] = [];
      let traces: Trace[] = [];
      let popOpponentsEmoji = false;

      for (const event of events) {
        const from = "from" in event ? location(event.from) : undefined;
        const to = "to" in event ? location(event.to) : undefined;
        const at = "at" in event ? location(event.at) : undefined;
        switch (event.kind) {
          case "mon-move":
            if (!from || !to) break;
            sounds.push(Sound.Move);
            locationsToUpdate.push(from);
            locationsToUpdate.push(to);
            mightKeepHighlightOnLocation = to;
            traces.push(new Trace(from, to));
            break;
          case "mana-move":
            if (!from || !to) break;
            locationsToUpdate.push(from);
            locationsToUpdate.push(to);
            traces.push(new Trace(from, to));
            break;
          case "mana-scored":
            if (!at) break;
            if (event.mana.kind === "supermana") {
              sounds.push(Sound.ScoreSupermana);
            } else {
              sounds.push(Sound.ScoreMana);
            }
            locationsToUpdate.push(at);
            if (!flashbackMode) {
              Board.indicateWaterSplash(at);
              Board.updateScore(
                game.scores[MonsRules.Color.White],
                game.scores[MonsRules.Color.Black],
                game.winner,
                resignedColor,
                winnerByTimerColor,
              );
              if (isGameWithBot && inputColorBeforeMove !== undefined) {
                const currentTurnNumber = game.turnNumber;
                if (!botScoreReactionPlayedTurns.has(currentTurnNumber)) {
                  const isBotScoring = inputColorBeforeMove === botPlayerColor;
                  const reactionVariations = isBotScoring
                    ? botReactionVariationsWhenBotScores
                    : botReactionVariationsWhenPlayerScores;
                  botScoreReactionPlayedTurns.add(currentTurnNumber);
                  if (Math.random() < botScoreReactionChance) {
                    playSounds([Sound.EmoteReceived]);
                    showVideoReaction(
                      Board.isMetadataSideDisplayedAtOpponentSlot(true),
                      getRandomReactionVariation(reactionVariations),
                    );
                  }
                }
              }
            }
            mustReleaseHighlight = true;
            break;
          case "mystic-action":
            if (!from || !to) break;
            sounds.push(Sound.MysticAbility);
            locationsToUpdate.push(from);
            locationsToUpdate.push(to);
            if (!flashbackMode) {
              Board.indicateElectricHit(to);
            }
            traces.push(new Trace(from, to));
            break;
          case "demon-action":
            if (!from || !to) break;
            sounds.push(Sound.DemonAbility);
            locationsToUpdate.push(from);
            locationsToUpdate.push(to);
            if (!flashbackMode) {
              Board.indicateFlameGround(to);
            }
            traces.push(new Trace(from, to));
            break;
          case "demon-additional-step":
            if (!from || !to) break;
            locationsToUpdate.push(from);
            locationsToUpdate.push(to);
            traces.push(new Trace(from, to));
            break;
          case "spirit-target-move":
            if (!from || !to) break;
            sounds.push(Sound.SpiritAbility);
            locationsToUpdate.push(from);
            locationsToUpdate.push(to);
            if (!flashbackMode) {
              Board.indicateSpiritAction(to);
            }
            traces.push(new Trace(from, to));
            break;
          case "pickup-bomb":
            if (!at) break;
            sounds.push(Sound.PickupBomb);
            locationsToUpdate.push(at);
            mustReleaseHighlight = true;
            break;
          case "use-potion":
            if (from && !flashbackMode) {
              Board.indicatePotionUsage(from);
            }
            break;
          case "pickup-potion":
            if (!at) break;
            sounds.push(Sound.PickupPotion);
            locationsToUpdate.push(at);
            mustReleaseHighlight = true;
            break;
          case "pickup-mana":
            if (!at) break;
            sounds.push(Sound.ManaPickUp);
            locationsToUpdate.push(at);
            break;
          case "mon-fainted":
            if (!from || !to) break;
            locationsToUpdate.push(from);
            locationsToUpdate.push(to);
            break;
          case "mana-dropped":
            if (!at) break;
            locationsToUpdate.push(at);
            break;
          case "supermana-back-to-base":
            if (!from || !to) break;
            locationsToUpdate.push(from);
            locationsToUpdate.push(to);
            break;
          case "bomb-attack":
            if (!from || !to) break;
            sounds.push(Sound.Bomb);
            locationsToUpdate.push(from);
            locationsToUpdate.push(to);
            if (!flashbackMode) {
              Board.indicateBombExplosion(to);
            }
            traces.push(new Trace(from, to));
            break;
          case "mon-awake":
            if (at) {
              locationsToUpdate.push(at);
            }
            break;
          case "bomb-explosion":
            sounds.push(Sound.Bomb);
            if (at && !flashbackMode) {
              Board.indicateBombExplosion(at);
              locationsToUpdate.push(at);
            }
            break;
          case "next-turn":
            if (puzzleMode && game.winner === undefined) {
              resetToTheStartOfThePuzzle();
              Board.flashPuzzleFailure();
              return false;
            }

            sounds.push(Sound.EndTurn);
            if ((!isWatchOnly && isOnlineGame) || isGameWithBot) {
              const playerTurn = isPlayerSideTurn();
              if (playerTurn) {
                popOpponentsEmoji = true;
              }
              if (isOnlineGame) {
                if (playerTurn) {
                  matchTimers.clearCooldown();
                  if (boardViewMode === "activeLive") {
                    hideTimerButtons();
                  }
                  setUndoVisible(true);
                  setAutomoveActionVisible(true);
                  showMoveHistoryButton(true);
                } else {
                  const cooldownMatchId = matchTimers.getMatchId();
                  if (cooldownMatchId) {
                    matchTimers.startCooldown(cooldownMatchId);
                  }
                  if (boardViewMode === "activeLive") {
                    showTimerButtonProgressing(
                      0,
                      MATCH_TIMER_DURATION_SECONDS,
                      true,
                    );
                  }
                }
              }
            }
            Board.hideTimerCountdownDigits();
            break;
          case "takeback":
            setNewBoard(false);
            playSounds([Sound.Undo]);
            Board.removeHighlights();
            Board.hideItemSelectionOrConfirmationOverlay();
            updateUndoButtonBasedOnGameState();
            syncInviteBotIntoLocalGameButton();
            triggerMoveHistoryPopupReload();
            return false;
          case "game-over": {
            const isVictory = !isOnlineGame || event.winner === playerSideColor;

            if (isVictory) {
              sounds.push(Sound.Victory);
            } else {
              sounds.push(Sound.Defeat);
            }

            if (!isWatchOnly) {
              updateRatings(isVictory);
            }

            matchTimers.clearCooldown();
            isGameOver = true;
            publishGameControlsContext();
            wagerOutcomeAnimationAllowed = !isWatchOnly;
            disableAndHideUndoResignAndTimerControls();
            Board.hideTimerCountdownDigits();
            showRematchInterface();
            syncWagerOutcome();

            if (puzzleMode) {
              Board.flashPuzzleSuccess();
              setPlaySamePuzzleAgainButtonVisible(true);

              if (selectedProblem) {
                markProblemCompleted(selectedProblem.id);
              }
            }

            if (didStartLocalGame) {
              setAutomoveActionVisible(false);
            }

            break;
          }
        }
      }

      if (
        !isRemoteInput &&
        !isOnlineGame &&
        !isGameWithBot &&
        isCreateInviteRoute() &&
        inputColorBeforeMove === MonsRules.Color.White &&
        game.turnNumber <= 2
      ) {
        didMakeFirstLocalPlayerMoveOnLocalBoard = true;
      }

      if (
        !isRemoteInput &&
        !isOnlineGame &&
        !isGameWithBot &&
        isCreateInviteRoute() &&
        inputColorBeforeMove === MonsRules.Color.Black &&
        game.turnNumber > 2
      ) {
        isInviteBotIntoLocalGameUnavailable = true;
      }

      Board.removeHighlights();

      if (flashbackMode && isMoveHistoryPopupFollowingLatest()) {
        flashbackMode = false;
      }

      const didUpdate = new Set<string>();
      for (const location of locationsToUpdate) {
        const key = location.toString();
        if (!didUpdate.has(key)) {
          didUpdate.add(key);
          updateLocation(location);
        }
      }

      if (!flashbackMode) {
        updateBoardMoveStatuses();
      }

      if (!flashbackMode && (isRemoteInput || isBotInput)) {
        for (const trace of traces) {
          Board.drawTrace(trace);
        }
      }

      playSounds(sounds);

      if (!flashbackMode && popOpponentsEmoji) {
        Board.popOpponentsEmoji();
      }

      if (mightKeepHighlightOnLocation !== undefined && !mustReleaseHighlight) {
        processInput(
          AssistedInputKind.KeepSelectionAfterMove,
          InputModifier.None,
          mightKeepHighlightOnLocation,
        );
      }

      if (!isGameOver) {
        if (isGameWithBot && game.activeColor === botPlayerColor) {
          const botTurnGuard = getSessionGuard();
          setManagedGameTimeout(
            () => {
              if (
                isGameOver ||
                !isGameWithBot ||
                game.activeColor !== botPlayerColor
              ) {
                return;
              }
              automove();
            },
            botTurnComputationDelayMs,
            botTurnGuard,
          );
        } else if (isBotsRoute()) {
          scheduleWatchAutomove();
        }
      }

      if (isGameWithBot && !isPlayerSideTurn()) {
        setAutomoveActionEnabled(false);
      }

      if (isBotsRoute() && isGameOver) {
        const rematchGuard = getSessionGuard();
        setManagedGameTimeout(() => rematchInLoopMode(), 1150, rematchGuard);
      }

      updateUndoButtonBasedOnGameState();
      syncInviteBotIntoLocalGameButton();

      triggerMoveHistoryPopupReload();

      break;
    }
  }

  return false;
}

export function playSameCompletedPuzzleAgain() {
  if (selectedProblem) {
    didSelectPuzzle(selectedProblem, true);
  }
}

function resetToTheStartOfThePuzzle() {
  return batchGameControlsUpdates(() => {
    if (!loadCurrentGameFromFen(selectedProblem!.fen)) {
      return;
    }
    setNewBoard(false);
    playSounds([Sound.Undo]);
    Board.removeHighlights();
    Board.hideItemSelectionOrConfirmationOverlay();
    updateUndoButtonBasedOnGameState();
  });
}

export function didClickAutomoveButton() {
  if (!canHandleLiveBoardInput()) return;
  if (isGameOver) return;
  automove(true);
}

function hasBothEthOrSolAddresses(): boolean {
  const playerSide =
    Board.playerSideMetadata.ethAddress ?? Board.playerSideMetadata.solAddress;
  const opponentSide =
    Board.opponentSideMetadata.ethAddress ??
    Board.opponentSideMetadata.solAddress;
  return (
    playerSide !== undefined &&
    opponentSide !== undefined &&
    playerSide !== opponentSide
  );
}

function bindVerifiedGameToMatch(matchId: string): void {
  remoteMoveSync.bindVerifiedGame(matchId);
  showVerifiedMoveHistory();
}

function showVerifiedMoveHistory(): void {
  showMoveHistoryButton(true);
  if (isMoveHistoryPopupOpen && boardViewMode !== "historicalView") {
    triggerMoveHistoryPopupReload();
  }
}

function verifyMovesIfNeeded(
  matchId: string,
  flatMovesString: unknown,
  color: string,
) {
  if (remoteMoveSync.verifyHistory(game, matchId, flatMovesString, color)) {
    showVerifiedMoveHistory();
  }
}

function updateRatings(isWin: boolean) {
  if (!isOnlineGame) {
    return;
  }

  connection.resolveWagerOutcome(isWin);

  if (!connection.isAutomatch()) {
    return;
  }

  connection.updateRatings();

  const isEventGame =
    connection.isCurrentInviteEventOwned() ||
    !!connection.getCurrentInviteEventId();
  if (isEventGame) {
    return;
  }

  if (!hasBothEthOrSolAddresses()) {
    return;
  }

  const playerSide = Board.playerSideMetadata.uid;
  const opponentSide = Board.opponentSideMetadata.uid;
  const victoryUid = isWin ? playerSide : opponentSide;
  const defeatUid = isWin ? opponentSide : playerSide;

  if (victoryUid && defeatUid) {
    recalculateRatingsLocallyForUids(victoryUid, defeatUid);
    Board.recalculateDisplayNames();
  }
}

let initialWagersMatchId: string | null = null;

export function didReceiveInitialWagers() {
  initialWagersMatchId = connection.getActiveMatchId();
  markKnownWagerInitialStateReceived();
}

function markKnownWagerInitialStateReceived() {
  if (wagerMatchId !== null && initialWagersMatchId === wagerMatchId) {
    Board.markWagerInitialStateReceived();
  }
}

function resetWagerStateForMatch(matchId: string | null) {
  if (wagerMatchId === matchId) {
    return;
  }
  wagerMatchId = matchId;
  wagerOutcomeShown = false;
  wagerOutcomeAnimating = false;
  wagerOutcomeAnimationAllowed = false;
  if (wagerOutcomeAnimTimer !== null) {
    clearManagedGameTimeout(wagerOutcomeAnimTimer);
    wagerOutcomeAnimTimer = null;
  }
  setCurrentWagerMatch(matchId);
  currentWagerState = getWagerState();
  Board.clearWagerPilesForNewMatch();
}

let cancelRematchScoresPreload: (() => void) | null = null;

function preloadRematchScoresAfterGameLoaded() {
  cancelRematchScoresPreload?.();
  const sessionGuard = getSessionGuard();
  cancelRematchScoresPreload = onMainGameLoaded(() => {
    if (sessionGuard()) void preloadRematchSeriesScores();
  });
}

function normalizeWagerStakeCount(
  countValue: unknown,
  totalValue: unknown,
): number {
  const count = Math.round(Number(countValue));
  if (Number.isFinite(count) && count > 0) {
    return count;
  }
  const total = Math.round(Number(totalValue));
  if (Number.isFinite(total) && total > 0) {
    return Math.max(0, Math.round(total / 2));
  }
  return 0;
}

function isWagerOutcomeAnimationBlocking() {
  if (!wagerOutcomeAnimating) {
    return false;
  }
  if (
    wagerOutcomeAnimTimer !== null ||
    Board.isWagerWinAnimationPendingOrActive()
  ) {
    return true;
  }
  wagerOutcomeAnimating = false;
  return false;
}

function shouldDeferWagerStateForUninstalledMatch(): boolean {
  const activeMatchId = connection.getActiveMatchId();
  return (
    boardViewMode === "activeLive" &&
    activeMatchId !== null &&
    wagerMatchId !== activeMatchId
  );
}

function applyWagerState() {
  logWagerDebug("apply:start", {
    state: summarizeWagerState(currentWagerState),
  });
  if (isMoveHistoryPopupOpen && flashbackMode) {
    logWagerDebug("apply:skip-move-navigation-active");
    return;
  }
  if (boardViewMode === "waitingLive") {
    logWagerDebug("apply:clear-waiting-live");
    Board.clearWagerPilesForNewMatch();
    return;
  }
  if (boardViewMode !== "activeLive" && boardViewMode !== "historicalView") {
    logWagerDebug("apply:clear-non-live-view");
    Board.clearWagerPilesForNewMatch();
    return;
  }
  if (shouldDeferWagerStateForUninstalledMatch()) {
    logWagerDebug("apply:skip-match-not-installed");
    return;
  }
  const isHistoricalView = boardViewMode === "historicalView";
  if (!currentWagerState) {
    logWagerDebug("apply:clear-no-state");
    Board.clearWagerPiles();
    return;
  }

  if (currentWagerState.blocked) {
    Board.clearWagerPiles();
    return;
  }
  if (currentWagerState.resolved) {
    if (isGameOver || isReconnect || isWatchOnly || isHistoricalView) {
      const outcomeState = syncWagerOutcome();
      logWagerDebug("apply:resolved-branch", { outcomeState });
      if (outcomeState === "shown" || outcomeState === "deferred") {
        return;
      }
    } else {
      logWagerDebug("apply:resolved-skipped-not-eligible");
      return;
    }
  }

  if (currentWagerState.agreed && currentWagerState.agreed.material) {
    const stakeCount = normalizeWagerStakeCount(
      currentWagerState.agreed.count,
      currentWagerState.agreed.total,
    );
    if (stakeCount > 0) {
      logWagerDebug("apply:show-agreed", {
        material: currentWagerState.agreed.material,
        stakeCount,
      });
      Board.setWagerPiles({
        player: {
          material: currentWagerState.agreed.material,
          count: stakeCount,
          pending: false,
        },
        opponent: {
          material: currentWagerState.agreed.material,
          count: stakeCount,
          pending: false,
        },
      });
      return;
    }
  }
  if (isHistoricalView) {
    logWagerDebug("apply:clear-historical-non-settled");
    Board.clearWagerPiles();
    return;
  }

  const proposals = currentWagerState.proposals || {};
  const playerUid = Board.playerSideMetadata.uid;
  const opponentUid = Board.opponentSideMetadata.uid;
  const playerProposal =
    playerUid && proposals[playerUid] ? proposals[playerUid] : null;
  const opponentProposal =
    opponentUid && proposals[opponentUid] ? proposals[opponentUid] : null;
  if (!playerProposal && !opponentProposal) {
    logWagerDebug("apply:clear-no-proposals");
    Board.clearWagerPiles();
    return;
  }
  logWagerDebug("apply:show-proposals", {
    playerProposal: playerProposal
      ? { material: playerProposal.material, count: playerProposal.count }
      : null,
    opponentProposal: opponentProposal
      ? { material: opponentProposal.material, count: opponentProposal.count }
      : null,
    playerUid,
    opponentUid,
  });
  Board.setWagerPiles({
    player: playerProposal
      ? {
          material: playerProposal.material,
          count: playerProposal.count,
          pending: true,
        }
      : null,
    opponent: opponentProposal
      ? {
          material: opponentProposal.material,
          count: opponentProposal.count,
          pending: true,
        }
      : null,
  });
}

function syncWagerOutcome(): "shown" | "deferred" | "invalid" {
  if (!currentWagerState || !currentWagerState.resolved) {
    logWagerDebug("sync:invalid-missing-resolved");
    return "invalid";
  }
  const resolved = currentWagerState.resolved;
  const material =
    resolved.material || currentWagerState.agreed?.material || null;
  if (!material) {
    logWagerDebug("sync:invalid-missing-material", {
      resolved: summarizeWagerState(currentWagerState).resolved,
    });
    return "invalid";
  }
  const stakeCount = normalizeWagerStakeCount(
    resolved.count,
    resolved.total ?? currentWagerState.agreed?.total,
  );
  if (!stakeCount) {
    logWagerDebug("sync:invalid-zero-stake", {
      resolved: summarizeWagerState(currentWagerState).resolved,
    });
    return "invalid";
  }
  const winnerIsOpponent = resolved.winnerId === Board.opponentSideMetadata.uid;
  const shouldAnimate =
    isGameOver &&
    wagerOutcomeAnimationAllowed &&
    !isWatchOnly &&
    !wagerOutcomeShown;
  const outcomeAnimationBlocking = isWagerOutcomeAnimationBlocking();
  logWagerDebug("sync:computed", {
    material,
    stakeCount,
    winnerIsOpponent,
    shouldAnimate,
    winnerId: resolved.winnerId,
    boardOpponentUid: Board.opponentSideMetadata.uid,
    boardPlayerUid: Board.playerSideMetadata.uid,
    wagerOutcomeShown,
    wagerOutcomeAnimating: outcomeAnimationBlocking,
    wagerOutcomeAnimationAllowed,
  });
  if (shouldAnimate) {
    if (outcomeAnimationBlocking) {
      logWagerDebug("sync:deferred-animating");
      return "deferred";
    }
    wagerOutcomeAnimating = true;
    if (wagerOutcomeAnimTimer !== null) {
      clearManagedGameTimeout(wagerOutcomeAnimTimer);
    }
    Board.showResolvedWager(winnerIsOpponent, material, stakeCount, true);
    wagerOutcomeShown = true;
    const wagerOutcomeGuard = getSessionGuard();
    wagerOutcomeAnimTimer = setManagedGameTimeout(
      () => {
        wagerOutcomeAnimTimer = null;
        if (!Board.isWagerWinAnimationPendingOrActive()) {
          wagerOutcomeAnimating = false;
        }
      },
      900,
      wagerOutcomeGuard,
    );
    logWagerDebug("sync:shown-animated");
    return "shown";
  }
  if (outcomeAnimationBlocking) {
    logWagerDebug("sync:deferred-existing-animation");
    return "deferred";
  }
  Board.showResolvedWager(winnerIsOpponent, material, stakeCount, false);
  logWagerDebug("sync:shown-static");
  return "shown";
}

function getExpectedOnlineMatchIdOrReconnect(): string | null {
  if (!isOnlineGame) {
    resetOnlineReconnectRequestState();
    return null;
  }
  const activeMatchId = connection.getActiveMatchId();
  if (activeMatchId) {
    resetOnlineReconnectRequestState();
    return activeMatchId;
  }
  const routeState = getCurrentRouteState();
  if (routeState.mode === "invite" && routeState.inviteId) {
    requestOnlineReconnect(routeState.inviteId, routeState.autojoin);
  }
  return null;
}

function handleStaleOnlineLocalOutput(expectedMatchId: string | null): boolean {
  if (!isOnlineGame || !expectedMatchId) {
    return false;
  }
  const activeMatchId = connection.getActiveMatchId();
  if (activeMatchId && activeMatchId === expectedMatchId) {
    return false;
  }
  if (import.meta.env.DEV) {
    console.log("stale-online-local-output", {
      expectedMatchId,
      activeMatchId,
      hasActiveMatch: !!activeMatchId,
    });
  }
  currentInputs = [];
  Board.removeHighlights();
  if (!activeMatchId) {
    void getExpectedOnlineMatchIdOrReconnect();
  }
  return true;
}

function processInput(
  assistedInputKind: AssistedInputKind,
  inputModifier: InputModifier,
  inputLocation?: Location,
  isOutsideBoardInput: boolean = false,
) {
  if (!canHandleLiveBoardInput()) {
    return;
  }
  if (isBotsRoute()) {
    return;
  }

  if (isOnlineGame || isGameWithBot) {
    if (game.activeColor !== playerSideColor) {
      return;
    }
  }

  const expectedMatchId = getExpectedOnlineMatchIdOrReconnect();
  if (isOnlineGame && !expectedMatchId) {
    return;
  }

  if (isOutsideBoardInput && currentInputs.length > 0) {
    currentInputs = [];
    Board.removeHighlights();
    return;
  }

  if (inputLocation) {
    currentInputs.push(inputLocation);
  }

  const gameInput: MonsRules.Input[] = currentInputs.map((input) => ({
    kind: "position",
    position: position(input),
  }));
  const inputColorBeforeMove = game.activeColor;
  const fenBeforeMove = game.toFen();
  const takebacksBeforeMove = game.takebackFens;
  if (inputModifier !== InputModifier.None) {
    let modifier: MonsRules.Modifier;
    switch (inputModifier) {
      case InputModifier.Bomb:
        modifier = MonsRules.Modifier.SelectBomb;
        break;
      case InputModifier.Potion:
        modifier = MonsRules.Modifier.SelectPotion;
        break;
      case InputModifier.Cancel:
        currentInputs = [];
        return;
    }
    gameInput.push({ kind: "modifier", modifier });
  }
  const previewOutput = game.preview(gameInput);
  const output =
    previewOutput.kind === "complete" ? game.play(gameInput) : previewOutput;
  applyOutput(
    takebacksBeforeMove,
    fenBeforeMove,
    output,
    false,
    false,
    assistedInputKind,
    inputLocation,
    inputColorBeforeMove,
    expectedMatchId,
  );
}

function updateLocation(location: Location, inFlashbackMode: boolean = false) {
  if (boardViewMode === "historicalView" && !inFlashbackMode) {
    if (boardViewDebugLogsEnabled) {
      console.warn(
        "[board-view] blocked live location repaint during historicalView",
      );
    }
    return;
  }
  if (flashbackMode && !inFlashbackMode) {
    return;
  }
  if (boardViewMode === "waitingLive" && !inFlashbackMode) {
    return;
  }

  const displayGame = flashbackMode ? flashbackStateGame : game;

  Board.removeItem(location);
  const item = displayGame.itemAt(position(location));
  if (item !== undefined) {
    Board.putItem(item, location);
  } else {
    Board.setupSquare(displayGame.squareAt(position(location)), location);
  }
}

function position(locationModel: Location): MonsRules.Position {
  return { row: locationModel.i, column: locationModel.j };
}

function location(positionModel: MonsRules.Position): Location {
  return new Location(positionModel.row, positionModel.column);
}

const getKnownObservedMatchOwnUid = (): string => {
  const sameProfileUid = connection.getSameProfilePlayerUid();
  if (sameProfileUid && sameProfileUid !== "") {
    return sameProfileUid;
  }
  return Board.playerSideMetadata.uid || "";
};

const warnObservedMatchSideFallbackIfNeeded = (
  matchId: string,
  matchPlayerUid: string,
  knownOwnUid: string,
  knownOpponentUid: string,
): void => {
  if (!boardViewDebugLogsEnabled) {
    return;
  }
  const warningKey = `${matchId}:${matchPlayerUid}:${knownOwnUid}:${knownOpponentUid}`;
  if (warningKey === lastObservedMatchSideFallbackWarningKey) {
    return;
  }
  lastObservedMatchSideFallbackWarningKey = warningKey;
  console.warn(
    "[board-view] fallback opponent-side classification for observed match",
    {
      matchId,
      matchPlayerUid,
      knownOwnUid,
      knownOpponentUid,
      isReconnect,
    },
  );
};

const isObservedMatchOpponentSide = (
  match: Match,
  matchPlayerUid: string,
  matchId: string,
): boolean => {
  if (isWatchOnly) {
    return match.color === "black";
  }
  if (!isReconnect) {
    return true;
  }
  const knownOwnUid = getKnownObservedMatchOwnUid();
  if (knownOwnUid && matchPlayerUid === knownOwnUid) {
    return false;
  }
  const knownOpponentUid = Board.opponentSideMetadata.uid || "";
  if (knownOpponentUid && matchPlayerUid === knownOpponentUid) {
    return true;
  }
  const observedColor = toMonsColor(match.color);
  if (observedColor !== undefined) {
    return observedColor !== playerSideColor;
  }
  if (knownOwnUid && matchPlayerUid && matchPlayerUid !== knownOwnUid) {
    return true;
  }
  warnObservedMatchSideFallbackIfNeeded(
    matchId,
    matchPlayerUid,
    knownOwnUid,
    knownOpponentUid,
  );
  return true;
};

function hasItemAt(location: Location): boolean {
  const item = game.itemAt(position(location));
  if (item !== undefined) {
    return true;
  } else {
    return false;
  }
}

type InitialGameHydration =
  | {
      kind: "provisional";
      gameModel: MonsRules.Game;
    }
  | {
      kind: "trusted";
      trustedGame: TrustedMatchPairGame;
      pair: HistoricalMatchPair;
    };

function prepareInitialGameHydration(
  match: Match,
  matchId: string,
): InitialGameHydration | null {
  if (isReconnect || isWatchOnly) {
    const pair = connection.getCachedHistoricalMatchPair(matchId);
    if (!pair) {
      return null;
    }
    const trustedGame = getTrustedGameFromMatchPair(pair);
    return trustedGame ? { kind: "trusted", trustedGame, pair } : null;
  }

  const provisionalGame = gameModelFromFen(match.fen);
  return provisionalGame
    ? { kind: "provisional", gameModel: provisionalGame }
    : null;
}

function installInitialGameHydration(
  matchId: string,
  hydration: InitialGameHydration,
): void {
  if (hydration.kind === "provisional") {
    installCurrentGameModel(hydration.gameModel);
    return;
  }
  installTrustedGameForMatch(matchId, hydration.trustedGame);
}

function installTrustedGameForMatch(
  matchId: string,
  trustedGame: TrustedMatchPairGame,
): void {
  installCurrentGameModel(trustedGame.gameModel);
  bindVerifiedGameToMatch(matchId);
  remoteMoveSync.setProcessedCounts(
    trustedGame.whiteMovesCount,
    trustedGame.blackMovesCount,
  );
}

function setupWatchOnlyPlayersFromMatchPair(pair: HistoricalMatchPair): void {
  const players = [
    { uid: pair.hostPlayerId, match: pair.hostMatch },
    { uid: pair.guestPlayerId, match: pair.guestMatch },
  ];
  for (const player of players) {
    if (!player.uid || !player.match) {
      continue;
    }
    const isOpponentSide = player.match.color === "black";
    Board.setupPlayerId(player.uid, isOpponentSide);
    Board.updateEmojiAndAuraIfNeeded(
      player.match.emojiId,
      player.match.aura,
      isOpponentSide,
    );
  }
}

function getSurrenderedMatch(
  currentMatch: Match,
  pair: HistoricalMatchPair | null,
): Match | null {
  if (currentMatch.status === "surrendered") {
    return currentMatch;
  }
  if (pair?.hostMatch?.status === "surrendered") {
    return pair.hostMatch;
  }
  if (pair?.guestMatch?.status === "surrendered") {
    return pair.guestMatch;
  }
  return null;
}

function didConnectTo(
  match: Match,
  matchPlayerUid: string,
  matchId: string,
  hydration: InitialGameHydration,
): void {
  ensureBoardViewInvariants("didConnectTo:before");
  installInitialGameHydration(matchId, hydration);
  const trustedPair = hydration.kind === "trusted" ? hydration.pair : null;
  if (trustedPair) {
    matchTimers.seed(matchId, [trustedPair.hostMatch, trustedPair.guestMatch]);
  }
  const surrenderedMatch = getSurrenderedMatch(match, trustedPair);
  const shouldRenderLiveBoard = !shouldPreserveHistoricalViewForCurrentInvite();
  const incomingIsOpponentSide = isObservedMatchOpponentSide(
    match,
    matchPlayerUid,
    matchId,
  );
  if (shouldRenderLiveBoard) {
    rematchViewing.clearSelection();
    boardViewMode = "activeLive";
    publishGameControlsContext();
    nextBoardRenderSession();
    applyBoardUiForCurrentView();
  }
  resetWagerStateForMatch(matchId);
  resetBotScoreReactionState();
  resetLocalRematchSeriesState();
  isOnlineGame = true;
  publishGameControlsContext();
  currentInputs = [];
  if (shouldRenderLiveBoard) {
    applyBoardUiForCurrentView();
    Board.resetForNewGame();
  }

  if (shouldRenderLiveBoard && isOnlineGame) {
    if (shouldShowOnlineReactionButton()) {
      showVoiceReactionButton(true);
    } else {
      showVoiceReactionButton(false);
    }
  }

  if (isWatchOnly) {
    playerSideColor = MonsRules.Color.White;
  } else {
    playerSideColor = incomingIsOpponentSide
      ? match.color === "white"
        ? MonsRules.Color.Black
        : MonsRules.Color.White
      : match.color === "white"
        ? MonsRules.Color.White
        : MonsRules.Color.Black;
    if (shouldRenderLiveBoard) {
      Board.setupPlayerId(matchPlayerUid, incomingIsOpponentSide);
    }
  }

  if (shouldRenderLiveBoard) {
    if (isWatchOnly && trustedPair) {
      setupWatchOnlyPlayersFromMatchPair(trustedPair);
    } else {
      Board.updateEmojiAndAuraIfNeeded(
        match.emojiId,
        match.aura,
        incomingIsOpponentSide,
      );
    }
    applyWagerState();
    markKnownWagerInitialStateReceived();
  }

  if (game.winner !== undefined) {
    disableAndHideUndoResignAndTimerControls();
    Board.hideTimerCountdownDigits();
  }

  verifyMovesIfNeeded(matchId, match.flatMovesString, match.color);

  if (shouldRenderLiveBoard) {
    Board.setBoardFlipped(activeBoardShouldBeFlipped());
  }

  if (shouldRenderLiveBoard) {
    setNewBoard(false);
    updateUndoButtonBasedOnGameState();
    const thereIsWinner = game.winner !== undefined;

    if (surrenderedMatch) {
      handleResignStatus(true, surrenderedMatch.color);
    } else if (!isWatchOnly && !isGameOver && !thereIsWinner) {
      showResignButton();
      showMoveHistoryButton(true);
      if (isPlayerSideTurn()) {
        matchTimers.clearCooldown();
        hideTimerButtons();
        setUndoVisible(true);
        setAutomoveActionVisible(true);
      } else {
        if (!matchTimers.waitsForStashes()) {
          matchTimers.restoreCooldown(matchId);
        }
      }
    }
  }
  if (!shouldRenderLiveBoard && surrenderedMatch) {
    handleResignStatusWithoutRender(true, surrenderedMatch.color);
  }

  matchTimers.update(true, match, matchId);
  ensureBoardViewInvariants("didConnectTo:after");
  preloadRematchScoresAfterGameLoaded();
  triggerMoveHistoryPopupReload();
}

function updateUndoButtonBasedOnGameState() {
  setUndoEnabled(canHandleUndo());
}

function updateBoardMoveStatuses(
  gameModel: MonsRules.Game = game,
  inFlashbackMode: boolean = flashbackMode,
) {
  if (shouldHideBoardMoveStatuses(gameModel, inFlashbackMode)) {
    Board.hideAllMoveStatuses();
    return;
  }
  const inactiveColor =
    gameModel.activeColor === MonsRules.Color.White
      ? MonsRules.Color.Black
      : MonsRules.Color.White;
  Board.updateMoveStatuses(
    gameModel.activeColor,
    gameModel.availableMoveCounts(),
    gameModel.potions[inactiveColor],
  );
}

function setNewBoard(inFlashbackMode: boolean) {
  if (boardViewMode === "historicalView" && !inFlashbackMode) {
    if (boardViewDebugLogsEnabled) {
      console.warn(
        "[board-view] blocked live board repaint during historicalView",
      );
    }
    return;
  }
  if (flashbackMode && !inFlashbackMode) {
    return;
  }
  if (boardViewMode === "waitingLive" && !inFlashbackMode) {
    return;
  }

  const displayGame = flashbackMode ? flashbackStateGame : game;
  refreshDisplayedBoardSquareTypes(inFlashbackMode);
  const showTerminalIndicators = shouldShowTerminalIndicators(
    inFlashbackMode,
    displayGame,
  );
  const displayResignedColor = showTerminalIndicators
    ? getDisplayResignedColor(inFlashbackMode)
    : undefined;
  const displayWinnerByTimerColor = showTerminalIndicators
    ? getDisplayWinnerByTimerColor(inFlashbackMode)
    : undefined;
  Board.updateScore(
    displayGame.scores[MonsRules.Color.White],
    displayGame.scores[MonsRules.Color.Black],
    displayGame.winner,
    displayResignedColor,
    displayWinnerByTimerColor,
  );
  if (
    !inFlashbackMode &&
    hasTerminalResultForDisplayedGame(displayGame, inFlashbackMode)
  ) {
    disableAndHideUndoResignAndTimerControls();
    showRematchInterface();
  }
  updateBoardMoveStatuses(displayGame, inFlashbackMode);
  const locationsWithContent = displayGame.contentPositions().map(location);
  Board.removeItemsNotPresentIn(locationsWithContent);
  locationsWithContent.forEach((loc) => {
    const location = new Location(loc.i, loc.j);
    updateLocation(location, inFlashbackMode);
  });
}

function handleVictoryByTimer(
  onConnect: boolean,
  winnerColor: string,
  justClaimedByYourself: boolean,
) {
  if (isGameOver) {
    return;
  }

  matchTimers.clearCooldown();
  isGameOver = true;
  publishGameControlsContext();
  wagerOutcomeAnimationAllowed = !onConnect;

  Board.hideTimerCountdownDigits();
  disableAndHideUndoResignAndTimerControls();

  Board.removeHighlights();
  Board.hideItemSelectionOrConfirmationOverlay();

  winnerByTimerColor =
    winnerColor === "white" ? MonsRules.Color.White : MonsRules.Color.Black;
  Board.updateScore(
    game.scores[MonsRules.Color.White],
    game.scores[MonsRules.Color.Black],
    game.winner,
    resignedColor,
    winnerByTimerColor,
  );
  updateBoardMoveStatuses(game, false);
  showRematchInterface();
  syncWagerOutcome();

  if (justClaimedByYourself) {
    playSounds([Sound.Victory]);
    updateRatings(true);
  } else if (!onConnect) {
    if (!isWatchOnly) {
      playSounds([Sound.Defeat]);
      updateRatings(false);
    }
  }
}

function handleResignStatusWithoutRender(
  onConnect: boolean,
  resignSenderColor: string,
) {
  if (isGameOver) {
    return;
  }
  matchTimers.clearCooldown();
  if (game.winner !== undefined || winnerByTimerColor !== undefined) {
    isGameOver = true;
    publishGameControlsContext();
    syncInviteBotIntoLocalGameButton();
    resignedColor = undefined;
    return;
  }
  const justConfirmedResignYourself = resignSenderColor === "";
  isGameOver = true;
  publishGameControlsContext();
  syncInviteBotIntoLocalGameButton();
  wagerOutcomeAnimationAllowed = !onConnect;
  if (justConfirmedResignYourself) {
    resignedColor = playerSideColor;
    playSounds([Sound.Defeat]);
    updateRatings(false);
  } else {
    resignedColor =
      resignSenderColor === "white"
        ? MonsRules.Color.White
        : MonsRules.Color.Black;
  }
  if (!onConnect && !justConfirmedResignYourself) {
    playSounds([Sound.Victory]);
    if (!isWatchOnly) {
      updateRatings(true);
    }
  }
}

function handleResignStatus(onConnect: boolean, resignSenderColor: string) {
  if (isGameOver) {
    return;
  }
  matchTimers.clearCooldown();
  if (game.winner !== undefined || winnerByTimerColor !== undefined) {
    isGameOver = true;
    publishGameControlsContext();
    syncInviteBotIntoLocalGameButton();
    resignedColor = undefined;
    return;
  }

  const justConfirmedResignYourself = resignSenderColor === "";
  isGameOver = true;
  publishGameControlsContext();
  syncInviteBotIntoLocalGameButton();
  wagerOutcomeAnimationAllowed = !onConnect;

  if (justConfirmedResignYourself) {
    resignedColor = playerSideColor;
    playSounds([Sound.Defeat]);
    updateRatings(false);
  } else {
    resignedColor =
      resignSenderColor === "white"
        ? MonsRules.Color.White
        : MonsRules.Color.Black;
  }

  if (!onConnect && !justConfirmedResignYourself) {
    playSounds([Sound.Victory]);
    if (!isWatchOnly) {
      updateRatings(true);
    }
  }

  Board.hideTimerCountdownDigits();
  disableAndHideUndoResignAndTimerControls();
  updateBoardMoveStatuses(game, false);

  Board.removeHighlights();
  Board.hideItemSelectionOrConfirmationOverlay();

  if (!onConnect || remoteMoveSync.hasInitializedBothSides()) {
    Board.updateScore(
      game.scores[MonsRules.Color.White],
      game.scores[MonsRules.Color.Black],
      game.winner,
      resignedColor,
      winnerByTimerColor,
    );
  }
  showRematchInterface();
  syncWagerOutcome();
}

export function didClickInviteActionButtonBeforeThereIsInviteReady() {
  if (!isCreateInviteRoute()) return;
  setHomeVisible(true);
  setIslandButtonDimmed(true);

  setBrushAndNavigationButtonDimmed(true);
  setAutomatchVisible(false);
  setBotGameOptionVisible(false);
  dismissNotificationBannerIfNeeded();
  setNavigationListButtonVisible(false);
  setAutomoveActionVisible(false);
  showMoveHistoryButton(false);
  Board.hideBoardPlayersInfo();
  Board.removeHighlights();
  Board.hideAllMoveStatuses();
  isWaitingForInviteToGetAccepted = true;
  Board.runMonsBoardAsDisplayWaitingAnimation();
}

export function didFailToLoadPendingInvite() {
  didFailToLoadGame();
}

export function didFailToLoadGame(notFound = false) {
  return batchGameControlsUpdates(() => {
    isWaitingForInviteToGetAccepted = false;
    isReconnect = true;
    didConnect = false;
    Board.stopMonsBoardAsDisplayAnimations();
    showPrimaryAction(PrimaryActionType.None);
    setHomeVisible(true);
    showWaitingStateText(
      notFound
        ? "Game not found."
        : "Couldn't load this game. Reload to try again.",
    );
    markMainGameError();
  });
}

function showPuzzleInstructions() {
  const text = selectedProblem!.description;
  Board.showInstructionsText(text);
}

export function cleanupCurrentInputs() {
  currentInputs = [];
}

export function didSelectPuzzle(
  problem: Problem,
  skipInstructions: boolean = false,
) {
  return batchGameControlsUpdates(() => {
    dismissNotificationBannerIfNeeded();
    showPrimaryAction(PrimaryActionType.None);
    setPlaySamePuzzleAgainButtonVisible(false);
    isGameOver = false;
    publishGameControlsContext();
    currentInputs = [];

    if (!loadCurrentGameFromFen(problem.fen)) return;
    clearMoveHistoryFlipOverrideForCurrentSession();
    flashbackMode = false;
    didStartLocalGame = true;
    applyGameplayControlsPreset("puzzle");
    closeNavigationAndAppearancePopupIfAny();

    setNewBoard(false);

    puzzleMode = true;
    selectedProblem = problem;
    publishGameControlsContext();

    if (!skipInstructions) {
      showPuzzleInstructions();
    }
    Board.removeHighlights();
    Board.hideItemSelectionOrConfirmationOverlay();
    updateUndoButtonBasedOnGameState();
    triggerMoveHistoryPopupReload();
  });
}

function showNextProblem(problem: Problem) {
  didSelectPuzzle(problem);
}

function getDisplayedMatchPresentation(actorUid: string): {
  emojiId: number;
  aura: Aura;
} | null {
  if (!actorUid) return null;
  const selection = rematchViewing.getSelection();
  const matchId =
    boardViewMode === "historicalView"
      ? selection?.matchId
      : connection.getActiveMatchId();
  if (!matchId) return null;
  if (boardViewMode !== "historicalView") {
    return connection.getMatchPresentation(matchId, actorUid);
  }
  if (!isOnlineGame || !selection) return null;
  const { pair } = selection;
  const match =
    actorUid === pair.hostPlayerId
      ? pair.hostMatch
      : actorUid === pair.guestPlayerId
        ? pair.guestMatch
        : null;
  return match ? { emojiId: match.emojiId, aura: match.aura ?? "none" } : null;
}

function refreshDisplayedMatchPresentation(): void {
  for (const [isOpponentSide, metadata] of [
    [false, Board.playerSideMetadata],
    [true, Board.opponentSideMetadata],
  ] as const) {
    const presentation = getDisplayedMatchPresentation(metadata.uid);
    if (presentation) {
      Board.updateEmojiAndAuraIfNeeded(
        presentation.emojiId,
        presentation.aura,
        isOpponentSide,
      );
    }
  }
}

export function didReceiveMatchPresentationUpdate(
  matchId: string,
  actorUid: string,
): void {
  const displayedMatchId =
    boardViewMode === "historicalView"
      ? rematchViewing.getSelection()?.matchId
      : connection.getActiveMatchId();
  if (
    boardViewMode === "historicalView" ||
    !displayedMatchId ||
    matchId !== displayedMatchId
  )
    return;
  const isOpponentSide = actorUid === Board.opponentSideMetadata.uid;
  if (!isOpponentSide && actorUid !== Board.playerSideMetadata.uid) return;
  const presentation = getDisplayedMatchPresentation(actorUid);
  if (!presentation) return;
  Board.updateEmojiAndAuraIfNeeded(
    presentation.emojiId,
    presentation.aura,
    isOpponentSide,
  );
}

export function didRecoverInviteReactions(
  reactions: Record<string, InviteReaction> | null | undefined,
) {
  if (!reactions) {
    return;
  }
  Object.values(reactions).forEach((reaction) => {
    if (!reaction || typeof reaction.uuid !== "string") {
      return;
    }
    processedVoiceReactions.add(reaction.uuid);
  });
}

export function didReceiveInviteReactionUpdate(
  reaction: InviteReaction,
  senderUid: string,
) {
  if (
    !reaction ||
    typeof reaction.uuid !== "string" ||
    typeof reaction.matchId !== "string"
  ) {
    return;
  }
  if (isWatchOnly) {
    const activeMatchId = connection.getActiveMatchId();
    if (!activeMatchId || reaction.matchId !== activeMatchId) {
      return;
    }
  }
  if (!connection.matchBelongsToCurrentInvite(reaction.matchId)) {
    return;
  }
  if (processedVoiceReactions.has(reaction.uuid)) {
    return;
  }
  processedVoiceReactions.add(reaction.uuid);
  if ((!didConnect && !isWaitingForRematchResponse) || !isOnlineGame) {
    return;
  }
  if (!isWatchOnly) {
    const myUid = connection.getSameProfilePlayerUid();
    if (myUid && senderUid === myUid) {
      return;
    }
  }
  const currentTime = Date.now();
  const watchOnlyAllowed = isWatchOnly
    ? remoteMoveSync.hasInitializedBothSides()
    : false;
  const regularAllowed = isWatchOnly
    ? false
    : currentTime - lastReactionTime > 5000;
  if (!watchOnlyAllowed && !regularAllowed) {
    return;
  }
  let showReactionAtOpponentSide = true;
  if (isWatchOnly) {
    if (senderUid === Board.opponentSideMetadata.uid) {
      showReactionAtOpponentSide = true;
    } else if (senderUid === Board.playerSideMetadata.uid) {
      showReactionAtOpponentSide = false;
    } else {
      const senderColor = connection.getPlayerColorForMatch(
        reaction.matchId,
        senderUid,
      );
      if (!senderColor) {
        return;
      }
      showReactionAtOpponentSide = senderColor === "black";
    }
  }
  playIncomingInviteReaction(reaction, showReactionAtOpponentSide);
  lastReactionTime = currentTime;
}

export function didReceiveMatchUpdates(
  matches: ReadonlyMap<string, Match>,
  matchId: string,
  isActive: () => boolean,
): void {
  if (!isActive() || connection.getActiveMatchId() !== matchId) return;
  const sessionGuard = getSessionGuard();
  for (const match of matches.values()) {
    remoteMoveSync.remember(match, matchId);
  }
  for (const [playerId, match] of matches) {
    if (!isActive() || !sessionGuard()) return;
    didReceiveMatchUpdate(match, playerId, matchId);
  }
}

export function didReceiveMatchUpdate(
  match: Match,
  matchPlayerUid: string,
  matchId: string,
) {
  const activeMatchId = connection.getActiveMatchId();
  if (!activeMatchId || activeMatchId !== matchId) {
    return;
  }
  const sessionGuard = getSessionGuard();
  ensureBoardViewInvariants("didReceiveMatchUpdate:start");
  if (!didConnect) {
    return batchGameControlsUpdates(() => {
      const hydration = prepareInitialGameHydration(match, matchId);
      if (!hydration) {
        return;
      }
      isWaitingForInviteToGetAccepted = false;
      resetOnlineReconnectRequestState();
      if (boardViewMode !== "historicalView") {
        Board.stopMonsBoardAsDisplayAnimations();
        showWaitingStateText("");
        setEndMatchVisible(false);
        setAutomoveActionVisible(false);
        showMoveHistoryButton(false);
        setInviteLinkActionVisible(false);
        setAutomatchVisible(false);
        setBotGameOptionVisible(false);
        setNavigationListButtonVisible(false);
        setEndMatchVisible(false);
        showPrimaryAction(PrimaryActionType.None);
      }
      const wasWaitingForRematchResponse = isWaitingForRematchResponse;
      isWaitingForRematchResponse = false;
      if (wasWaitingForRematchResponse && boardViewMode === "historicalView") {
        pendingRematchNavigationToLiveBoard = true;
        applyBoardUiForCurrentView();
      }
      didConnectTo(match, matchPlayerUid, matchId, hydration);
      if (hydration.kind === "provisional") {
        remoteMoveSync.setProcessedCount(match.color, movesCountOfMatch(match));
      }
      remoteMoveSync.remember(match, matchId);
      didConnect = true;
      markMainGameContentReady(
        !isWatchOnly && !isGameOver && game.winner === undefined,
      );
      if (isReconnect) {
        updateUndoButtonBasedOnGameState();
        if (!isWatchOnly && !isGameOver && game.winner === undefined) {
          setAutomoveActionEnabled(true);
        }
      }
      if (isWatchOnly && connection.rematchSeriesEndIsIndicated()) {
        setEndMatchVisible(true);
        setEndMatchConfirmed(true);
      }
      if (
        (!isReconnect || wasWaitingForRematchResponse) &&
        !isGameOver &&
        !isWatchOnly
      ) {
        playSounds([Sound.DidConnect]);
      }
      return;
    });
  }

  if (!remoteMoveSync.remember(match, matchId)) {
    return;
  }
  const shouldRenderLiveBoard = boardViewMode !== "historicalView";
  let didMutateLiveGameWithoutRender = false;
  const isOpponentSide = isObservedMatchOpponentSide(
    match,
    matchPlayerUid,
    matchId,
  );
  if (shouldRenderLiveBoard) {
    Board.setupPlayerId(matchPlayerUid, isOpponentSide);
    Board.updateEmojiAndAuraIfNeeded(match.emojiId, match.aura, isOpponentSide);
    applyWagerState();
    if (isGameOver) {
      syncWagerOutcome();
    }
  }

  if (isGameOver) {
    return;
  }

  const receivingGame = game;
  const didReplayMoves = remoteMoveSync.drain(matchId, shouldRenderLiveBoard);
  if (
    !sessionGuard() ||
    connection.getActiveMatchId() !== matchId ||
    game !== receivingGame
  ) {
    return;
  }
  if (!shouldRenderLiveBoard && didReplayMoves) {
    didMutateLiveGameWithoutRender = true;
    if (game.winner !== undefined) {
      isGameOver = true;
      publishGameControlsContext();
    }
  }

  const surrenderedMatch = remoteMoveSync.getSurrenderedMatchWhenDrained();
  if (surrenderedMatch) {
    if (shouldRenderLiveBoard) {
      handleResignStatus(false, surrenderedMatch.color);
    } else {
      didMutateLiveGameWithoutRender = true;
      handleResignStatusWithoutRender(false, surrenderedMatch.color);
    }
  }

  if (didMutateLiveGameWithoutRender) {
    triggerMoveHistoryPopupReload();
  }
  matchTimers.update(false, match, matchId);
}

export function didRecoverMyMatch(match: Match, matchId: string) {
  return batchGameControlsUpdates(() => {
    const activeMatchId = connection.getActiveMatchId();
    if (!activeMatchId || activeMatchId !== matchId) {
      return;
    }
    currentInputs = [];
    Board.removeHighlights();
    Board.hideItemSelectionOrConfirmationOverlay();
    ensureBoardViewInvariants("didRecoverMyMatch:before");
    const shouldRenderLiveBoard =
      !shouldPreserveHistoricalViewForCurrentInvite();
    setWatchOnlyState(false);
    setWatchOnlyVisible(false);
    isReconnect = true;
    didConnect = false;
    playerSideColor =
      match.color === "white" ? MonsRules.Color.White : MonsRules.Color.Black;
    const recoveredGame = gameModelFromFen(match.fen);
    if (!recoveredGame) {
      return;
    }

    if (shouldRenderLiveBoard) {
      rematchViewing.clearSelection();
      boardViewMode = "activeLive";
      publishGameControlsContext();
      nextBoardRenderSession();
    }
    resetWagerStateForMatch(matchId);
    resetBotScoreReactionState();
    installCurrentGameModel(recoveredGame);
    if (shouldRenderLiveBoard) {
      Board.setBoardFlipped(activeBoardShouldBeFlipped());
    }
    if (game.winner !== undefined) {
      disableAndHideUndoResignAndTimerControls();
      Board.hideTimerCountdownDigits();
    }
    verifyMovesIfNeeded(matchId, match.flatMovesString, match.color);
    if (shouldRenderLiveBoard) {
      Board.updateEmojiAndAuraIfNeeded(match.emojiId, match.aura, false);
      applyWagerState();
      markKnownWagerInitialStateReceived();
    }

    if (match.status === "surrendered") {
      if (shouldRenderLiveBoard) {
        handleResignStatus(true, match.color);
      } else {
        handleResignStatusWithoutRender(true, match.color);
      }
    }

    matchTimers.update(true, match, matchId);
    ensureBoardViewInvariants("didRecoverMyMatch:after");
    preloadRematchScoresAfterGameLoaded();
  });
}

export function enterWatchOnlyMode(reuseInitialIdentity = false) {
  batchGameControlsUpdates(() => {
    setWatchOnlyState(true);
    setWatchOnlyVisible(true);
  });
  const storedLoginId = storage.getLoginId("");
  const storedProfileId = storage.getProfileId("");
  if (storedLoginId === "" || storedProfileId === "") {
    return;
  }
  const sessionGuard = getSessionGuard();
  const user = sessionAuth.currentUser;
  const isCurrent = () =>
    sessionGuard() &&
    sessionAuth.currentUser === user &&
    storage.getLoginId("") === storedLoginId &&
    storage.getProfileId("") === storedProfileId;
  const canUseInitialIdentity =
    reuseInitialIdentity && user?.uid === storedLoginId;
  void (async () => {
    if (canUseInitialIdentity) {
      if (wasInitialIdentityConsumed(user)) return;
      const pendingIdentity = peekInitialIdentity(user);
      if (pendingIdentity) {
        try {
          const result = await pendingIdentity;
          if (!isCurrent()) return;
          if (result.user === user) {
            const identity = result.read();
            if (identity.ok) {
              if (identity.profile?.id === storedProfileId)
                syncOwnProfileMiningState(identity.profile);
              return;
            }
          }
        } catch {}
      }
    }
    if (!isCurrent()) return;
    const profile = await connection.getProfileByLoginId(storedLoginId);
    if (isCurrent() && profile.id === storedProfileId)
      syncOwnProfileMiningState(profile);
  })().catch(() => {});
}

function movesCountOfMatch(match: Match): number {
  const flatMovesString = match.flatMovesString;
  if (!flatMovesString || flatMovesString === "") {
    return 0;
  }
  let count = 1;
  for (let i = 0; i < flatMovesString.length; i++) {
    if (flatMovesString[i] === "-") {
      count++;
    }
  }
  return count;
}

bindGameInputRuntime({
  get isOnlineGame() {
    return isOnlineGame;
  },
  get isWatchOnly() {
    return isWatchOnly;
  },
  get isGameWithBot() {
    return isGameWithBot;
  },
  get isWaitingForRematchResponse() {
    return isWaitingForRematchResponse;
  },
  didClickSquare,
  didClickOutsideBoard,
  didSelectInputModifier,
  canChangeEmoji,
  sendPlayerEmojiUpdate,
  getDisplayedMatchPresentation,
  showItemsAfterChangingAssetsStyle,
  cleanupCurrentInputs,
  didClickInviteBotIntoLocalGameButton,
  restoreBoardVariantAfterWaitingAnimation,
  showNextWaitingAnimationBoardVariant,
});
