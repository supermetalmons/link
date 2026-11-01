import React, {
  useRef,
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useSyncExternalStore,
} from "react";
import { FIXED_STICKER_IDS } from "@mons/shared/reactions";
import {
  FaUndo,
  FaFlag,
  FaCommentAlt,
  FaTrophy,
  FaFlagCheckered,
  FaHome,
  FaRobot,
  FaStar,
  FaEnvelope,
  FaLink,
  FaShareAlt,
  FaPaintBrush,
  FaScroll,
} from "react-icons/fa";
import { IoSparklesSharp } from "react-icons/io5";
import styled from "styled-components";
import AnimatedHourglassButton from "./AnimatedHourglassButton";
import {
  canHandleUndo,
  didClickUndoButton,
  didClickStartTimerButton,
  didClickClaimVictoryByTimerButton,
  didClickPrimaryActionButton,
  didClickHomeButton,
  didClickInviteActionButtonBeforeThereIsInviteReady,
  didClickAutomoveButton,
  didClickStartBotGameButton,
  didClickEndMatchButton,
  didClickConfirmResignButton,
  playSameCompletedPuzzleAgain,
  dismissPendingAutomatchTransition,
  didSelectPuzzle,
} from "../game/gameController";
import { connection } from "../connection/connection";
import type { AuthState } from "../connection/authModels";
import { defaultEarlyInputEventName, isMobile } from "../utils/misc";
import { soundPlayer } from "../utils/SoundPlayer";
import NavigationPicker from "./NavigationPicker";
import { useNavigationGames } from "./controls/useNavigationGames";
import {
  EVENT_CLOUD_MAX_AVATARS,
  useEventNavigationControls,
} from "./controls/useEventNavigationControls";
import { useReactionActions } from "./controls/useReactionActions";
import { useWagerProposal } from "./controls/useWagerProposal";
import { WagerPicker } from "./controls/WagerPicker";
import { useAutomatchControls } from "./controls/useAutomatchControls";
import { useRematchSeries } from "./controls/useRematchSeries";
import { useMatchControlTimers } from "./controls/useMatchControlTimers";
import { useConfirmationAnchor } from "./controls/useConfirmationAnchor";
import { AnchoredConfirmation } from "./controls/AnchoredConfirmation";
import { RematchSeriesControls } from "./controls/RematchSeriesControls";
import {
  STICKER_IMAGE_BASE_URL,
  useReactionPicker,
} from "./controls/useReactionPicker";
import {
  ControlsContainer,
  BrushButton,
  NavigationListButton,
  ControlButton,
  BottomPillButton,
  ResignButton,
  ResignConfirmation,
  ReactionPillsContainer,
  ReactionPill,
  StickerPill,
  WagerBetButton,
  ShimmerText,
} from "./BottomControlsStyles";
import { closeMenuAndInfoIfAny } from "./controls/menuPort";
import BoardStylePickerComponent from "./BoardStylePicker";
import MoveHistoryPopup from "./MoveHistoryPopup";
import {
  NavigationGameStatus,
  NavigationItem,
} from "../connection/connectionModels";
import {
  getCurrentTarget,
  transitionToHome,
} from "../session/AppSessionManager";
import { getCurrentRouteState } from "../navigation/routeState";
import { registerBottomControlsTransientUiHandler } from "./uiSession";
import { problems } from "../content/problems";
import { emojis } from "../content/emojis";
import { openEventModal } from "./eventModalController";
import {
  PrimaryActionType,
  bindBottomControlsApi,
  handleWagerPanelOutsideTap,
  isWagerPanelVisible,
  resetWagerPanelApi,
  unbindBottomControlsApi,
  type CloseNavigationAndAppearancePopupOptions,
} from "./controls/bottomControlsPort";
import type { GameControlsAction } from "./controls/bottomControlsState";
import { hasBottomControlsPopups } from "./controls/bottomControlsUiState";
import { useBottomControlsUi } from "./controls/useBottomControlsUi";
import { deriveGameControlsView } from "../game/gameControlsModel";
import {
  getGameControlsSnapshot,
  subscribeGameControls,
} from "../game/gameControlsStore";
import { didDismissSomethingWithOutsideTapJustNow } from "./controls/outsideTapState";
import { observeBottomControlsViewport } from "./controls/bottomControlsViewport";

export {
  didDismissSomethingWithOutsideTapJustNow,
  didNotDismissAnythingWithOutsideTapJustNow,
  resetOutsideTapDismissTimeout,
} from "./controls/outsideTapState";
export {
  PrimaryActionType,
  closeNavigationAndAppearancePopupIfAny,
  disableAndHideUndoResignAndTimerControls,
  enableTimerVictoryClaim,
  hasBottomPopupsVisible,
  hasNavigationPopupVisible,
  hideTimerButtons,
  setAutomatchEnabled,
  setAutomatchVisible,
  setAutomatchWaitingState,
  setAutomoveActionEnabled,
  setAutomoveActionVisible,
  setBotGameOptionVisible,
  setBrushAndNavigationButtonDimmed,
  setEndMatchConfirmed,
  setEndMatchVisible,
  setHomeVisible,
  setInviteLinkActionVisible,
  setIsReadyToCopyExistingInviteLink,
  setNavigationListButtonVisible,
  setPlaySamePuzzleAgainButtonVisible,
  setUndoEnabled,
  setUndoVisible,
  setWatchOnlyVisible,
  showMoveHistoryButton,
  showPrimaryAction,
  showResignButton,
  showTimerButtonProgressing,
  showVoiceReactionButton,
  showWaitingStateText,
  setWagerPanelOutsideTapHandler,
  setWagerPanelVisibilityChecker,
} from "./controls/bottomControlsPort";

const LeftCornerInlineControls = styled.div`
  flex: 1 1 0;
  min-width: 0;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 8px;
  pointer-events: none;

  > * {
    pointer-events: auto;
  }
`;

const EventCloudButtonOuter = styled.button`
  position: relative;
  width: 36px;
  height: 36px;
  border: none;
  background: transparent;
  padding: 0;
  margin-left: -1px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-tap-highlight-color: transparent;
  -webkit-user-select: none;
  user-select: none;
  outline: none;
  overflow: visible;
  flex-shrink: 0;
`;

const EventCloudShape = styled.path`
  fill: var(--color-gray-f9);
  stroke: none;

  @media (prefers-color-scheme: dark) {
    fill: var(--primaryContainerBackgroundDark);
  }
`;

const EventCloudAvatar = styled.img`
  position: absolute;
  border-radius: 2px;
  pointer-events: none;
  z-index: 1;
  object-fit: cover;
  image-rendering: auto;
`;

const EventCloudAvatarPlaceholder = styled.div`
  position: absolute;
  border-radius: 2px;
  pointer-events: none;
  z-index: 1;
  background: rgba(128, 128, 128, 0.15);

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.08);
  }
`;

type CloudAvatarSlot = { x: number; y: number; r: number };

const CLOUD_VISUAL_SIZE = 48;
const CLOUD_INSET = (36 - CLOUD_VISUAL_SIZE) / 2;
const CLOUD_AVATAR_LAYOUT_BASE_SIZE = 38;
const CLOUD_AVATAR_LAYOUT_CENTER_OFFSET =
  CLOUD_VISUAL_SIZE / 2 - CLOUD_AVATAR_LAYOUT_BASE_SIZE / 2;

const CLOUD_AVATAR_LAYOUTS: CloudAvatarSlot[][] = [
  [],
  [{ x: 19, y: 19, r: 0 }],
  [
    { x: 14, y: 19, r: -15 },
    { x: 25, y: 18, r: 12 },
  ],
  [
    { x: 19, y: 12, r: 8 },
    { x: 13, y: 25, r: -12 },
    { x: 26, y: 25, r: 15 },
  ],
  [
    { x: 14, y: 13, r: -10 },
    { x: 26, y: 12, r: 14 },
    { x: 12, y: 26, r: 8 },
    { x: 26, y: 26, r: -12 },
  ],
  [
    { x: 19, y: 11, r: 5 },
    { x: 11, y: 21, r: -15 },
    { x: 28, y: 20, r: 10 },
    { x: 13, y: 29, r: 12 },
    { x: 26, y: 29, r: -8 },
  ],
  [
    { x: 14, y: 12, r: -12 },
    { x: 25, y: 11, r: 15 },
    { x: 11, y: 22, r: 8 },
    { x: 28, y: 21, r: -10 },
    { x: 14, y: 30, r: 5 },
    { x: 26, y: 29, r: -15 },
  ],
];

const CLOUD_AVATAR_SIZE = 11;

function buildEventCloudPath(): string {
  const sz = CLOUD_VISUAL_SIZE;
  const cx = sz / 2;
  const cy = sz / 2;
  const rx = 16;
  const ry = 16;
  const n = 8;
  const step = (Math.PI * 2) / n;
  const bumps = [5.4, 3.8, 6.2, 4.6, 6.0, 3.6, 6.6, 4.2];
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = i * step;
    const aM = a + step / 2;
    const aE = a + step;
    const x0 = cx + rx * Math.cos(a);
    const y0 = cy + ry * Math.sin(a);
    const cpx = cx + (rx + bumps[i]!) * Math.cos(aM);
    const cpy = cy + (ry + bumps[i]!) * Math.sin(aM);
    const x1 = cx + rx * Math.cos(aE);
    const y1 = cy + ry * Math.sin(aE);
    if (i === 0) parts.push(`M${x0.toFixed(1)},${y0.toFixed(1)}`);
    parts.push(
      `Q${cpx.toFixed(1)},${cpy.toFixed(1)},${x1.toFixed(1)},${y1.toFixed(1)}`,
    );
  }
  parts.push("Z");
  return parts.join("");
}

const EVENT_CLOUD_PATH = buildEventCloudPath();

interface BottomControlsProps {
  authState: AuthState;
}

const BottomControls: React.FC<BottomControlsProps> = ({ authState }) => {
  const { authStatus, profileId } = authState;
  const controlsSnapshot = useSyncExternalStore(
    subscribeGameControls,
    getGameControlsSnapshot,
    getGameControlsSnapshot,
  );
  const { context, presentation } = controlsSnapshot;
  const { puzzleMode } = context;
  const {
    gameControls,
    endMatchVisible: isEndMatchButtonVisible,
    endMatchConfirmed: isEndMatchConfirmed,
    inviteLinkVisible: isInviteLinkButtonVisible,
    inviteReadyToCopy: didCreateInvite,
    botGameVisible: isBotGameButtonVisible,
    watchOnlyVisible: isWatchOnlyIndicatorVisible,
    homeVisible: isDeepHomeButtonVisible,
    navigationDimmed: isNavigationButtonDimmed,
    appearanceDimmed: isBrushButtonDimmed,
    waitingText: waitingStateText,
    voiceReactionVisible: isVoiceReactionButtonVisible,
    moveHistoryVisible: isMoveHistoryButtonVisible,
    replayPuzzleVisible: isSamePuzzleAgainVisible,
  } = presentation;
  const controlsView = deriveGameControlsView(controlsSnapshot);
  const {
    popups,
    dispatch: dispatchControlsUi,
    updatePresentation: updateGameControlsPresentation,
  } = useBottomControlsUi();
  const controlsUi = { gameControls, popups };
  const dispatchGameControls = useCallback(
    (action: GameControlsAction) => {
      dispatchControlsUi({ type: "gameControls", action });
    },
    [dispatchControlsUi],
  );
  const isNavigationPopupVisible = popups.navigation;
  const isBoardStylePickerVisible = popups.appearance;
  const isMoveHistoryPopupVisible = popups.history;
  const isReactionPickerVisible = popups.reaction.mode !== "closed";
  const isWagerMode = popups.reaction.mode === "wager";
  const wagerSelection = popups.reaction.selection;
  const isUndoButtonVisible = gameControls.undo.visible;
  const isUndoDisabled = !gameControls.undo.enabled;
  const isAutomoveButtonVisible = gameControls.automove.visible;
  const isAutomoveButtonEnabled = gameControls.automove.enabled;
  const isResignButtonVisible = gameControls.resignVisible;
  const primaryAction = gameControls.primaryAction;
  const isStartTimerVisible = gameControls.timer.mode === "progressing";
  const isTimerButtonDisabled = !gameControls.timer.startEnabled;
  const isClaimVictoryVisible = gameControls.timer.mode === "claim";
  const isClaimVictoryButtonDisabled = !gameControls.timer.claimEnabled;
  const timerConfig = gameControls.timer.config;
  const isResignConfirmVisible = gameControls.confirmation === "resign";
  const isTimerConfirmVisible = gameControls.confirmation === "timer";
  const isClaimVictoryConfirmVisible = gameControls.confirmation === "claim";
  const [isInviteLoading, setIsInviteLoading] = useState(false);
  const [inviteCopiedTmpState, setInviteCopiedTmpState] = useState(false);
  const [isVoiceReactionDisabled, setIsVoiceReactionDisabled] = useState(false);
  const {
    topGames: topNavigationGames,
    pagedGames: pagedNavigationGames,
    isLoading: isNavigationGamesLoading,
    isLoadingMore: isNavigationGamesLoadingMore,
    hasMore: navigationHasMoreGames,
    removingInviteIds: navigationRemovingInviteIds,
    hydrateFromCache: hydrateNavigationGamesFromCache,
    loadMore: handleNavigationLoadMoreGames,
    removeWaitingGame: handleNavigationGameRemove,
    setOptimisticPendingAutomatch,
    createProfileRequestGuard,
    getEventParticipantPreview,
  } = useNavigationGames({
    profileId,
    authStatus,
    isOpen: isNavigationPopupVisible,
    client: connection,
  });
  const {
    state: automatchControls,
    beginAutomatchFlow,
    cancelAutomatch,
    setWaiting: setAutomatchWaitingStateHandler,
    setEnabled: setAutomatchEnabledHandler,
    setVisible: setAutomatchVisibleHandler,
    selectNavigationGame: selectAutomatchNavigationGame,
    clearMatchScope: clearAutomatchMatchScope,
  } = useAutomatchControls({
    profileId,
    createProfileRequestGuard,
    setOptimisticPendingAutomatch,
  });
  const isAutomatchButtonVisible = automatchControls.visible;
  const isAutomatchButtonEnabled = automatchControls.enabled;
  const isAutomatchWaiting = automatchControls.waiting;
  const isCancelAutomatchVisible = automatchControls.cancelVisible;
  const isCancelAutomatchDisabled = automatchControls.cancelDisabled;
  const routeState = getCurrentRouteState();
  const {
    selectedNavigationItemId,
    effectiveInviteEventId,
    isEventGameButtonVisible,
    eventCloudAvatars,
    isEventModalVisible,
    shouldSuppressNavigationPopupProgrammaticAutoCloseForEventModal,
    openEventFromNavigation,
    clearPendingEventNavigation,
  } = useEventNavigationControls({
    profileId,
    routeState,
    isOnlineGame: context.isOnlineGame,
    getEventParticipantPreview,
  });

  const [isEndMatchTemporarilyDisabled, setIsEndMatchTemporarilyDisabled] =
    useState(false);
  const {
    visibleStickerIds,
    hasFreshStickerEntitlement,
    stickerUrls,
    canSendSticker,
  } = useReactionPicker({ authState, isOpen: isReactionPickerVisible });
  const [pickerMaxHeight, setPickerMaxHeight] = useState<number | undefined>(
    undefined,
  );

  const {
    canSubmitWager,
    wagerRequiresManualReview,
    handleWagerModeToggle,
    pickerProps: wagerPickerProps,
  } = useWagerProposal({
    authState,
    canWagerInCurrentGame: controlsView.canWagerInCurrentGame,
    reactionPicker: popups.reaction,
    dispatchControlsUi,
  });
  const navigationSelectionEpochRef = useRef(0);
  const beginInviteFlowRef = useRef<
    (options?: { skipSoundInit?: boolean }) => void
  >(() => {});

  const pickerRef = useRef<HTMLDivElement>(null);
  const bottomControlsRef = useRef<HTMLDivElement>(null);
  const controlsContainerRef = useRef<HTMLDivElement>(null);
  const voiceReactionButtonRef = useRef<HTMLButtonElement>(null);
  const moveHistoryButtonRef = useRef<HTMLButtonElement>(null);
  const resignButtonRef = useRef<HTMLButtonElement>(null);
  const resignConfirmRef = useRef<HTMLDivElement>(null);
  const timerButtonRef = useRef<HTMLButtonElement>(null);
  const timerConfirmRef = useRef<HTMLDivElement>(null);
  const claimVictoryButtonRef = useRef<HTMLButtonElement>(null);
  const claimVictoryConfirmRef = useRef<HTMLDivElement>(null);
  const navigationPopupRef = useRef<HTMLDivElement>(null);
  const navigationButtonRef = useRef<HTMLButtonElement>(null);
  const boardStylePickerRef = useRef<HTMLDivElement>(null);
  const brushButtonRef = useRef<HTMLButtonElement>(null);
  const moveHistoryPopupRef = useRef<HTMLDivElement>(null);
  const endMatchGracePeriodTimeoutRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!bottomControlsRef.current || !controlsContainerRef.current) {
      return;
    }
    return observeBottomControlsViewport(
      bottomControlsRef.current,
      controlsContainerRef.current,
    );
  }, []);

  const {
    setMatchScopedTimeout,
    clearTrackedMatchScopedTimeout,
    clearMatchScopedTimeouts,
    hideTimerButtons: hideTimerButtonsHandler,
    showTimerButtonProgressing: showTimerButtonProgressingHandler,
  } = useMatchControlTimers({
    isStartTimerVisible,
    isTimerButtonDisabled,
    dispatchGameControls,
  });

  const clearAllMatchScopedTimeouts = useCallback(() => {
    clearMatchScopedTimeouts();
    clearAutomatchMatchScope();
    if (endMatchGracePeriodTimeoutRef.current !== null) {
      clearTimeout(endMatchGracePeriodTimeoutRef.current);
      endMatchGracePeriodTimeoutRef.current = null;
    }
    setIsEndMatchTemporarilyDisabled(false);
    setIsVoiceReactionDisabled(false);
  }, [clearAutomatchMatchScope, clearMatchScopedTimeouts]);

  useEffect(() => {
    const handleClickOutside = (event: TouchEvent | MouseEvent) => {
      event.stopPropagation();
      if (
        (pickerRef.current &&
          !pickerRef.current.contains(event.target as Node) &&
          !event.composedPath().includes(pickerRef.current) &&
          !voiceReactionButtonRef.current?.contains(event.target as Node)) ||
        (resignConfirmRef.current &&
          !resignConfirmRef.current.contains(event.target as Node) &&
          !resignButtonRef.current?.contains(event.target as Node)) ||
        (timerConfirmRef.current &&
          !timerConfirmRef.current.contains(event.target as Node) &&
          !timerButtonRef.current?.contains(event.target as Node)) ||
        (claimVictoryConfirmRef.current &&
          !claimVictoryConfirmRef.current.contains(event.target as Node) &&
          !claimVictoryButtonRef.current?.contains(event.target as Node))
      ) {
        didDismissSomethingWithOutsideTapJustNow();
        dispatchControlsUi({
          type: "dismissPopups",
          reaction: true,
          confirmation: true,
        });
      }

      if (
        moveHistoryPopupRef.current &&
        !moveHistoryPopupRef.current.contains(event.target as Node) &&
        !moveHistoryButtonRef.current?.contains(event.target as Node)
      ) {
        didDismissSomethingWithOutsideTapJustNow();
        dispatchControlsUi({ type: "dismissPopups", history: true });
      }

      if (
        navigationPopupRef.current &&
        !navigationPopupRef.current.contains(event.target as Node) &&
        !navigationButtonRef.current?.contains(event.target as Node)
      ) {
        if (!isEventModalVisible()) {
          didDismissSomethingWithOutsideTapJustNow();
          navigationSelectionEpochRef.current += 1;
          dispatchControlsUi({ type: "dismissPopups", navigation: true });
        }
      }

      if (
        boardStylePickerRef.current &&
        !boardStylePickerRef.current.contains(event.target as Node) &&
        !brushButtonRef.current?.contains(event.target as Node)
      ) {
        didDismissSomethingWithOutsideTapJustNow();
        dispatchControlsUi({ type: "dismissPopups", appearance: true });
      }

      if (handleWagerPanelOutsideTap && handleWagerPanelOutsideTap(event)) {
        didDismissSomethingWithOutsideTapJustNow();
      }
    };

    document.addEventListener(defaultEarlyInputEventName, handleClickOutside);
    return () => {
      document.removeEventListener(
        defaultEarlyInputEventName,
        handleClickOutside,
      );
    };
  }, [dispatchControlsUi, isEventModalVisible]);

  useEffect(() => {
    if (!isReactionPickerVisible) {
      setPickerMaxHeight(undefined);
      return;
    }
    if (pickerRef.current) {
      const el = pickerRef.current;
      requestAnimationFrame(() => {
        setPickerMaxHeight(el.scrollHeight);
      });
    }
  }, [isReactionPickerVisible]);

  useEffect(() => {
    if (!isReactionPickerVisible) return;
    if (!pickerRef.current) return;
    const el = pickerRef.current;
    requestAnimationFrame(() => {
      setPickerMaxHeight(el.scrollHeight);
    });
  }, [visibleStickerIds, isReactionPickerVisible, isWagerMode, wagerSelection]);

  const { left: timerConfirmLeft, updatePosition: updateTimerConfirmPosition } =
    useConfirmationAnchor({
      isOpen: isTimerConfirmVisible,
      triggerRef: timerButtonRef,
      containerRef: controlsContainerRef,
    });
  const {
    left: claimVictoryConfirmLeft,
    updatePosition: updateClaimVictoryConfirmPosition,
  } = useConfirmationAnchor({
    isOpen: isClaimVictoryConfirmVisible,
    triggerRef: claimVictoryButtonRef,
    containerRef: controlsContainerRef,
  });

  useEffect(() => {
    navigationSelectionEpochRef.current += 1;
  }, [profileId]);

  useEffect(() => clearAllMatchScopedTimeouts, [clearAllMatchScopedTimeouts]);

  const rematchSeries = useRematchSeries({
    setMatchScopedTimeout,
    clearTrackedMatchScopedTimeout,
  });
  const hasRematchSeriesNavigation = rematchSeries.items.length > 0;

  const closeNavigationAndAppearancePopupIfAnyHandler = useCallback(
    (options?: CloseNavigationAndAppearancePopupOptions) => {
      if (!options?.preserveNavigationSelection) {
        navigationSelectionEpochRef.current += 1;
      }
      const shouldSuppressNavigationAutoClose =
        options?.preserveNavigationSelection === true &&
        shouldSuppressNavigationPopupProgrammaticAutoCloseForEventModal();
      dispatchControlsUi({
        type: "closeTransient",
        preserveNavigation: shouldSuppressNavigationAutoClose,
      });
    },
    [
      dispatchControlsUi,
      shouldSuppressNavigationPopupProgrammaticAutoCloseForEventModal,
    ],
  );

  useEffect(() => {
    return registerBottomControlsTransientUiHandler(
      closeNavigationAndAppearancePopupIfAnyHandler,
      clearAllMatchScopedTimeouts,
    );
  }, [
    clearAllMatchScopedTimeouts,
    closeNavigationAndAppearancePopupIfAnyHandler,
  ]);

  useEffect(() => {
    return () => {
      resetWagerPanelApi();
    };
  }, []);

  const beginInviteFlow = (options?: { skipSoundInit?: boolean }) => {
    if (!options?.skipSoundInit) {
      soundPlayer.initializeOnUserInteraction(false);
    }
    if (!didCreateInvite) {
      didClickInviteActionButtonBeforeThereIsInviteReady();
    }
    setIsInviteLoading(true);
    connection.didClickInviteButton((result: boolean) => {
      if (result) {
        const sessionGuard = connection.createSessionGuard();
        if (didCreateInvite) {
          setInviteCopiedTmpState(true);
          setMatchScopedTimeout(() => {
            if (!sessionGuard()) {
              return;
            }
            setInviteCopiedTmpState(false);
          }, 699);
        }
        setIsInviteLoading(false);
        updateGameControlsPresentation({ inviteReadyToCopy: true });
      } else {
        setIsInviteLoading(false);
      }
    });
  };

  const handleInviteClick = () => {
    beginInviteFlow();
  };
  beginInviteFlowRef.current = beginInviteFlow;

  const hasNavigationPopupVisibleHandler = () => isNavigationPopupVisible;

  const setNavigationListButtonVisibleHandler = (visible: boolean) => {
    updateGameControlsPresentation({ navigationVisible: visible });
    if (
      !visible &&
      !shouldSuppressNavigationPopupProgrammaticAutoCloseForEventModal()
    ) {
      dispatchControlsUi({ type: "dismissPopups", navigation: true });
    }
  };

  const showVoiceReactionButtonHandler = (show: boolean) => {
    updateGameControlsPresentation({ voiceReactionVisible: show });
    if (!show) {
      dispatchControlsUi({ type: "dismissPopups", reaction: true });
    }
  };

  const hasBottomPopupsVisibleHandler = () => {
    return hasBottomControlsPopups(controlsUi) || isWagerPanelVisible();
  };

  const setInviteLinkActionVisibleHandler = (visible: boolean) => {
    updateGameControlsPresentation({ inviteLinkVisible: visible });
    if (!visible) {
      setIsInviteLoading(false);
      updateGameControlsPresentation({ inviteReadyToCopy: false });
      setInviteCopiedTmpState(false);
    }
  };

  const toggleReactionPickerHandler = () => {
    if (!isReactionPickerVisible) {
      if (isVoiceReactionDisabled) {
        return;
      }
      closeMenuAndInfoIfAny();
    }
    dispatchControlsUi({
      type: "toggleReaction",
      disabled: isVoiceReactionDisabled,
    });
  };

  const toggleMoveHistoryPopup = () => {
    if (!isMoveHistoryPopupVisible) {
      closeMenuAndInfoIfAny();
      navigationSelectionEpochRef.current += 1;
    }
    dispatchControlsUi({ type: "toggleHistory" });
  };

  const handleBrushClick = () => {
    if (!isBoardStylePickerVisible) {
      closeMenuAndInfoIfAny();
      navigationSelectionEpochRef.current += 1;
    }
    dispatchControlsUi({ type: "toggleAppearance" });
  };

  const handleResignClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!isResignConfirmVisible) {
      closeMenuAndInfoIfAny();
    }
    dispatchGameControls({
      type: "setConfirmation",
      confirmation: isResignConfirmVisible ? "none" : "resign",
    });
  };

  const handleTimerClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!isTimerConfirmVisible) {
      closeMenuAndInfoIfAny();
      updateTimerConfirmPosition();
    }
    dispatchGameControls({
      type: "setConfirmation",
      confirmation: isTimerConfirmVisible ? "none" : "timer",
    });
  };

  const handleHomeClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    navigationSelectionEpochRef.current += 1;
    didClickHomeButton();
  };

  const handleAutomoveClick = () => {
    if (!isAutomoveButtonEnabled) return;
    dispatchGameControls({ type: "setAutomoveEnabled", enabled: false });
    didClickAutomoveButton();
  };

  const handleClaimVictoryClick = (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    if (!isClaimVictoryConfirmVisible) {
      closeMenuAndInfoIfAny();
      updateClaimVictoryConfirmPosition();
    }
    dispatchGameControls({
      type: "setConfirmation",
      confirmation: isClaimVictoryConfirmVisible ? "none" : "claim",
    });
  };

  const handleConfirmStartTimer = (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    dispatchGameControls({ type: "setConfirmation", confirmation: "none" });
    didClickStartTimerButton();
    dispatchGameControls({ type: "disableTimer" });
  };

  const handleConfirmClaimVictory = (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    dispatchGameControls({ type: "setConfirmation", confirmation: "none" });
    didClickClaimVictoryByTimerButton();
    dispatchGameControls({ type: "disableVictoryClaim" });
  };

  const handleEndMatchClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    didClickEndMatchButton();
  };

  const dismissReactionPicker = useCallback(() => {
    dispatchControlsUi({ type: "dismissPopups", reaction: true });
  }, [dispatchControlsUi]);
  const { handleStickerSelect, handleReactionSelect } = useReactionActions({
    isVisible: isVoiceReactionButtonVisible,
    canSendSticker,
    dismissPicker: dismissReactionPicker,
    setDisabled: setIsVoiceReactionDisabled,
    setMatchScopedTimeout,
  });

  const { isWatchOnlyMatchFinished } = controlsView;
  const isEndMatchPillVisible =
    (isEndMatchButtonVisible && !isEndMatchTemporarilyDisabled) ||
    isWatchOnlyMatchFinished;
  const isEndMatchPillFinished =
    isEndMatchConfirmed || isWatchOnlyMatchFinished;
  const isCancelAutomatchInFlight =
    isCancelAutomatchVisible && isCancelAutomatchDisabled;
  const isAutomatchPillVisible =
    isAutomatchButtonVisible && !isCancelAutomatchInFlight;
  const handleUndo = (
    event:
      React.MouseEvent<HTMLButtonElement> | React.TouchEvent<HTMLButtonElement>,
  ) => {
    if ((event.target as HTMLButtonElement).disabled) return;
    didClickUndoButton();
    dispatchGameControls({ type: "setUndoEnabled", enabled: canHandleUndo() });
  };

  const handleConfirmResign = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    dispatchGameControls({ type: "setConfirmation", confirmation: "none" });
    didClickConfirmResignButton();
  };

  const handleSamePuzzleAgainClick = (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    playSameCompletedPuzzleAgain();
  };

  const handlePrimaryActionClick = (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    soundPlayer.initializeOnUserInteraction(false);
    if (primaryAction === PrimaryActionType.Rematch) {
      if (endMatchGracePeriodTimeoutRef.current !== null) {
        clearTimeout(endMatchGracePeriodTimeoutRef.current);
      }
      setIsEndMatchTemporarilyDisabled(true);
      endMatchGracePeriodTimeoutRef.current = window.setTimeout(() => {
        endMatchGracePeriodTimeoutRef.current = null;
        setIsEndMatchTemporarilyDisabled(false);
      }, 3000);
    }
    didClickPrimaryActionButton(primaryAction);
    dispatchGameControls({
      type: "setPrimaryAction",
      action: PrimaryActionType.None,
    });
  };

  const handleBotGameClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    soundPlayer.initializeOnUserInteraction(false);
    didClickStartBotGameButton();
  };

  const handleAutomatchClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    beginAutomatchFlow();
  };

  const handleCancelAutomatchClick = (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    void cancelAutomatch();
  };

  const getPrimaryActionButtonText = () => controlsView.primaryActionText;

  const handleNavigationButtonClick = () => {
    if (!isNavigationPopupVisible) {
      closeMenuAndInfoIfAny();
      hydrateNavigationGamesFromCache();
    } else {
      navigationSelectionEpochRef.current += 1;
    }
    dispatchControlsUi({ type: "toggleNavigation" });
  };

  const handleNavigationGameSelect = (
    item: NavigationItem,
    options?: { status?: NavigationGameStatus },
  ) => {
    navigationSelectionEpochRef.current += 1;
    dispatchControlsUi({
      type: "selectNavigationItem",
      kind: item.entityType === "event" ? "event" : "game",
    });
    if (item.entityType === "event") {
      openEventFromNavigation(item.eventId);
      return;
    }
    clearPendingEventNavigation();
    const inviteId = item.inviteId;
    selectAutomatchNavigationGame(inviteId, options?.status === "pending");
    connection.connectToInvite(inviteId);
  };

  const handleNavigationProblemSelect = (problemId: string) => {
    const selectedProblem = problems.find((item) => item.id === problemId);
    if (!selectedProblem) {
      return;
    }
    const selectionEpoch = navigationSelectionEpochRef.current + 1;
    navigationSelectionEpochRef.current = selectionEpoch;
    dispatchControlsUi({ type: "selectNavigationItem", kind: "problem" });
    dismissPendingAutomatchTransition();
    void (async () => {
      try {
        await transitionToHome({ forceMatchScopeReset: true });
      } catch {}
      if (navigationSelectionEpochRef.current !== selectionEpoch) {
        return;
      }
      const currentTarget = getCurrentTarget();
      if (currentTarget.mode !== "home" || currentTarget.path !== "") {
        return;
      }
      didSelectPuzzle(selectedProblem);
    })();
  };

  const handleShare = async () => {
    try {
      await navigator.share({
        url: window.location.href,
        title: "Play Mons",
      });
    } catch (_) {}
  };

  const selectedProblemId =
    routeState.mode === "home" || routeState.mode === "event"
      ? context.selectedPuzzleId
      : null;
  useLayoutEffect(() => {
    const boundApi = bindBottomControlsApi({
      closeNavigationAndAppearancePopupIfAny:
        closeNavigationAndAppearancePopupIfAnyHandler,
      setNavigationListButtonVisible: setNavigationListButtonVisibleHandler,
      hasNavigationPopupVisible: hasNavigationPopupVisibleHandler,
      hasBottomPopupsVisible: hasBottomPopupsVisibleHandler,
      showVoiceReactionButton: showVoiceReactionButtonHandler,
      setInviteLinkActionVisible: setInviteLinkActionVisibleHandler,
      setAutomatchEnabled: setAutomatchEnabledHandler,
      setAutomatchVisible: setAutomatchVisibleHandler,
      setAutomatchWaitingState: setAutomatchWaitingStateHandler,
      hideTimerButtons: hideTimerButtonsHandler,
      showTimerButtonProgressing: showTimerButtonProgressingHandler,
      toggleReactionPicker: toggleReactionPickerHandler,
    });
    return () => unbindBottomControlsApi(boundApi);
  });

  return (
    <div ref={bottomControlsRef} style={{ display: "contents" }}>
      <BrushButton
        ref={brushButtonRef}
        $dimmed={isBrushButtonDimmed}
        onClick={!isMobile ? handleBrushClick : undefined}
        onTouchStart={isMobile ? handleBrushClick : undefined}
        aria-label="Appearance"
      >
        <FaPaintBrush />
      </BrushButton>
      {isBoardStylePickerVisible && (
        <div ref={boardStylePickerRef}>
          <BoardStylePickerComponent />
        </div>
      )}
      {isNavigationPopupVisible && (
        <div ref={navigationPopupRef}>
          <NavigationPicker
            showsHomeNavigation={isDeepHomeButtonVisible}
            navigateHome={handleHomeClick}
            topGames={topNavigationGames}
            pagedGames={pagedNavigationGames}
            selectedProblemId={selectedProblemId}
            selectedNavigationItemId={selectedNavigationItemId}
            isGamesLoading={isNavigationGamesLoading}
            isLoadingMoreGames={isNavigationGamesLoadingMore}
            hasMoreGames={navigationHasMoreGames}
            onSelectGame={handleNavigationGameSelect}
            onRemoveGame={handleNavigationGameRemove}
            removingGameInviteIds={navigationRemovingInviteIds}
            onSelectProblem={handleNavigationProblemSelect}
            onLoadMoreGames={handleNavigationLoadMoreGames}
          />
        </div>
      )}
      {isMoveHistoryPopupVisible && (
        <MoveHistoryPopup ref={moveHistoryPopupRef} />
      )}
      <ControlsContainer ref={controlsContainerRef}>
        {(isEventGameButtonVisible || hasRematchSeriesNavigation) && (
          <LeftCornerInlineControls>
            {isEventGameButtonVisible && (
              <EventCloudButtonOuter
                onClick={
                  !isMobile
                    ? () => openEventModal(effectiveInviteEventId as string)
                    : undefined
                }
                onTouchStart={
                  isMobile
                    ? () => openEventModal(effectiveInviteEventId as string)
                    : undefined
                }
                aria-label="Event"
              >
                <svg
                  width={CLOUD_VISUAL_SIZE}
                  height={CLOUD_VISUAL_SIZE}
                  viewBox={`0 0 ${CLOUD_VISUAL_SIZE} ${CLOUD_VISUAL_SIZE}`}
                  style={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    transform: "translate(-50%, -50%)",
                    overflow: "visible",
                    pointerEvents: "none",
                  }}
                  aria-hidden="true"
                >
                  <EventCloudShape d={EVENT_CLOUD_PATH} />
                </svg>
                {(
                  CLOUD_AVATAR_LAYOUTS[
                    Math.min(eventCloudAvatars.length, EVENT_CLOUD_MAX_AVATARS)
                  ] ?? CLOUD_AVATAR_LAYOUTS[0]!
                ).map((slot, i) => {
                  const participant = eventCloudAvatars[i];
                  const emojiId = participant?.emojiId ?? null;
                  const posStyle = {
                    width: CLOUD_AVATAR_SIZE,
                    height: CLOUD_AVATAR_SIZE,
                    left:
                      slot.x +
                      CLOUD_AVATAR_LAYOUT_CENTER_OFFSET -
                      CLOUD_AVATAR_SIZE / 2 +
                      CLOUD_INSET,
                    top:
                      slot.y +
                      CLOUD_AVATAR_LAYOUT_CENTER_OFFSET -
                      CLOUD_AVATAR_SIZE / 2 +
                      CLOUD_INSET,
                    transform: `rotate(${slot.r}deg)`,
                  };
                  if (emojiId !== null) {
                    return (
                      <EventCloudAvatar
                        key={i}
                        src={emojis.getEmojiUrl(emojiId)}
                        alt=""
                        style={posStyle}
                      />
                    );
                  }
                  return (
                    <EventCloudAvatarPlaceholder key={i} style={posStyle} />
                  );
                })}
              </EventCloudButtonOuter>
            )}
            <RematchSeriesControls {...rematchSeries} />
          </LeftCornerInlineControls>
        )}
        {isEndMatchPillVisible && (
          <BottomPillButton
            onClick={!isEndMatchPillFinished ? handleEndMatchClick : undefined}
            $isBlue={!isEndMatchPillFinished}
            disabled={isEndMatchPillFinished}
            $isViewOnly={isEndMatchPillFinished}
          >
            {isEndMatchPillFinished ? (
              "Finished"
            ) : (
              <>
                <FaFlagCheckered />
                {"End Match"}
              </>
            )}
          </BottomPillButton>
        )}
        {isWatchOnlyIndicatorVisible &&
          !isWatchOnlyMatchFinished &&
          !isEndMatchConfirmed && (
            <BottomPillButton $isViewOnly={true} disabled={true}>
              {"Watching"}
            </BottomPillButton>
          )}
        {isInviteLinkButtonVisible && !didCreateInvite && (
          <BottomPillButton
            onClick={handleInviteClick}
            $isBlue={true}
            disabled={isInviteLoading}
          >
            {isInviteLoading ? (
              "Creating a Link..."
            ) : (
              <>
                <FaEnvelope style={{ marginRight: "6px", fontSize: "0.9em" }} />
                {"New Link Game"}
              </>
            )}
          </BottomPillButton>
        )}
        {isAutomatchPillVisible && (
          <BottomPillButton
            onClick={handleAutomatchClick}
            $isBlue={true}
            $isViewOnly={isAutomatchWaiting}
            disabled={!isAutomatchButtonEnabled}
          >
            {isAutomatchWaiting ? (
              <ShimmerText>Automatching</ShimmerText>
            ) : (
              <>
                <FaStar style={{ marginRight: "6px", fontSize: "0.9em" }} />
                {"Automatch"}
              </>
            )}
          </BottomPillButton>
        )}
        {isCancelAutomatchVisible && (
          <BottomPillButton
            onClick={handleCancelAutomatchClick}
            $isBlue={true}
            disabled={isCancelAutomatchDisabled}
            $isViewOnly={isCancelAutomatchDisabled}
          >
            {isCancelAutomatchDisabled ? (
              <ShimmerText>Canceling</ShimmerText>
            ) : (
              "Cancel"
            )}
          </BottomPillButton>
        )}
        {isBotGameButtonVisible && (
          <BottomPillButton onClick={handleBotGameClick} $isBlue={true}>
            <FaRobot style={{ marginRight: "6px", fontSize: "0.9em" }} />
            {"Bot Game"}
          </BottomPillButton>
        )}
        {isInviteLinkButtonVisible && didCreateInvite && (
          <>
            <BottomPillButton onClick={handleInviteClick} $isBlue={true}>
              {inviteCopiedTmpState ? (
                "Link is copied"
              ) : (
                <>
                  <FaLink style={{ marginRight: "6px", fontSize: "0.9em" }} />
                  {"Copy Link"}
                </>
              )}
            </BottomPillButton>
            <BottomPillButton onClick={handleShare} $isBlue={true}>
              <FaShareAlt style={{ marginRight: "6px", fontSize: "0.9em" }} />
              {"Share"}
            </BottomPillButton>
          </>
        )}
        {primaryAction !== PrimaryActionType.None && (
          <BottomPillButton $isBlue={true} onClick={handlePrimaryActionClick}>
            {getPrimaryActionButtonText()}
          </BottomPillButton>
        )}
        {isSamePuzzleAgainVisible && (
          <BottomPillButton onClick={handleSamePuzzleAgainClick} $isBlue={true}>
            {"Victory Lap"}
          </BottomPillButton>
        )}
        {waitingStateText !== "" && (
          <BottomPillButton disabled={true} $isViewOnly={true}>
            {waitingStateText}
          </BottomPillButton>
        )}
        {isClaimVictoryVisible && (
          <ControlButton
            ref={claimVictoryButtonRef}
            onClick={handleClaimVictoryClick}
            aria-label="Claim Victory"
            disabled={isClaimVictoryButtonDisabled}
          >
            <FaTrophy />
          </ControlButton>
        )}
        {isStartTimerVisible && (
          <AnimatedHourglassButton
            ref={timerButtonRef}
            config={timerConfig}
            onClick={handleTimerClick}
            disabled={isTimerButtonDisabled}
          />
        )}
        {isUndoButtonVisible && (
          <ControlButton
            onClick={!isMobile ? handleUndo : undefined}
            onTouchStart={isMobile ? handleUndo : undefined}
            aria-label="Undo"
            disabled={isUndoDisabled}
          >
            <FaUndo />
          </ControlButton>
        )}
        {isAutomoveButtonVisible && (
          <ControlButton
            onClick={!isMobile ? handleAutomoveClick : undefined}
            onTouchStart={isMobile ? handleAutomoveClick : undefined}
            aria-label="Bot"
            disabled={!isAutomoveButtonEnabled}
          >
            <IoSparklesSharp />
          </ControlButton>
        )}
        {isMoveHistoryButtonVisible && (
          <ControlButton
            onClick={!isMobile ? toggleMoveHistoryPopup : undefined}
            onTouchStart={isMobile ? toggleMoveHistoryPopup : undefined}
            aria-label="Move History"
            ref={moveHistoryButtonRef}
          >
            <FaScroll />
          </ControlButton>
        )}
        {isVoiceReactionButtonVisible && !puzzleMode && (
          <ControlButton
            onClick={!isMobile ? toggleReactionPickerHandler : undefined}
            onTouchStart={isMobile ? toggleReactionPickerHandler : undefined}
            aria-label="Voice Reaction"
            ref={voiceReactionButtonRef}
            disabled={isVoiceReactionDisabled}
          >
            <FaCommentAlt />
          </ControlButton>
        )}
        {isResignButtonVisible && (
          <ControlButton
            onClick={handleResignClick}
            aria-label="Resign"
            ref={resignButtonRef}
            disabled={false}
          >
            <FaFlag />
          </ControlButton>
        )}
        <NavigationListButton
          ref={navigationButtonRef}
          $dimmed={isNavigationButtonDimmed}
          onClick={!isMobile ? handleNavigationButtonClick : undefined}
          onTouchStart={isMobile ? handleNavigationButtonClick : undefined}
          aria-label="Navigation"
        >
          <FaHome />
        </NavigationListButton>
        {isReactionPickerVisible && (
          <ReactionPillsContainer
            ref={pickerRef}
            {...(pickerMaxHeight === undefined
              ? {}
              : { $animatedMaxHeight: pickerMaxHeight })}
          >
            {wagerRequiresManualReview && (
              <span role="status">
                Wager awaiting manual review. Reserved materials remain held.
              </span>
            )}
            {isWagerMode ? (
              <WagerPicker {...wagerPickerProps} />
            ) : (
              <>
                {canSubmitWager && (
                  <WagerBetButton
                    $ready={true}
                    onClick={!isMobile ? handleWagerModeToggle : undefined}
                    onTouchStart={isMobile ? handleWagerModeToggle : undefined}
                  >
                    Propose a Wager
                  </WagerBetButton>
                )}
                <ReactionPill onClick={() => handleReactionSelect("yo")}>
                  yo
                </ReactionPill>
                <ReactionPill onClick={() => handleReactionSelect("wahoo")}>
                  wahoo
                </ReactionPill>
                <ReactionPill onClick={() => handleReactionSelect("drop")}>
                  drop
                </ReactionPill>
                <ReactionPill onClick={() => handleReactionSelect("slurp")}>
                  slurp
                </ReactionPill>
                <ReactionPill onClick={() => handleReactionSelect("gg")}>
                  gg
                </ReactionPill>
                {visibleStickerIds.map((id) => (
                  <StickerPill
                    key={id}
                    onClick={() => handleStickerSelect(id)}
                    disabled={
                      !FIXED_STICKER_IDS.includes(id) &&
                      !hasFreshStickerEntitlement
                    }
                    aria-label={`Sticker ${id}`}
                  >
                    <img
                      src={
                        stickerUrls[id] ||
                        `${STICKER_IMAGE_BASE_URL}/${id}.webp`
                      }
                      alt=""
                      loading="lazy"
                    />
                  </StickerPill>
                ))}
              </>
            )}
          </ReactionPillsContainer>
        )}
        {isTimerConfirmVisible && (
          <AnchoredConfirmation ref={timerConfirmRef} left={timerConfirmLeft}>
            <ReactionPill onClick={handleConfirmStartTimer}>
              Start a Timer
            </ReactionPill>
          </AnchoredConfirmation>
        )}
        {isClaimVictoryConfirmVisible && (
          <AnchoredConfirmation
            ref={claimVictoryConfirmRef}
            left={claimVictoryConfirmLeft}
          >
            <ReactionPill onClick={handleConfirmClaimVictory}>
              Claim Victory
            </ReactionPill>
          </AnchoredConfirmation>
        )}
        {isResignConfirmVisible && (
          <ResignConfirmation ref={resignConfirmRef}>
            <ResignButton onClick={handleConfirmResign}>Resign</ResignButton>
          </ResignConfirmation>
        )}
      </ControlsContainer>
    </div>
  );
};

export { BottomControls as default };
