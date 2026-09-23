import React, {
  useRef,
  useEffect,
  useLayoutEffect,
  useState,
  useReducer,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  FIXED_STICKER_IDS,
  STICKER_ID_WHITELIST,
} from "@mons/shared/reactions";
import { MATCH_TIMER_DURATION_SECONDS } from "@mons/shared/timers";
import { useAvailableMaterials } from "../hooks/useAvailableMaterials";
import { useMaterialImages } from "../hooks/useMaterialImages";
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
  FaHourglassHalf,
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
  didClickAutomatchButton,
  didClickStartBotGameButton,
  didClickEndMatchButton,
  didClickConfirmResignButton,
  isGameWithBot,
  puzzleMode,
  playSameCompletedPuzzleAgain,
  dismissPendingAutomatchTransition,
  isOnlineGame,
  isWatchOnly,
  isMatchOver,
  getBoardViewMode,
  getRematchSeriesNavigatorItems,
  didSelectRematchSeriesMatch,
  preloadRematchSeriesScores,
  getSelectedPuzzleId,
  didSelectPuzzle,
} from "../game/gameController";
import type { RematchSeriesNavigatorItem } from "../game/gameController";
import { connection } from "../connection/connection";
import type { AuthState } from "../connection/authModels";
import { defaultEarlyInputEventName, isMobile } from "../utils/misc";
import { soundPlayer } from "../utils/SoundPlayer";
import { playReaction, playSounds } from "../content/sounds";
import { newReactionOfKind, newStickerReaction } from "../content/sounds";
import {
  showVoiceReactionText,
  isMetadataSideDisplayedAtOpponentSlot,
  getPlayerReactionUid,
  getOpponentReactionUid,
  showVideoReaction,
} from "./controls/boardReactionPort";
import NavigationPicker from "./NavigationPicker";
import { useNavigationGames } from "./controls/useNavigationGames";
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
  WagerMaterialsGrid,
  WagerMaterialItem,
  WagerMaterialIcon,
  WagerMaterialAmount,
  WagerButtonBadge,
  WagerButtonIcon,
  WagerButtonAmount,
  ShimmerText,
} from "./BottomControlsStyles";
import { closeMenuAndInfoIfAny } from "./controls/menuPort";
import BoardStylePickerComponent from "./BoardStylePicker";
import { Sound } from "../utils/gameModels";
import MoveHistoryPopup from "./MoveHistoryPopup";
import {
  subscribeMoveHistoryPopupReload,
  triggerMoveHistoryPopupSelectionReset,
} from "./controls/moveHistoryPopupStore";
import { MATERIALS, MaterialName } from "../services/rocksMiningService";
import {
  EventNavigationPreviewParticipant,
  EventRecord,
  MatchWagerState,
  NavigationGameStatus,
  NavigationItem,
} from "../connection/connectionModels";
import {
  hasConfirmedWagerSnapshot,
  subscribeToWagerState,
} from "../game/wagerState";
import { getStashedPlayerProfile } from "../utils/playerMetadata";
import {
  getCurrentTarget,
  isTransitionInProgress,
  transitionToHome,
} from "../session/AppSessionManager";
import { getCurrentRouteState } from "../navigation/routeState";
import { subscribeToNavigationState } from "../navigation/appNavigation";
import { registerBottomControlsTransientUiHandler } from "./uiSession";
import {
  decrementLifecycleCounter,
  incrementLifecycleCounter,
} from "../lifecycle/lifecycleDiagnostics";
import { problems } from "../content/problems";
import { emojis } from "../content/emojis";
import {
  getEventModalState,
  openEventModal,
  subscribeToEventModalState,
} from "./eventModalController";
import {
  PrimaryActionType,
  bindBottomControlsApi,
  handleWagerPanelOutsideTap,
  isWagerPanelVisible,
  resetWagerPanelApi,
  unbindBottomControlsApi,
  type PrimaryAction,
  type CloseNavigationAndAppearancePopupOptions,
} from "./controls/bottomControlsPort";
import {
  automatchControlsReducer,
  createAutomatchControlsState,
  type GameControlsAction,
} from "./controls/bottomControlsState";
import {
  bottomControlsUiReducer,
  createBottomControlsUiState,
  hasBottomControlsPopups,
} from "./controls/bottomControlsUiState";
import { didDismissSomethingWithOutsideTapJustNow } from "./controls/outsideTapState";
import { observeBottomControlsViewport } from "./controls/bottomControlsViewport";
import {
  CANCEL_AUTOMATCH_REVEAL_DELAY_MS,
  NAVIGATION_PENDING_CANCEL_INTENT_TTL_MS,
  getCancelAutomatchRevealDeadlineMs,
  getTimerEnableDelayMs,
  hasControlDeadlineElapsed,
} from "./controls/controlTiming";

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

const EVENT_MODAL_NAV_AUTOCLOSE_SUPPRESS_MS = 10000;
const rematchSeriesDigitsFontFamily =
  'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, "Liberation Mono", "Courier New", monospace';
let pendingImmediateCancelAutomatchInviteId: string | null = null;
let pendingImmediateCancelAutomatchIntentExpiresAtMs = 0;
let pendingDelayedCancelAutomatchInviteId: string | null = null;
let pendingDelayedCancelAutomatchIntentExpiresAtMs = 0;
let pendingDelayedCancelAutomatchRevealAtMs = 0;
let pendingFreshAutomatchCancelRevealAtMs = 0;

const clearPendingImmediateCancelAutomatchIntent = () => {
  pendingImmediateCancelAutomatchInviteId = null;
  pendingImmediateCancelAutomatchIntentExpiresAtMs = 0;
};

const requestPendingImmediateCancelAutomatchIntent = (inviteId: string) => {
  if (!inviteId) {
    clearPendingImmediateCancelAutomatchIntent();
    return;
  }
  pendingImmediateCancelAutomatchInviteId = inviteId;
  pendingImmediateCancelAutomatchIntentExpiresAtMs =
    Date.now() + NAVIGATION_PENDING_CANCEL_INTENT_TTL_MS;
};

const consumePendingImmediateCancelAutomatchIntent = (): boolean => {
  const pendingInviteId = pendingImmediateCancelAutomatchInviteId;
  if (!pendingInviteId) {
    return false;
  }
  if (pendingImmediateCancelAutomatchIntentExpiresAtMs < Date.now()) {
    clearPendingImmediateCancelAutomatchIntent();
    return false;
  }
  const routeState = getCurrentRouteState();
  const currentInviteId =
    routeState.mode === "invite" && routeState.inviteId
      ? routeState.inviteId
      : "";
  if (currentInviteId === pendingInviteId) {
    clearPendingImmediateCancelAutomatchIntent();
    return true;
  }
  return false;
};

const clearPendingDelayedCancelAutomatchIntent = () => {
  pendingDelayedCancelAutomatchInviteId = null;
  pendingDelayedCancelAutomatchIntentExpiresAtMs = 0;
  pendingDelayedCancelAutomatchRevealAtMs = 0;
};

const requestPendingDelayedCancelAutomatchIntent = (
  inviteId: string,
  revealAtMs: number,
) => {
  if (!inviteId) {
    clearPendingDelayedCancelAutomatchIntent();
    return;
  }
  pendingDelayedCancelAutomatchInviteId = inviteId;
  pendingDelayedCancelAutomatchIntentExpiresAtMs =
    Date.now() + NAVIGATION_PENDING_CANCEL_INTENT_TTL_MS;
  pendingDelayedCancelAutomatchRevealAtMs =
    revealAtMs > 0
      ? Math.floor(revealAtMs)
      : Date.now() + CANCEL_AUTOMATCH_REVEAL_DELAY_MS;
};

const consumePendingDelayedCancelAutomatchIntent = (): number | null => {
  const pendingInviteId = pendingDelayedCancelAutomatchInviteId;
  if (!pendingInviteId) {
    return null;
  }
  if (pendingDelayedCancelAutomatchIntentExpiresAtMs < Date.now()) {
    clearPendingDelayedCancelAutomatchIntent();
    return null;
  }
  const routeState = getCurrentRouteState();
  const currentInviteId =
    routeState.mode === "invite" && routeState.inviteId
      ? routeState.inviteId
      : "";
  if (currentInviteId === pendingInviteId) {
    const revealAtMs = pendingDelayedCancelAutomatchRevealAtMs;
    clearPendingDelayedCancelAutomatchIntent();
    return revealAtMs > 0 ? revealAtMs : null;
  }
  return null;
};

const RematchSeriesInlineControl = styled.div`
  flex: 1 1 0;
  min-width: 0;
  height: 32px;
  display: flex;
  align-items: center;
  padding: 0;
  overflow: hidden;
  mask-image: linear-gradient(to left, transparent 0px, black 6px);
  -webkit-mask-image: linear-gradient(to left, transparent 0px, black 6px);
`;

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

const RematchSeriesScroll = styled.div`
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: row;
  align-items: center;
  overflow-x: auto;
  overflow-y: hidden;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  -ms-overflow-style: none;

  &::-webkit-scrollbar {
    display: none;
  }
`;

const RematchSeriesTrack = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  background: transparent;
  border-radius: 16px;
  height: 32px;
  flex-shrink: 0;
  padding: 0 1px;
`;

const RematchSeriesChip = styled.button<{ $isSelected: boolean }>`
  border: none;
  border-radius: 9px;
  height: 30px;
  min-width: 26px;
  padding: 0 7px;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  flex-shrink: 0;
  cursor: pointer;
  font-family: ${rematchSeriesDigitsFontFamily};
  font-variant-numeric: tabular-nums;
  background: transparent;
  position: relative;

  &::before {
    content: "";
    display: ${(props) => (props.$isSelected ? "block" : "none")};
    position: absolute;
    left: 50%;
    top: 50%;
    width: 18px;
    height: 30px;
    transform: translate(-50%, -50%);
    border-radius: 50%;
    background: rgba(249, 249, 249, 0.77);
    z-index: 0;

    @media (prefers-color-scheme: dark) {
      background: rgba(36, 36, 36, 0.77);
    }
  }

  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
`;

const RematchScoreOpponent = styled.span<{ $isSelected: boolean }>`
  font-size: 10px;
  line-height: 1;
  font-weight: 400;
  position: relative;
  z-index: 1;
  color: ${(props) =>
    props.$isSelected ? "rgba(0, 0, 0, 0.3)" : "rgba(0, 0, 0, 0.18)"};

  @media (prefers-color-scheme: dark) {
    color: ${(props) =>
      props.$isSelected
        ? "rgba(255, 255, 255, 0.34)"
        : "rgba(255, 255, 255, 0.18)"};
  }
`;

const RematchScorePlayer = styled.span<{ $isSelected: boolean }>`
  font-size: 10px;
  line-height: 1;
  font-weight: 400;
  position: relative;
  z-index: 1;
  color: ${(props) =>
    props.$isSelected ? "rgba(0, 0, 0, 0.3)" : "rgba(0, 0, 0, 0.18)"};

  @media (prefers-color-scheme: dark) {
    color: ${(props) =>
      props.$isSelected
        ? "rgba(255, 255, 255, 0.34)"
        : "rgba(255, 255, 255, 0.18)"};
  }
`;

const RematchSeriesSeparator = styled.div<{ $hidden: boolean }>`
  width: 0.5px;
  height: 14px;
  background: rgba(0, 0, 0, 0.1);
  flex-shrink: 0;
  opacity: ${(props) => (props.$hidden ? 0 : 1)};
  transition: opacity 0.15s ease;

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.12);
  }
`;

const RematchWaitingIcon = styled.span<{ $isSelected: boolean }>`
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  position: relative;
  z-index: 1;
  color: ${(props) =>
    props.$isSelected ? "rgba(0, 0, 0, 0.35)" : "rgba(0, 0, 0, 0.18)"};

  @media (prefers-color-scheme: dark) {
    color: ${(props) =>
      props.$isSelected
        ? "rgba(255, 255, 255, 0.4)"
        : "rgba(255, 255, 255, 0.18)"};
  }
`;

const RematchLoadingDots = styled.span<{ $isSelected: boolean }>`
  font-size: 11px;
  line-height: 1;
  letter-spacing: 1px;
  position: relative;
  z-index: 1;
  color: ${(props) =>
    props.$isSelected ? "rgba(0, 0, 0, 0.35)" : "rgba(0, 0, 0, 0.15)"};

  @media (prefers-color-scheme: dark) {
    color: ${(props) =>
      props.$isSelected
        ? "rgba(255, 255, 255, 0.4)"
        : "rgba(255, 255, 255, 0.15)"};
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
const EVENT_CLOUD_MAX_AVATARS = 4;
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
    const cpx = cx + (rx + bumps[i]) * Math.cos(aM);
    const cpy = cy + (ry + bumps[i]) * Math.sin(aM);
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

const mapEventRecordToNavigationPreview = (
  eventRecord: EventRecord | null,
): EventNavigationPreviewParticipant[] => {
  if (!eventRecord) {
    return [];
  }
  return Object.values(eventRecord.participants)
    .sort((left, right) => left.joinedAtMs - right.joinedAtMs)
    .map((participant) => {
      const displayName = participant.displayName?.trim();
      const username = participant.username?.trim();
      const emojiId = Number.isFinite(participant.emojiId)
        ? Math.trunc(participant.emojiId)
        : NaN;
      return {
        profileId: participant.profileId?.trim() || null,
        displayName: displayName || username || null,
        emojiId: Number.isFinite(emojiId) && emojiId > 0 ? emojiId : null,
        aura: participant.aura?.trim() || null,
      };
    });
};

interface BottomControlsProps {
  authState: AuthState;
}

const BottomControls: React.FC<BottomControlsProps> = ({ authState }) => {
  const { authStatus, profileId } = authState;
  const isAuthenticated = authStatus === "authenticated";
  const [controlsUi, dispatchControlsUi] = useReducer(
    bottomControlsUiReducer,
    undefined,
    () =>
      createBottomControlsUiState({
        duration: MATCH_TIMER_DURATION_SECONDS,
        progress: 0,
        requestDate: Date.now(),
      }),
  );
  const { gameControls, popups } = controlsUi;
  const dispatchGameControls = useCallback((action: GameControlsAction) => {
    dispatchControlsUi({ type: "gameControls", action });
  }, []);
  const isNavigationPopupVisible = popups.navigation;
  const isBoardStylePickerVisible = popups.appearance;
  const isMoveHistoryPopupVisible = popups.history;
  const isReactionPickerVisible = popups.reaction.mode !== "closed";
  const isWagerMode = popups.reaction.mode === "wager";
  const wagerSelection = popups.reaction.selection;
  const [automatchControls, dispatchAutomatchControls] = useReducer(
    automatchControlsReducer,
    undefined,
    createAutomatchControlsState,
  );
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
  const isAutomatchButtonVisible = automatchControls.visible;
  const isAutomatchButtonEnabled = automatchControls.enabled;
  const isAutomatchWaiting = automatchControls.waiting;
  const isCancelAutomatchVisible = automatchControls.cancelVisible;
  const isCancelAutomatchDisabled = automatchControls.cancelDisabled;
  const cancelAutomatchRevealVersion = automatchControls.revealRevision;
  const [isEndMatchButtonVisible, setIsEndMatchButtonVisible] = useState(false);
  const [isEndMatchConfirmed, setIsEndMatchConfirmed] = useState(false);
  const [isInviteLinkButtonVisible, setIsInviteLinkButtonVisible] =
    useState(false);
  const [isBotGameButtonVisible, setIsBotGameButtonVisible] = useState(false);
  const [isWatchOnlyIndicatorVisible, setIsWatchOnlyIndicatorVisible] =
    useState(false);
  const [isDeepHomeButtonVisible, setIsDeepHomeButtonVisible] = useState(false);
  const [isInviteLoading, setIsInviteLoading] = useState(false);
  const [didCreateInvite, setDidCreateInvite] = useState(false);
  const [inviteCopiedTmpState, setInviteCopiedTmpState] = useState(false);
  const [isVoiceReactionDisabled, setIsVoiceReactionDisabled] = useState(false);
  const [isNavigationButtonDimmed, setIsNavigationButtonDimmed] =
    useState(false);
  const [isBrushButtonDimmed, setIsBrushButtonDimmed] = useState(false);
  const [, setIsNavigationListButtonVisible] = useState(false);
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
  const [liveEventCloudAvatars, setLiveEventCloudAvatars] = useState<
    EventNavigationPreviewParticipant[]
  >([]);
  const initialEventModalState = getEventModalState();
  const pendingNavigationOpenedEventModalRequestedAtMsRef = useRef(0);
  const pendingNavigationOpenedEventModalRequestSeqRef = useRef(0);
  const wasEventModalVisibleRef = useRef(
    initialEventModalState.isOpen && !!initialEventModalState.eventId,
  );
  const activeEventModalEventIdRef = useRef<string | null>(
    initialEventModalState.isOpen ? initialEventModalState.eventId : null,
  );
  const [selectedEventModalId, setSelectedEventModalId] = useState<
    string | null
  >(initialEventModalState.isOpen ? initialEventModalState.eventId : null);
  const [retainedEventGame, setRetainedEventGame] = useState<{
    eventId: string;
    inviteId: string;
  } | null>(null);

  const [waitingStateText, setWaitingStateText] = useState("");
  const [isVoiceReactionButtonVisible, setIsVoiceReactionButtonVisible] =
    useState(false);
  const [isMoveHistoryButtonVisible, setIsMoveHistoryButtonVisible] =
    useState(false);
  const [
    isRematchSeriesSelectionInFlight,
    setIsRematchSeriesSelectionInFlight,
  ] = useState(false);
  const [historyUiVersion, setHistoryUiVersion] = useState(0);
  const [isSamePuzzleAgainVisible, setIsSamePuzzleAgainVisible] =
    useState(false);
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
  const [timerConfirmLeft, setTimerConfirmLeft] = useState<number | null>(null);
  const [claimVictoryConfirmLeft, setClaimVictoryConfirmLeft] = useState<
    number | null
  >(null);

  const materialUrls = useMaterialImages(
    isWagerMode && isReactionPickerVisible,
  );
  const hasConfirmedInviteWagers = useSyncExternalStore(
    subscribeToWagerState,
    hasConfirmedWagerSnapshot,
    hasConfirmedWagerSnapshot,
  );
  const {
    availableMaterials: materialAmounts,
    frozenMaterialsStatus,
    hasConfirmedSnapshot: hasFrozenSnapshot,
  } = useAvailableMaterials();
  const eventCloudSubscriptionEventIdRef = useRef<string | null>(null);
  const navigationSelectionEpochRef = useRef(0);
  const beginInviteFlowRef = useRef<
    (options?: { skipSoundInit?: boolean }) => void
  >(() => {});
  const [wagerState, setWagerState] = useState<MatchWagerState | null>(null);

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
  const hourglassEnableTimeoutRef = useRef<number | null>(null);
  const hourglassEnableDeadlineRef = useRef<number | null>(null);
  const isTimerButtonDisabledRef = useRef(true);
  const isStartTimerVisibleRef = useRef(false);
  const cancelAutomatchRevealTimeoutRef = useRef<number | null>(null);
  const cancelAutomatchRevealDeadlineRef = useRef<number | null>(null);
  const pendingCancelAutomatchRevealAtMsRef = useRef<number | null>(null);
  const forceImmediateCancelAutomatchRevealRef = useRef(false);
  const automatchCancelRevealModeRef = useRef<
    "unset" | "immediate" | "delayed"
  >("unset");
  const automatchCancelRevealModeDeadlineRef = useRef<number | null>(null);
  const matchScopedTimeoutIdsRef = useRef<Set<number>>(new Set());
  const navigationPopupRef = useRef<HTMLDivElement>(null);
  const navigationButtonRef = useRef<HTMLButtonElement>(null);
  const boardStylePickerRef = useRef<HTMLDivElement>(null);
  const brushButtonRef = useRef<HTMLButtonElement>(null);
  const moveHistoryPopupRef = useRef<HTMLDivElement>(null);
  const rematchSeriesSelectionLockRef = useRef(false);
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

  const clearTrackedMatchScopedTimeout = useCallback(
    (timeoutId: number | null) => {
      if (timeoutId === null) {
        return;
      }
      if (matchScopedTimeoutIdsRef.current.has(timeoutId)) {
        matchScopedTimeoutIdsRef.current.delete(timeoutId);
        decrementLifecycleCounter("uiTimeouts");
      }
      clearTimeout(timeoutId);
    },
    [],
  );

  const isEventModalVisible = useCallback(() => {
    const modalState = getEventModalState();
    return modalState.isOpen && !!modalState.eventId;
  }, []);

  const shouldSuppressNavigationPopupProgrammaticAutoCloseForEventModal =
    useCallback(() => {
      if (isEventModalVisible()) {
        return true;
      }
      const requestedAtMs =
        pendingNavigationOpenedEventModalRequestedAtMsRef.current;
      if (requestedAtMs <= 0) {
        return false;
      }
      if (Date.now() - requestedAtMs > EVENT_MODAL_NAV_AUTOCLOSE_SUPPRESS_MS) {
        return false;
      }
      return (
        isTransitionInProgress() || getCurrentRouteState().mode === "event"
      );
    }, [isEventModalVisible]);

  const setMatchScopedTimeout = useCallback(
    (callback: () => void, delay: number, guard?: () => boolean): number => {
      const timeoutId = window.setTimeout(() => {
        if (matchScopedTimeoutIdsRef.current.has(timeoutId)) {
          matchScopedTimeoutIdsRef.current.delete(timeoutId);
          decrementLifecycleCounter("uiTimeouts");
        }
        if (guard && !guard()) {
          return;
        }
        callback();
      }, delay);
      matchScopedTimeoutIdsRef.current.add(timeoutId);
      incrementLifecycleCounter("uiTimeouts");
      return timeoutId;
    },
    [],
  );

  const clearAllMatchScopedTimeouts = useCallback(() => {
    matchScopedTimeoutIdsRef.current.forEach((timeoutId) => {
      clearTimeout(timeoutId);
      decrementLifecycleCounter("uiTimeouts");
    });
    matchScopedTimeoutIdsRef.current.clear();
    hourglassEnableTimeoutRef.current = null;
    hourglassEnableDeadlineRef.current = null;
    cancelAutomatchRevealTimeoutRef.current = null;
    cancelAutomatchRevealDeadlineRef.current = null;
    pendingCancelAutomatchRevealAtMsRef.current = null;
    forceImmediateCancelAutomatchRevealRef.current = false;
    automatchCancelRevealModeRef.current = "unset";
    automatchCancelRevealModeDeadlineRef.current = null;
    if (endMatchGracePeriodTimeoutRef.current !== null) {
      clearTimeout(endMatchGracePeriodTimeoutRef.current);
      endMatchGracePeriodTimeoutRef.current = null;
    }
    setIsEndMatchTemporarilyDisabled(false);
    setIsVoiceReactionDisabled(false);
  }, []);

  useEffect(() => {
    isTimerButtonDisabledRef.current = isTimerButtonDisabled;
  }, [isTimerButtonDisabled]);

  useEffect(() => {
    isStartTimerVisibleRef.current = isStartTimerVisible;
  }, [isStartTimerVisible]);

  const tryEnableTimerButtonFromDeadline = useCallback(() => {
    const deadline = hourglassEnableDeadlineRef.current;
    if (!hasControlDeadlineElapsed(deadline, Date.now())) {
      return;
    }
    if (hourglassEnableTimeoutRef.current !== null) {
      clearTrackedMatchScopedTimeout(hourglassEnableTimeoutRef.current);
      hourglassEnableTimeoutRef.current = null;
    }
    hourglassEnableDeadlineRef.current = null;
    if (isStartTimerVisibleRef.current && isTimerButtonDisabledRef.current) {
      dispatchGameControls({ type: "enableTimer" });
    }
  }, [clearTrackedMatchScopedTimeout, dispatchGameControls]);

  const tryRevealCancelAutomatchFromDeadline = useCallback(() => {
    const deadline = cancelAutomatchRevealDeadlineRef.current;
    if (!hasControlDeadlineElapsed(deadline, Date.now())) {
      return;
    }
    if (cancelAutomatchRevealTimeoutRef.current !== null) {
      clearTrackedMatchScopedTimeout(cancelAutomatchRevealTimeoutRef.current);
      cancelAutomatchRevealTimeoutRef.current = null;
    }
    cancelAutomatchRevealDeadlineRef.current = null;
    if (isAutomatchWaiting && isAutomatchButtonVisible) {
      dispatchAutomatchControls({ type: "revealCancel" });
    }
  }, [
    isAutomatchWaiting,
    clearTrackedMatchScopedTimeout,
    isAutomatchButtonVisible,
  ]);

  useEffect(() => {
    const handleTimerDeadlineCheck = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      tryEnableTimerButtonFromDeadline();
    };
    handleTimerDeadlineCheck();
    document.addEventListener("visibilitychange", handleTimerDeadlineCheck);
    window.addEventListener("focus", handleTimerDeadlineCheck);
    window.addEventListener("pageshow", handleTimerDeadlineCheck);
    return () => {
      document.removeEventListener(
        "visibilitychange",
        handleTimerDeadlineCheck,
      );
      window.removeEventListener("focus", handleTimerDeadlineCheck);
      window.removeEventListener("pageshow", handleTimerDeadlineCheck);
    };
  }, [tryEnableTimerButtonFromDeadline]);

  useEffect(() => {
    const handleCancelAutomatchDeadlineCheck = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      tryRevealCancelAutomatchFromDeadline();
    };
    handleCancelAutomatchDeadlineCheck();
    document.addEventListener(
      "visibilitychange",
      handleCancelAutomatchDeadlineCheck,
    );
    window.addEventListener("focus", handleCancelAutomatchDeadlineCheck);
    window.addEventListener("pageshow", handleCancelAutomatchDeadlineCheck);
    return () => {
      document.removeEventListener(
        "visibilitychange",
        handleCancelAutomatchDeadlineCheck,
      );
      window.removeEventListener("focus", handleCancelAutomatchDeadlineCheck);
      window.removeEventListener(
        "pageshow",
        handleCancelAutomatchDeadlineCheck,
      );
    };
  }, [tryRevealCancelAutomatchFromDeadline]);

  useEffect(() => {
    const handleClickOutside = (event: TouchEvent | MouseEvent) => {
      event.stopPropagation();
      if (
        (pickerRef.current &&
          !pickerRef.current.contains(event.target as Node) &&
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
  }, [isEventModalVisible]);

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

  const updateTimerConfirmPosition = useCallback(() => {
    if (!timerButtonRef.current || !controlsContainerRef.current) return;
    const buttonRect = timerButtonRef.current.getBoundingClientRect();
    const containerRect = controlsContainerRef.current.getBoundingClientRect();
    const center = buttonRect.left + buttonRect.width / 2 - containerRect.left;
    const padding = 16;
    const clampedCenter = Math.min(
      containerRect.width - padding,
      Math.max(padding, center),
    );
    setTimerConfirmLeft(clampedCenter);
  }, []);

  const updateClaimVictoryConfirmPosition = useCallback(() => {
    if (!claimVictoryButtonRef.current || !controlsContainerRef.current) return;
    const buttonRect = claimVictoryButtonRef.current.getBoundingClientRect();
    const containerRect = controlsContainerRef.current.getBoundingClientRect();
    const center = buttonRect.left + buttonRect.width / 2 - containerRect.left;
    const padding = 16;
    const clampedCenter = Math.min(
      containerRect.width - padding,
      Math.max(padding, center),
    );
    setClaimVictoryConfirmLeft(clampedCenter);
  }, []);

  useEffect(() => {
    if (!isTimerConfirmVisible) return;
    const raf = requestAnimationFrame(updateTimerConfirmPosition);
    window.addEventListener("resize", updateTimerConfirmPosition);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", updateTimerConfirmPosition);
    };
  }, [isTimerConfirmVisible, updateTimerConfirmPosition]);

  useEffect(() => {
    if (!isClaimVictoryConfirmVisible) return;
    const raf = requestAnimationFrame(updateClaimVictoryConfirmPosition);
    window.addEventListener("resize", updateClaimVictoryConfirmPosition);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", updateClaimVictoryConfirmPosition);
    };
  }, [isClaimVictoryConfirmVisible, updateClaimVictoryConfirmPosition]);

  useEffect(() => {
    const unsubscribe = subscribeToWagerState((state) => {
      setWagerState(state);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    return subscribeToEventModalState((state) => {
      const isVisible = state.isOpen && !!state.eventId;
      const wasVisible = wasEventModalVisibleRef.current;
      if (isVisible && state.eventId) {
        activeEventModalEventIdRef.current = state.eventId;
      }

      if (wasVisible && !isVisible) {
        pendingNavigationOpenedEventModalRequestSeqRef.current += 1;
        const closingEventId = activeEventModalEventIdRef.current;
        activeEventModalEventIdRef.current = null;
        if (
          state.lastCloseReason === "dismiss" &&
          getCurrentRouteState().mode === "event"
        ) {
          pendingNavigationOpenedEventModalRequestedAtMsRef.current =
            Date.now();
        } else {
          pendingNavigationOpenedEventModalRequestedAtMsRef.current = 0;
        }
        if (state.lastCloseReason === "launch_game" && closingEventId) {
          const route = getCurrentRouteState();
          setRetainedEventGame(
            route.mode === "invite" && route.inviteId
              ? { eventId: closingEventId, inviteId: route.inviteId }
              : null,
          );
        }
      } else if (isVisible) {
        pendingNavigationOpenedEventModalRequestedAtMsRef.current = 0;
      } else {
        activeEventModalEventIdRef.current = null;
      }

      wasEventModalVisibleRef.current = isVisible;
      setSelectedEventModalId(isVisible ? state.eventId : null);
    });
  }, []);

  useEffect(() => {
    return subscribeToNavigationState((route) => {
      setRetainedEventGame((current) =>
        route.mode === "invite" && current?.inviteId === route.inviteId
          ? current
          : null,
      );
    });
  }, []);

  useEffect(() => {
    navigationSelectionEpochRef.current += 1;
    eventCloudSubscriptionEventIdRef.current = null;
    dispatchAutomatchControls({ type: "finishCancellation" });
    setLiveEventCloudAvatars([]);
  }, [profileId]);

  useEffect(() => {
    return () => {
      clearAllMatchScopedTimeouts();
      hourglassEnableTimeoutRef.current = null;
      hourglassEnableDeadlineRef.current = null;
      cancelAutomatchRevealTimeoutRef.current = null;
      cancelAutomatchRevealDeadlineRef.current = null;
      pendingCancelAutomatchRevealAtMsRef.current = null;
      forceImmediateCancelAutomatchRevealRef.current = false;
      automatchCancelRevealModeRef.current = "unset";
      automatchCancelRevealModeDeadlineRef.current = null;
      clearPendingImmediateCancelAutomatchIntent();
      clearPendingDelayedCancelAutomatchIntent();
      pendingFreshAutomatchCancelRevealAtMs = 0;
    };
  }, [clearAllMatchScopedTimeouts]);

  useEffect(() => {
    if (cancelAutomatchRevealTimeoutRef.current !== null) {
      clearTrackedMatchScopedTimeout(cancelAutomatchRevealTimeoutRef.current);
      cancelAutomatchRevealTimeoutRef.current = null;
    }
    cancelAutomatchRevealDeadlineRef.current = null;
    if (isAutomatchWaiting && isAutomatchButtonVisible) {
      dispatchAutomatchControls({ type: "finishCancellation" });
      if (forceImmediateCancelAutomatchRevealRef.current) {
        forceImmediateCancelAutomatchRevealRef.current = false;
        pendingCancelAutomatchRevealAtMsRef.current = null;
        dispatchAutomatchControls({ type: "revealCancel" });
      } else {
        const now = Date.now();
        const pendingRevealAtMs = pendingCancelAutomatchRevealAtMsRef.current;
        pendingCancelAutomatchRevealAtMsRef.current = null;
        const deadline = getCancelAutomatchRevealDeadlineMs(
          pendingRevealAtMs,
          now,
        );
        if (deadline <= now) {
          dispatchAutomatchControls({ type: "revealCancel" });
        } else {
          dispatchAutomatchControls({ type: "hideCancel" });
          cancelAutomatchRevealDeadlineRef.current = deadline;
          cancelAutomatchRevealTimeoutRef.current = setMatchScopedTimeout(
            () => {
              cancelAutomatchRevealTimeoutRef.current = null;
              cancelAutomatchRevealDeadlineRef.current = null;
              dispatchAutomatchControls({ type: "revealCancel" });
            },
            deadline - now,
          );
          tryRevealCancelAutomatchFromDeadline();
        }
      }
    } else {
      forceImmediateCancelAutomatchRevealRef.current = false;
      pendingCancelAutomatchRevealAtMsRef.current = null;
      automatchCancelRevealModeRef.current = "unset";
      automatchCancelRevealModeDeadlineRef.current = null;
      dispatchAutomatchControls({ type: "resetCancel" });
    }
    return () => {
      if (cancelAutomatchRevealTimeoutRef.current !== null) {
        clearTrackedMatchScopedTimeout(cancelAutomatchRevealTimeoutRef.current);
        cancelAutomatchRevealTimeoutRef.current = null;
      }
      cancelAutomatchRevealDeadlineRef.current = null;
    };
  }, [
    isAutomatchWaiting,
    cancelAutomatchRevealVersion,
    clearTrackedMatchScopedTimeout,
    isAutomatchButtonVisible,
    setMatchScopedTimeout,
    tryRevealCancelAutomatchFromDeadline,
  ]);

  useEffect(() => {
    return subscribeMoveHistoryPopupReload(() => {
      setHistoryUiVersion((value) => value + 1);
    });
  }, []);

  const rematchSeriesItems: RematchSeriesNavigatorItem[] = (() => {
    void historyUiVersion;
    try {
      return getRematchSeriesNavigatorItems();
    } catch {
      return [];
    }
  })();

  const hasRematchSeriesNavigation = rematchSeriesItems.length > 0;
  const rematchSeriesMatchesKey = rematchSeriesItems
    .map((item) => item.matchId)
    .join("|");

  useEffect(() => {
    if (rematchSeriesMatchesKey === "") {
      return;
    }
    let isDisposed = false;
    let retryTimeoutId: number | null = null;
    let retryCount = 0;

    const hasMissingHistoricalScores = (items: RematchSeriesNavigatorItem[]) =>
      items.some(
        (item) =>
          !item.isActiveMatch &&
          !item.isPendingResponse &&
          (item.whiteScore === null || item.blackScore === null),
      );

    const runPreload = async () => {
      let didChange = false;
      try {
        didChange = await preloadRematchSeriesScores();
      } catch {
        didChange = false;
      }
      if (isDisposed) {
        return;
      }
      if (didChange) {
        setHistoryUiVersion((value) => value + 1);
      }
      let latestItems: RematchSeriesNavigatorItem[] = [];
      try {
        latestItems = getRematchSeriesNavigatorItems();
      } catch {
        latestItems = [];
      }
      if (!hasMissingHistoricalScores(latestItems)) {
        return;
      }
      if (retryCount >= 8) {
        return;
      }
      retryCount += 1;
      retryTimeoutId = setMatchScopedTimeout(() => {
        void runPreload();
      }, 650);
    };

    void runPreload();

    return () => {
      isDisposed = true;
      if (retryTimeoutId !== null) {
        clearTrackedMatchScopedTimeout(retryTimeoutId);
      }
    };
  }, [
    clearTrackedMatchScopedTimeout,
    rematchSeriesMatchesKey,
    setMatchScopedTimeout,
  ]);

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
    [shouldSuppressNavigationPopupProgrammaticAutoCloseForEventModal],
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
        setDidCreateInvite(true);
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
    setIsNavigationListButtonVisible(visible);
    if (
      !visible &&
      !shouldSuppressNavigationPopupProgrammaticAutoCloseForEventModal()
    ) {
      dispatchControlsUi({ type: "dismissPopups", navigation: true });
    }
  };

  const setBrushAndNavigationButtonDimmedHandler = (dimmed: boolean) => {
    setIsNavigationButtonDimmed(dimmed);
    setIsBrushButtonDimmed(dimmed);
  };

  const showVoiceReactionButtonHandler = (show: boolean) => {
    setIsVoiceReactionButtonVisible(show);
    if (!show) {
      dispatchControlsUi({ type: "dismissPopups", reaction: true });
    }
  };

  const showMoveHistoryButtonHandler = (show: boolean) => {
    setIsMoveHistoryButtonVisible(show);
  };

  const showResignButtonHandler = () => {
    dispatchGameControls({ type: "showResign" });
  };

  const showWaitingStateTextHandler = (text: string) => {
    setWaitingStateText(text);
  };

  const setIsReadyToCopyExistingInviteLinkHandler = () => {
    setDidCreateInvite(true);
  };

  const hideTimerButtonsHandler = () => {
    if (hourglassEnableTimeoutRef.current) {
      clearTrackedMatchScopedTimeout(hourglassEnableTimeoutRef.current);
      hourglassEnableTimeoutRef.current = null;
    }
    hourglassEnableDeadlineRef.current = null;
    dispatchGameControls({ type: "hideTimers" });
  };

  const showTimerButtonProgressingHandler = (
    currentProgress: number,
    target: number,
    enableWhenTargetReached: boolean,
  ) => {
    if (hourglassEnableTimeoutRef.current) {
      clearTrackedMatchScopedTimeout(hourglassEnableTimeoutRef.current);
      hourglassEnableTimeoutRef.current = null;
    }
    hourglassEnableDeadlineRef.current = null;

    dispatchGameControls({
      type: "showTimerProgress",
      config: {
        duration: target,
        progress: currentProgress,
        requestDate: Date.now(),
      },
    });

    if (enableWhenTargetReached) {
      const timeUntilTarget = getTimerEnableDelayMs(currentProgress, target);
      if (timeUntilTarget <= 0) {
        dispatchGameControls({ type: "enableTimer" });
        return;
      }
      hourglassEnableDeadlineRef.current = Date.now() + timeUntilTarget;
      hourglassEnableTimeoutRef.current = setMatchScopedTimeout(() => {
        dispatchGameControls({ type: "enableTimer" });
        hourglassEnableTimeoutRef.current = null;
        hourglassEnableDeadlineRef.current = null;
      }, timeUntilTarget);
      tryEnableTimerButtonFromDeadline();
    }
  };

  const hasBottomPopupsVisibleHandler = () => {
    return hasBottomControlsPopups(controlsUi) || isWagerPanelVisible();
  };

  const enableTimerVictoryClaimHandler = () => {
    dispatchGameControls({ type: "showVictoryClaim" });
  };

  const setPlaySamePuzzleAgainButtonVisibleHandler = (visible: boolean) => {
    setIsSamePuzzleAgainVisible(visible);
  };

  const setEndMatchVisibleHandler = (visible: boolean) => {
    setIsEndMatchButtonVisible(visible);
  };

  const setEndMatchConfirmedHandler = (confirmed: boolean) => {
    setIsEndMatchConfirmed(confirmed);
  };

  const setBotGameOptionVisibleHandler = (visible: boolean) => {
    setIsBotGameButtonVisible(visible);
  };

  const setInviteLinkActionVisibleHandler = (visible: boolean) => {
    setIsInviteLinkButtonVisible(visible);
    if (!visible) {
      setIsInviteLoading(false);
      setDidCreateInvite(false);
      setInviteCopiedTmpState(false);
    }
  };

  const setAutomatchWaitingStateHandler = (waiting: boolean) => {
    if (waiting) {
      let revealMode = automatchCancelRevealModeRef.current;
      let revealDeadline = automatchCancelRevealModeDeadlineRef.current;

      if (revealMode === "unset") {
        const shouldRevealImmediatelyFromNavigation =
          consumePendingImmediateCancelAutomatchIntent();
        const delayedRevealAtMs = consumePendingDelayedCancelAutomatchIntent();
        const now = Date.now();
        const shouldDelayReveal =
          !shouldRevealImmediatelyFromNavigation &&
          delayedRevealAtMs !== null &&
          delayedRevealAtMs > now;
        revealMode = shouldDelayReveal ? "delayed" : "immediate";
        revealDeadline = shouldDelayReveal ? delayedRevealAtMs : null;
        automatchCancelRevealModeRef.current = revealMode;
        automatchCancelRevealModeDeadlineRef.current = revealDeadline;
      }

      if (
        revealMode === "delayed" &&
        (revealDeadline === null || revealDeadline <= Date.now())
      ) {
        revealMode = "immediate";
        revealDeadline = null;
        automatchCancelRevealModeRef.current = revealMode;
        automatchCancelRevealModeDeadlineRef.current = null;
      }

      const shouldDelayReveal =
        revealMode === "delayed" && revealDeadline !== null;
      forceImmediateCancelAutomatchRevealRef.current = !shouldDelayReveal;
      pendingCancelAutomatchRevealAtMsRef.current = shouldDelayReveal
        ? revealDeadline
        : null;
      dispatchAutomatchControls({ type: "enterWaiting" });
      return;
    }
    if (cancelAutomatchRevealTimeoutRef.current !== null) {
      clearTrackedMatchScopedTimeout(cancelAutomatchRevealTimeoutRef.current);
      cancelAutomatchRevealTimeoutRef.current = null;
    }
    clearPendingImmediateCancelAutomatchIntent();
    clearPendingDelayedCancelAutomatchIntent();
    pendingFreshAutomatchCancelRevealAtMs = 0;
    cancelAutomatchRevealDeadlineRef.current = null;
    pendingCancelAutomatchRevealAtMsRef.current = null;
    forceImmediateCancelAutomatchRevealRef.current = false;
    automatchCancelRevealModeRef.current = "unset";
    automatchCancelRevealModeDeadlineRef.current = null;
    setOptimisticPendingAutomatch(null);
    dispatchAutomatchControls({ type: "leaveWaiting" });
  };

  const setAutomatchEnabledHandler = (enabled: boolean) => {
    dispatchAutomatchControls({ type: "setEnabled", enabled });
  };

  const setAutomatchVisibleHandler = (visible: boolean) => {
    dispatchAutomatchControls({ type: "setVisible", visible });
  };

  const setHomeVisibleHandler = (visible: boolean) => {
    setIsDeepHomeButtonVisible(visible);
  };

  const setAutomoveActionEnabledHandler = (enabled: boolean) => {
    dispatchGameControls({ type: "setAutomoveEnabled", enabled });
  };

  const setAutomoveActionVisibleHandler = (visible: boolean) => {
    dispatchGameControls({ type: "setAutomoveVisible", visible });
  };

  const setUndoVisibleHandler = (visible: boolean) => {
    dispatchGameControls({ type: "setUndoVisible", visible });
  };

  const setWatchOnlyVisibleHandler = (visible: boolean) => {
    setIsWatchOnlyIndicatorVisible(visible);
  };

  const setUndoEnabledHandler = (enabled: boolean) => {
    dispatchGameControls({ type: "setUndoEnabled", enabled });
  };

  const showPrimaryActionHandler = (action: PrimaryAction) => {
    dispatchGameControls({ type: "setPrimaryAction", action });
  };

  const disableAndHideUndoResignAndTimerControlsHandler = () => {
    dispatchGameControls({ type: "hideGameControls" });
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

  const handleRematchSeriesChipClick = useCallback(async (matchId: string) => {
    if (rematchSeriesSelectionLockRef.current) {
      return;
    }
    rematchSeriesSelectionLockRef.current = true;
    setIsRematchSeriesSelectionInFlight(true);
    try {
      const didSwitch = await didSelectRematchSeriesMatch(matchId);
      if (didSwitch) {
        triggerMoveHistoryPopupSelectionReset();
      }
    } finally {
      rematchSeriesSelectionLockRef.current = false;
      setIsRematchSeriesSelectionInFlight(false);
    }
  }, []);

  const renderRematchSeriesChipContent = useCallback(
    (item: RematchSeriesNavigatorItem) => {
      if (item.isPendingResponse) {
        return (
          <RematchWaitingIcon $isSelected={item.isSelected}>
            <FaHourglassHalf />
          </RematchWaitingIcon>
        );
      }
      if (item.whiteScore !== null && item.blackScore !== null) {
        const opponentScore = item.playerIsWhite
          ? item.blackScore
          : item.whiteScore;
        const playerScore = item.playerIsWhite
          ? item.whiteScore
          : item.blackScore;
        return (
          <>
            <RematchScoreOpponent $isSelected={item.isSelected}>
              {opponentScore}
            </RematchScoreOpponent>
            <RematchScorePlayer $isSelected={item.isSelected}>
              {playerScore}
            </RematchScorePlayer>
          </>
        );
      }
      return (
        <RematchLoadingDots $isSelected={item.isSelected}>·</RematchLoadingDots>
      );
    },
    [],
  );

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

  const handleStickerSelect = useCallback(
    (stickerId: number) => {
      if (!isVoiceReactionButtonVisible) {
        dispatchControlsUi({ type: "dismissPopups", reaction: true });
        return;
      }
      if (!canSendSticker(stickerId)) {
        dispatchControlsUi({ type: "dismissPopups", reaction: true });
        return;
      }
      dispatchControlsUi({ type: "dismissPopups", reaction: true });
      showVideoReaction(
        isMetadataSideDisplayedAtOpponentSlot(false),
        stickerId,
      );
      playSounds([Sound.EmoteSent]);
      if (isGameWithBot) {
        const sessionGuard = connection.createSessionGuard();
        const responseStickerId =
          STICKER_ID_WHITELIST[
            Math.floor(Math.random() * STICKER_ID_WHITELIST.length)
          ];
        setMatchScopedTimeout(() => {
          if (!sessionGuard()) {
            return;
          }
          showVideoReaction(
            isMetadataSideDisplayedAtOpponentSlot(true),
            responseStickerId,
          );
          playSounds([Sound.EmoteReceived]);
        }, 5000);
      } else if (!puzzleMode) {
        connection.sendVoiceReaction(newStickerReaction(stickerId));
        setIsVoiceReactionDisabled(true);
        setMatchScopedTimeout(() => {
          setIsVoiceReactionDisabled(false);
        }, 9999);
      }
    },
    [canSendSticker, isVoiceReactionButtonVisible, setMatchScopedTimeout],
  );

  const handleReactionSelect = useCallback(
    (reaction: string) => {
      if (!isVoiceReactionButtonVisible) {
        dispatchControlsUi({ type: "dismissPopups", reaction: true });
        return;
      }
      dispatchControlsUi({ type: "dismissPopups", reaction: true });
      const reactionObj = newReactionOfKind(reaction);
      playReaction(reactionObj);
      showVoiceReactionText(reaction, false);

      if (isGameWithBot) {
        const sessionGuard = connection.createSessionGuard();
        const responseReaction = reaction;
        const responseReactionObj = newReactionOfKind(responseReaction);
        setMatchScopedTimeout(() => {
          if (!sessionGuard()) {
            return;
          }
          playReaction(responseReactionObj);
          showVoiceReactionText(reaction, true);
        }, 2000);
      } else if (!puzzleMode) {
        connection.sendVoiceReaction(reactionObj);
        setIsVoiceReactionDisabled(true);
        setMatchScopedTimeout(() => {
          setIsVoiceReactionDisabled(false);
        }, 9999);
      }
    },
    [isVoiceReactionButtonVisible, setMatchScopedTimeout],
  );

  const playerUid = getPlayerReactionUid();
  const opponentUid = getOpponentReactionUid();
  const opponentProfile = opponentUid
    ? getStashedPlayerProfile(opponentUid)
    : undefined;
  const playerHasProfile = isAuthenticated && profileId !== "";
  const opponentHasProfile = !!(opponentProfile && opponentProfile.id);
  const hasAgreedWager = !!wagerState?.agreed;
  const hasResolvedWager = !!wagerState?.resolved;
  const playerHasProposed =
    !!(
      playerUid &&
      wagerState?.proposedBy &&
      wagerState.proposedBy[playerUid]
    ) ||
    !!(playerUid && wagerState?.proposals && wagerState.proposals[playerUid]);
  const hasPlayers = !!playerUid && !!opponentUid;
  const isEligibleForWager =
    isOnlineGame &&
    !isWatchOnly &&
    !isGameWithBot &&
    getBoardViewMode() === "activeLive" &&
    !isMatchOver() &&
    playerHasProfile &&
    opponentHasProfile &&
    hasPlayers;
  const isWatchOnlyMatchFinished =
    isWatchOnly && isMatchOver() && !!connection.rematchSeriesEndIsIndicated();
  const isEndMatchPillVisible =
    (isEndMatchButtonVisible && !isEndMatchTemporarilyDisabled) ||
    isWatchOnlyMatchFinished;
  const isEndMatchPillFinished =
    isEndMatchConfirmed || isWatchOnlyMatchFinished;
  const isCancelAutomatchInFlight =
    isCancelAutomatchVisible && isCancelAutomatchDisabled;
  const isAutomatchPillVisible =
    isAutomatchButtonVisible && !isCancelAutomatchInFlight;
  const canSubmitWager =
    hasConfirmedInviteWagers &&
    isEligibleForWager &&
    !hasAgreedWager &&
    !hasResolvedWager &&
    !playerHasProposed;
  const wagerMaterial = wagerSelection.name;
  const wagerCount = wagerSelection.count;
  const wagerReady =
    canSubmitWager &&
    frozenMaterialsStatus === "ready" &&
    !!wagerMaterial &&
    wagerCount > 0;

  const handleWagerModeToggle = useCallback(() => {
    dispatchControlsUi({ type: "enterWager" });
  }, []);

  const handleMaterialSelect = useCallback(
    (name: MaterialName) => {
      if (frozenMaterialsStatus !== "ready") return;
      const total = materialAmounts[name] ?? 0;
      if (total <= 0) return;
      dispatchControlsUi({ type: "selectWagerMaterial", name, total });
    },
    [materialAmounts, frozenMaterialsStatus],
  );

  const handleWagerSubmit = useCallback(() => {
    if (!wagerMaterial || !wagerReady) {
      return;
    }
    dispatchControlsUi({ type: "dismissPopups", reaction: true });
    const material = wagerMaterial;
    const count = wagerCount;
    connection.sendWagerProposal(material, count).catch(() => {});
  }, [wagerReady, wagerCount, wagerMaterial]);

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

  const beginAutomatchFlow = useCallback(
    (options?: { skipSoundInit?: boolean }) => {
      const isAutomatchRequestCurrent = createProfileRequestGuard();
      clearPendingImmediateCancelAutomatchIntent();
      clearPendingDelayedCancelAutomatchIntent();
      pendingFreshAutomatchCancelRevealAtMs =
        Date.now() + CANCEL_AUTOMATCH_REVEAL_DELAY_MS;
      pendingCancelAutomatchRevealAtMsRef.current =
        pendingFreshAutomatchCancelRevealAtMs;
      forceImmediateCancelAutomatchRevealRef.current = false;
      automatchCancelRevealModeRef.current = "unset";
      automatchCancelRevealModeDeadlineRef.current = null;
      if (!options?.skipSoundInit) {
        soundPlayer.initializeOnUserInteraction(false);
      }
      didClickAutomatchButton((response) => {
        if (!isAutomatchRequestCurrent()) {
          return;
        }
        const inviteId = response.ok ? response.inviteId : "";
        const mode = response.ok ? response.mode : "";
        if (mode === "pending" && inviteId) {
          requestPendingDelayedCancelAutomatchIntent(
            inviteId,
            pendingFreshAutomatchCancelRevealAtMs,
          );
          const item =
            connection.createOptimisticPendingAutomatchItem(inviteId);
          if (item) {
            setOptimisticPendingAutomatch(item);
          }
        } else if (mode === "matched") {
          clearPendingDelayedCancelAutomatchIntent();
          setOptimisticPendingAutomatch(null);
        } else {
          clearPendingDelayedCancelAutomatchIntent();
          setOptimisticPendingAutomatch(null);
          dismissPendingAutomatchTransition();
        }
        pendingFreshAutomatchCancelRevealAtMs = 0;
      });
      dispatchAutomatchControls({ type: "beginRequest" });
    },
    [createProfileRequestGuard, setOptimisticPendingAutomatch],
  );

  const handleAutomatchClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    beginAutomatchFlow();
  };

  const handleCancelAutomatchClick = async (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    if (isCancelAutomatchDisabled) return;
    const isCancelRequestCurrent = createProfileRequestGuard();
    dispatchAutomatchControls({ type: "requestCancellation" });
    try {
      const result = await connection.cancelAutomatch();
      if (!isCancelRequestCurrent()) {
        return;
      }
      if (result && result.ok) {
        setOptimisticPendingAutomatch(null);
        dismissPendingAutomatchTransition();
        await transitionToHome({ forceMatchScopeReset: true });
      } else {
        dispatchAutomatchControls({ type: "finishCancellation" });
      }
    } catch (_) {
      if (!isCancelRequestCurrent()) {
        return;
      }
      dispatchAutomatchControls({ type: "finishCancellation" });
    }
  };

  const getPrimaryActionButtonText = () => {
    switch (primaryAction) {
      case PrimaryActionType.JoinGame:
        return "Join Game";
      case PrimaryActionType.Rematch:
        return puzzleMode ? "Next Lesson" : "Play Again";
      default:
        return "";
    }
  };

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
      const requestSeq =
        pendingNavigationOpenedEventModalRequestSeqRef.current + 1;
      pendingNavigationOpenedEventModalRequestSeqRef.current = requestSeq;
      pendingNavigationOpenedEventModalRequestedAtMsRef.current = Date.now();
      openEventModal(item.eventId);
      if (
        pendingNavigationOpenedEventModalRequestSeqRef.current === requestSeq
      ) {
        pendingNavigationOpenedEventModalRequestedAtMsRef.current = 0;
        pendingNavigationOpenedEventModalRequestSeqRef.current += 1;
      }
      return;
    }
    pendingNavigationOpenedEventModalRequestedAtMsRef.current = 0;
    pendingNavigationOpenedEventModalRequestSeqRef.current += 1;
    const inviteId = item.inviteId;
    if (options?.status === "pending") {
      clearPendingDelayedCancelAutomatchIntent();
      pendingFreshAutomatchCancelRevealAtMs = 0;
      requestPendingImmediateCancelAutomatchIntent(inviteId);
      pendingCancelAutomatchRevealAtMsRef.current = null;
      forceImmediateCancelAutomatchRevealRef.current = true;
      automatchCancelRevealModeRef.current = "immediate";
      automatchCancelRevealModeDeadlineRef.current = null;
      dispatchAutomatchControls({ type: "selectPending" });
    } else {
      clearPendingImmediateCancelAutomatchIntent();
      clearPendingDelayedCancelAutomatchIntent();
      pendingFreshAutomatchCancelRevealAtMs = 0;
      pendingCancelAutomatchRevealAtMsRef.current = null;
      forceImmediateCancelAutomatchRevealRef.current = false;
      automatchCancelRevealModeRef.current = "unset";
      automatchCancelRevealModeDeadlineRef.current = null;
    }
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

  const routeState = getCurrentRouteState();
  const selectedProblemId =
    routeState.mode === "home" || routeState.mode === "event"
      ? getSelectedPuzzleId()
      : null;
  const selectedNavigationItemId = selectedEventModalId
    ? `event_${selectedEventModalId}`
    : routeState.mode === "event" && routeState.eventId
      ? `event_${routeState.eventId}`
      : routeState.mode === "invite"
        ? routeState.inviteId
        : null;
  const routeInviteId =
    routeState.mode === "invite" ? routeState.inviteId : null;
  const hasCurrentInviteContext =
    !!routeInviteId &&
    connection.getActiveContextSnapshot()?.inviteId === routeInviteId;
  const currentInviteEventId =
    hasCurrentInviteContext && connection.isCurrentInviteEventOwned()
      ? connection.getCurrentInviteEventId()
      : null;
  const shouldRetainEventGameButton =
    !!retainedEventGame &&
    retainedEventGame.inviteId === routeInviteId &&
    (!hasCurrentInviteContext ||
      currentInviteEventId === retainedEventGame.eventId);
  const effectiveInviteEventId =
    currentInviteEventId ??
    (shouldRetainEventGameButton ? retainedEventGame.eventId : null);
  const isEventGameButtonVisible =
    (isOnlineGame && !!currentInviteEventId) || shouldRetainEventGameButton;

  useEffect(() => {
    if (retainedEventGame && !shouldRetainEventGameButton) {
      setRetainedEventGame((current) =>
        current === retainedEventGame ? null : current,
      );
    }
  }, [retainedEventGame, shouldRetainEventGameButton]);

  useEffect(() => {
    if (!effectiveInviteEventId) {
      eventCloudSubscriptionEventIdRef.current = null;
      setLiveEventCloudAvatars([]);
      return;
    }
    if (eventCloudSubscriptionEventIdRef.current === effectiveInviteEventId) {
      return;
    }
    eventCloudSubscriptionEventIdRef.current = effectiveInviteEventId;
    setLiveEventCloudAvatars(
      getEventParticipantPreview(effectiveInviteEventId).slice(
        0,
        EVENT_CLOUD_MAX_AVATARS,
      ),
    );
  }, [effectiveInviteEventId, getEventParticipantPreview]);

  useEffect(() => {
    if (!effectiveInviteEventId || !isEventGameButtonVisible) {
      return;
    }
    let disposed = false;

    const unsubscribe = connection.subscribeToEvent(
      effectiveInviteEventId,
      (eventRecord) => {
        if (disposed) {
          return;
        }
        const nextAvatars = mapEventRecordToNavigationPreview(
          eventRecord,
        ).slice(0, EVENT_CLOUD_MAX_AVATARS);
        setLiveEventCloudAvatars((previousAvatars) => {
          if (previousAvatars.length >= EVENT_CLOUD_MAX_AVATARS) {
            return previousAvatars;
          }
          if (previousAvatars.length === 0) {
            return nextAvatars.length > 0 ? nextAvatars : previousAvatars;
          }
          if (nextAvatars.length > previousAvatars.length) {
            return nextAvatars;
          }
          return previousAvatars;
        });
      },
    );

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [effectiveInviteEventId, isEventGameButtonVisible]);

  const eventCloudAvatars = useMemo(() => {
    if (!effectiveInviteEventId) {
      return [];
    }
    const liveFallback = liveEventCloudAvatars.slice(
      0,
      EVENT_CLOUD_MAX_AVATARS,
    );
    if (liveFallback.length > 0) {
      return liveFallback;
    }
    return getEventParticipantPreview(effectiveInviteEventId).slice(
      0,
      EVENT_CLOUD_MAX_AVATARS,
    );
  }, [
    effectiveInviteEventId,
    getEventParticipantPreview,
    liveEventCloudAvatars,
  ]);

  useLayoutEffect(() => {
    const boundApi = bindBottomControlsApi({
      closeNavigationAndAppearancePopupIfAny:
        closeNavigationAndAppearancePopupIfAnyHandler,
      setNavigationListButtonVisible: setNavigationListButtonVisibleHandler,
      hasNavigationPopupVisible: hasNavigationPopupVisibleHandler,
      hasBottomPopupsVisible: hasBottomPopupsVisibleHandler,
      showVoiceReactionButton: showVoiceReactionButtonHandler,
      showMoveHistoryButton: showMoveHistoryButtonHandler,
      showResignButton: showResignButtonHandler,
      setInviteLinkActionVisible: setInviteLinkActionVisibleHandler,
      setAutomatchEnabled: setAutomatchEnabledHandler,
      setAutomatchVisible: setAutomatchVisibleHandler,
      setBotGameOptionVisible: setBotGameOptionVisibleHandler,
      setPlaySamePuzzleAgainButtonVisible:
        setPlaySamePuzzleAgainButtonVisibleHandler,
      setAutomatchWaitingState: setAutomatchWaitingStateHandler,
      setBrushAndNavigationButtonDimmed:
        setBrushAndNavigationButtonDimmedHandler,
      showWaitingStateText: showWaitingStateTextHandler,
      setHomeVisible: setHomeVisibleHandler,
      setEndMatchVisible: setEndMatchVisibleHandler,
      setEndMatchConfirmed: setEndMatchConfirmedHandler,
      setUndoVisible: setUndoVisibleHandler,
      setAutomoveActionEnabled: setAutomoveActionEnabledHandler,
      setAutomoveActionVisible: setAutomoveActionVisibleHandler,
      setWatchOnlyVisible: setWatchOnlyVisibleHandler,
      setUndoEnabled: setUndoEnabledHandler,
      disableAndHideUndoResignAndTimerControls:
        disableAndHideUndoResignAndTimerControlsHandler,
      setIsReadyToCopyExistingInviteLink:
        setIsReadyToCopyExistingInviteLinkHandler,
      hideTimerButtons: hideTimerButtonsHandler,
      showTimerButtonProgressing: showTimerButtonProgressingHandler,
      toggleReactionPicker: toggleReactionPickerHandler,
      enableTimerVictoryClaim: enableTimerVictoryClaimHandler,
      showPrimaryAction: showPrimaryActionHandler,
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
                  ] ?? CLOUD_AVATAR_LAYOUTS[0]
                ).map((slot, i) => {
                  const participant = eventCloudAvatars[i];
                  const emojiId =
                    participant?.emojiId != null
                      ? Number(participant.emojiId)
                      : NaN;
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
                  if (Number.isFinite(emojiId) && emojiId > 0) {
                    return (
                      <EventCloudAvatar
                        key={i}
                        src={emojis.getEmojiUrl(Math.trunc(emojiId).toString())}
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
            {hasRematchSeriesNavigation && (
              <RematchSeriesInlineControl>
                <RematchSeriesScroll>
                  <RematchSeriesTrack>
                    {rematchSeriesItems.map((seriesItem, idx, arr) => (
                      <React.Fragment key={seriesItem.matchId}>
                        <RematchSeriesChip
                          $isSelected={seriesItem.isSelected}
                          disabled={isRematchSeriesSelectionInFlight}
                          onClick={() =>
                            void handleRematchSeriesChipClick(
                              seriesItem.matchId,
                            )
                          }
                        >
                          {renderRematchSeriesChipContent(seriesItem)}
                        </RematchSeriesChip>
                        {idx < arr.length - 1 && (
                          <RematchSeriesSeparator $hidden={false} />
                        )}
                      </React.Fragment>
                    ))}
                  </RematchSeriesTrack>
                </RematchSeriesScroll>
              </RematchSeriesInlineControl>
            )}
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
            $animatedMaxHeight={pickerMaxHeight}
          >
            {isWagerMode ? (
              <>
                <WagerBetButton
                  $ready={wagerReady}
                  onClick={
                    wagerReady && !isMobile ? handleWagerSubmit : undefined
                  }
                  onTouchStart={
                    wagerReady && isMobile ? handleWagerSubmit : undefined
                  }
                  disabled={!wagerReady}
                  style={{
                    cursor: wagerReady ? "pointer" : "default",
                    opacity: wagerReady ? 1 : 0.6,
                  }}
                >
                  {frozenMaterialsStatus !== "ready" ? (
                    frozenMaterialsStatus === "unavailable" ? (
                      "Balance unavailable"
                    ) : (
                      "Checking balance"
                    )
                  ) : wagerMaterial && wagerCount > 0 ? (
                    <>
                      <span>Propose</span>
                      <WagerButtonBadge>
                        {materialUrls[wagerMaterial] && (
                          <WagerButtonIcon
                            src={materialUrls[wagerMaterial] || ""}
                            alt=""
                            draggable={false}
                          />
                        )}
                        <WagerButtonAmount>{wagerCount}</WagerButtonAmount>
                      </WagerButtonBadge>
                    </>
                  ) : (
                    "Select a Material"
                  )}
                </WagerBetButton>
                <WagerMaterialsGrid>
                  {MATERIALS.map((name) => (
                    <WagerMaterialItem
                      key={name}
                      onClick={
                        !isMobile ? () => handleMaterialSelect(name) : undefined
                      }
                      onTouchStart={
                        isMobile ? () => handleMaterialSelect(name) : undefined
                      }
                      disabled={
                        frozenMaterialsStatus !== "ready" ||
                        materialAmounts[name] <= 0
                      }
                      style={{ opacity: materialAmounts[name] > 0 ? 1 : 0.4 }}
                    >
                      {materialUrls[name] && (
                        <WagerMaterialIcon
                          src={materialUrls[name] || ""}
                          alt=""
                          draggable={false}
                        />
                      )}
                      <WagerMaterialAmount>
                        {hasFrozenSnapshot ? materialAmounts[name] : "—"}
                      </WagerMaterialAmount>
                    </WagerMaterialItem>
                  ))}
                </WagerMaterialsGrid>
              </>
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
          <ResignConfirmation
            ref={timerConfirmRef}
            style={
              timerConfirmLeft !== null
                ? {
                    left: `${timerConfirmLeft}px`,
                    right: "auto",
                    transform: "translateX(-50%)",
                  }
                : undefined
            }
          >
            <ReactionPill onClick={handleConfirmStartTimer}>
              Start a Timer
            </ReactionPill>
          </ResignConfirmation>
        )}
        {isClaimVictoryConfirmVisible && (
          <ResignConfirmation
            ref={claimVictoryConfirmRef}
            style={
              claimVictoryConfirmLeft !== null
                ? {
                    left: `${claimVictoryConfirmLeft}px`,
                    right: "auto",
                    transform: "translateX(-50%)",
                  }
                : undefined
            }
          >
            <ReactionPill onClick={handleConfirmClaimVictory}>
              Claim Victory
            </ReactionPill>
          </ResignConfirmation>
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
