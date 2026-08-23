import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FaLink, FaShareAlt } from "react-icons/fa";
import { connection } from "../../connection/connection";
import {
  EventMatch,
  EventParticipant,
  EventPrizeAssignment,
  EventPrizeId,
  EventPrizeSelections,
  EventRecord,
  PlayerProfile,
} from "../../connection/connectionModels";
import {
  closeEventModal,
  EVENT_MODAL_Z_INDEX,
  type EventModalState,
  getEventModalState,
  subscribeToEventModalState,
} from "./modalState";
import { emojis } from "../../content/emojis";
import { storage } from "../../utils/storage";
import { openProfileSignInPopupForEvent } from "../identity/profileUiPort";
import { getCurrentRouteState } from "../../navigation/routeState";
import {
  didDismissSomethingWithOutsideTapJustNow,
  didNotDismissAnythingWithOutsideTapJustNow,
} from "../controls/outsideTapState";
import { showShinyCard, showsShinyCardSomewhere } from "../shinyCardUiPort";
import { getStashedPlayerProfile } from "../../utils/playerMetadata";
import { BottomPillButton } from "../BottomControlsStyles";
import {
  EVENT_POSTPONE_OPTIONS_MINUTES,
  isMonsLinkAdmin,
} from "@mons/shared/events";
import { getEventPrizeConfig } from "@mons/shared/event-prizes";
import {
  EVENT_AUTO_RECOVERY_DELAY_MS,
  EVENT_AUTO_RECOVERY_MAX_ATTEMPTS_PER_REASON,
  EVENT_AUTO_RECOVERY_MIN_GAP_MS,
  EVENT_SUBSCRIBE_RETRY_DELAYS_MS,
  PENDING_JOIN_POLL_INTERVAL_MS,
  PENDING_JOIN_POLL_TIMEOUT_MS,
  type BracketMatchAction,
  formatAbsoluteStart,
  formatRelativeStart,
  getActivePendingMatches,
  getBracketMatchAction,
  getCurrentUiState,
  getDisplayedMatchSides,
  getEventAutoRecoveryReason,
  getEventMatchInviteId,
  getEventNowRefreshDelayMs,
  getMatchSideData,
  getMatchSideLabel,
  getSortedMatches,
  getSortedParticipants,
  getSortedRounds,
  getThirdPlaceMatch,
  getWatchableMatch,
  isLocalEventCreator,
  isLocalEventParticipant,
  isMatchSideBlocked,
} from "./eventState";
import {
  type ThirdPlaceMatchLayout,
  canRenderSymmetricalBracket,
  computeSymmetricalBracket,
} from "./bracketGeometry";
import {
  BRACKET_AVATAR_PX,
  BRACKET_EDGE_PADDING_X,
  BRACKET_EDGE_PADDING_Y,
  BRACKET_THIRD_PLACE_AVATAR_PX,
  BRACKET_THIRD_PLACE_GAP,
  BRACKET_THIRD_PLACE_MATCH_H,
  BRACKET_THIRD_PLACE_MATCH_W,
  CONTENT_AREA_PADDING_PX,
  EMPTY_EVENT_PRIZES,
  FALLBACK_AVATAR_PX,
  PARTICIPANT_PROFILE_CACHE_TTL_MS,
  PRIZE_AVATAR_APPEAR_DURATION_MS,
  PRIZE_AVATAR_DISAPPEAR_DURATION_MS,
  PRIZE_AVATAR_MOVE_DURATION_MS,
  PRIZE_DISPLAY_PLACES,
  PRIZE_SELECTION_AVATAR_PX,
  type BracketCardInteraction,
  type PendingPrizeAvatarAnimations,
  type PrizeSelectionDensity,
  WINNER_PODIUM_AVATAR_PX,
  WINNER_PODIUM_COLUMN_GAP,
  WINNER_PODIUM_COLUMN_W,
  WINNER_PODIUM_GAP_FROM_BRACKET,
  WINNER_PODIUM_HEIGHT,
} from "./eventLayout";
import {
  Avatar,
  AvatarFallback,
  BottomBar,
  BracketContainer,
  BracketFallbackGrid,
  BracketFallbackMatchCard,
  BracketFallbackPanel,
  BracketFallbackRound,
  BracketFallbackRoundTitle,
  BracketPlacement,
  ButtonRow,
  ClassicConnectorSvg,
  ClassicMatchCard,
  DevBracketHelper,
  DevHelperAction,
  DevHelperPanel,
  DevHelperSelect,
  DevHelperToggle,
  EndedAwardColumn,
  EndedAwardPrize,
  EndedAwardSparkles,
  EndedAwardsRow,
  MatchAvatarSlot,
  Overlay,
  OverlayStatus,
  ParticipantPill,
  ParticipantPillName,
  ParticipantsCloud,
  PrizeChoice,
  PrizeChoiceButton,
  PrizeImage,
  PrizeSelectionAvatarMotion,
  PrizeSelectionAvatarSlot,
  PrizeSelectionAvatars,
  PrizesRow,
  TopBar,
  TopBarStack,
  TopBarSubtitle,
  TopBarTitle,
  WinnerPodium,
  WinnerPodiumAvatarSlot,
  WinnerPodiumBar,
  WinnerPodiumColumn,
  WinnerPodiumPlaceLabel,
} from "./EventModal.styles";
import {
  getEndedEventWinnerPodiumEntries,
  getParticipantDisplayName,
  getParticipantProfileCacheKey,
  getPrizeAvatarScatter,
} from "./eventPresentation";
import {
  DEV_STUB_DEFAULT_PLAYERS,
  DEV_STUB_MAX_PLAYERS,
  DEV_STUB_MIN_PLAYERS,
  clampDevStubPlayerCount,
  createStubEventRecord,
} from "./devFixtures";

const getPrizeSelectionDensity = (
  avatarCount: number,
): PrizeSelectionDensity => {
  if (avatarCount <= 3) {
    return "relaxed";
  }
  if (avatarCount <= 6) {
    return "compact";
  }
  return "crowded";
};

const shouldReducePrizeAvatarMotion = (): boolean => {
  return (
    typeof window === "undefined" ||
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  );
};

const animatePrizeAvatarExit = (
  element: HTMLSpanElement,
  onComplete: () => void,
): (() => void) | null => {
  if (
    shouldReducePrizeAvatarMotion() ||
    typeof element.animate !== "function"
  ) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const clone = element.cloneNode(true) as HTMLSpanElement;
  clone.setAttribute("aria-hidden", "true");
  Object.assign(clone.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    pointerEvents: "none",
    transform: "none",
    transformOrigin: "center",
    zIndex: `${EVENT_MODAL_Z_INDEX + 3}`,
  });
  document.body.appendChild(clone);
  let animation: Animation;
  try {
    animation = clone.animate(
      [
        { opacity: 1, transform: "scale(1)" },
        { opacity: 0, transform: "scale(0.78)" },
      ],
      {
        duration: PRIZE_AVATAR_DISAPPEAR_DURATION_MS,
        easing: "ease-out",
        fill: "forwards",
      },
    );
  } catch {
    clone.remove();
    return null;
  }
  let isComplete = false;
  const complete = () => {
    if (isComplete) {
      return;
    }
    isComplete = true;
    clone.remove();
    onComplete();
  };
  animation.addEventListener("finish", complete, { once: true });
  animation.addEventListener("cancel", complete, { once: true });
  return () => {
    animation.cancel();
    complete();
  };
};

const animatePrizeAvatarPlacement = (
  element: HTMLSpanElement,
  previousRect: DOMRect | undefined,
): void => {
  if (
    shouldReducePrizeAvatarMotion() ||
    typeof element.animate !== "function"
  ) {
    return;
  }
  element.getAnimations().forEach((animation) => animation.cancel());
  const nextRect = element.getBoundingClientRect();
  if (nextRect.width <= 0 || nextRect.height <= 0) {
    return;
  }
  if (!previousRect) {
    element.animate(
      [
        { opacity: 0, transform: "scale(0.76)" },
        { opacity: 1, transform: "scale(1)" },
      ],
      {
        duration: PRIZE_AVATAR_APPEAR_DURATION_MS,
        easing: "ease-out",
      },
    );
    return;
  }
  const deltaX = previousRect.left - nextRect.left;
  const deltaY = previousRect.top - nextRect.top;
  if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
    return;
  }
  element.animate(
    [
      { transform: `translate(${deltaX}px, ${deltaY}px)` },
      { transform: "translate(0, 0)" },
    ],
    {
      duration: PRIZE_AVATAR_MOVE_DURATION_MS,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    },
  );
};

type ParticipantLookupGroup = {
  profileId: string;
  loginUid: string;
  modalState: EventModalState;
  displayName: string;
};
type ParticipantProfileCacheEntry = {
  profile: PlayerProfile;
  cachedAtMs: number;
};

const getWinnerPodiumWidth = (entryCount: number): number => {
  const normalizedEntryCount = Math.max(1, Math.round(entryCount));
  return (
    WINNER_PODIUM_COLUMN_W * normalizedEntryCount +
    WINNER_PODIUM_COLUMN_GAP * Math.max(0, normalizedEntryCount - 1)
  );
};

const getCenteredContentOffsetY = (params: {
  contentHeight: number;
  viewportHeight: number;
  insetTop: number;
  insetBottom: number;
}): number => {
  const { contentHeight, viewportHeight, insetTop, insetBottom } = params;
  const centeredBetweenBars = Math.round((insetTop - insetBottom) / 2);
  if (contentHeight <= 0) {
    return centeredBetweenBars;
  }
  const freeHalf = (viewportHeight - contentHeight) / 2;
  const minOffsetY = insetTop + BRACKET_EDGE_PADDING_Y - freeHalf;
  const maxOffsetY = freeHalf - insetBottom - BRACKET_EDGE_PADDING_Y;
  if (minOffsetY > maxOffsetY) {
    return centeredBetweenBars;
  }
  return Math.round(Math.min(Math.max(0, minOffsetY), maxOffsetY));
};

const getViewportSize = (): { width: number; height: number } => {
  if (typeof window === "undefined") {
    return { width: 1024, height: 768 };
  }
  return { width: window.innerWidth, height: window.innerHeight };
};

const EventAvatar: React.FC<{
  emojiId?: number | null;
  displayName?: string | null;
  size?: number;
  isBlocked?: boolean;
}> = ({ emojiId, displayName, size, isBlocked }) => {
  if (isBlocked) {
    return (
      <AvatarFallback $size={size} aria-hidden="true">
        ∅
      </AvatarFallback>
    );
  }
  if (typeof emojiId === "number" && Number.isFinite(emojiId)) {
    return (
      <Avatar
        $size={size}
        src={emojis.getEmojiUrl(emojiId.toString())}
        alt={displayName ?? ""}
      />
    );
  }
  return (
    <AvatarFallback $size={size} aria-hidden="true">
      ?
    </AvatarFallback>
  );
};

const EventModal: React.FC = () => {
  const [modalState, setModalState] = useState(() => getEventModalState());
  const [eventRecord, setEventRecord] = useState<EventRecord | null>(null);
  const [devStubRecord, setDevStubRecord] = useState<EventRecord | null>(null);
  const [showDevHelperPanel, setShowDevHelperPanel] = useState(false);
  const [devStubPlayerCount, setDevStubPlayerCount] = useState(
    DEV_STUB_DEFAULT_PLAYERS,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isDisqualifying, setIsDisqualifying] = useState(false);
  const [isPostponing, setIsPostponing] = useState(false);
  const [isRemovingParticipant, setIsRemovingParticipant] = useState(false);
  const [isUpdatingPrizeSelection, setIsUpdatingPrizeSelection] =
    useState(false);
  const [eventPrizeSelections, setEventPrizeSelections] =
    useState<EventPrizeSelections>({});
  const [loadedPrizeImageIds, setLoadedPrizeImageIds] = useState<
    ReadonlySet<EventPrizeId>
  >(() => new Set());
  const [endedAwardsHeight, setEndedAwardsHeight] = useState(0);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [viewportSize, setViewportSize] = useState(getViewportSize);
  const [bracketInsets, setBracketInsets] = useState({ top: 0, bottom: 0 });
  const [participantsScale, setParticipantsScale] = useState(1);
  const [participantsHeight, setParticipantsHeight] = useState(0);
  const [pendingJoinEventId, setPendingJoinEventId] = useState<string | null>(
    null,
  );
  const [pendingJoinRequestedAtMs, setPendingJoinRequestedAtMs] = useState(0);
  const activeParticipantLookupRef = useRef<ParticipantLookupGroup | null>(
    null,
  );
  const participantProfileCacheRef = useRef<
    Map<string, ParticipantProfileCacheEntry>
  >(new Map());
  const participantLookupModalStateRef = useRef(modalState);
  const ignoreNextBackdropClickRef = useRef(false);
  const ignoreBackdropMouseDownUntilMsRef = useRef(0);
  const pendingBackdropTouchDismissTouchIdRef = useRef<number | null>(null);
  const backdropGhostClickGuardCleanupRef = useRef<(() => void) | null>(null);
  const copyResetTimeoutRef = useRef<number | null>(null);
  const eventAutoRecoveryTimeoutRef = useRef<number | null>(null);
  const eventAutoRecoveryAttemptsRef = useRef<Record<string, number>>({});
  const eventAutoRecoveryLastAttemptAtMsRef = useRef<Record<string, number>>(
    {},
  );
  const eventAutoRecoveryInFlightRef = useRef<Set<string>>(new Set());
  const topBarRef = useRef<HTMLDivElement | null>(null);
  const bottomBarRef = useRef<HTMLDivElement | null>(null);
  const participantsCloudRef = useRef<HTMLDivElement | null>(null);
  const endedAwardsRowRef = useRef<HTMLDivElement | null>(null);
  const prizeSelectionAvatarRefs = useRef<Map<string, HTMLSpanElement>>(
    new Map(),
  );
  const committedPrizeSelectionsRef = useRef<EventPrizeSelections>({});
  const hasReceivedInitialPrizeSelectionsRef = useRef(false);
  const isHydratingInitialPrizeSelectionsRef = useRef(false);
  const pendingPrizeAvatarAnimationsRef =
    useRef<PendingPrizeAvatarAnimations | null>(null);
  const activePrizeAvatarExitCleanupsRef = useRef<Map<string, () => void>>(
    new Map(),
  );
  const displayedEventRecord = devStubRecord ?? eventRecord;
  const eventPrizeConfig = getEventPrizeConfig(modalState.eventId);
  const eventPrizes = eventPrizeConfig?.prizes ?? EMPTY_EVENT_PRIZES;
  const markPrizeImageLoaded = useCallback((prizeId: EventPrizeId) => {
    setLoadedPrizeImageIds((current) => {
      if (current.has(prizeId)) {
        return current;
      }
      const next = new Set(current);
      next.add(prizeId);
      return next;
    });
  }, []);
  const clearPrizeAvatarExitAnimations = useCallback(() => {
    const cleanups = Array.from(
      activePrizeAvatarExitCleanupsRef.current.values(),
    );
    activePrizeAvatarExitCleanupsRef.current.clear();
    cleanups.forEach((cleanup) => cleanup());
  }, []);
  const applyEventPrizeSelections = useCallback(
    (nextSelections: EventPrizeSelections) => {
      const previousSelections = committedPrizeSelectionsRef.current;
      if (
        !hasReceivedInitialPrizeSelectionsRef.current ||
        isHydratingInitialPrizeSelectionsRef.current
      ) {
        hasReceivedInitialPrizeSelectionsRef.current = true;
        isHydratingInitialPrizeSelectionsRef.current = true;
        pendingPrizeAvatarAnimationsRef.current = null;
        setEventPrizeSelections(nextSelections);
        return;
      }

      for (const profileId of Object.keys(nextSelections)) {
        activePrizeAvatarExitCleanupsRef.current.get(profileId)?.();
      }
      const profileIds = new Set([
        ...Object.keys(previousSelections),
        ...Object.keys(nextSelections),
      ]);
      const didChange = Array.from(profileIds).some(
        (profileId) =>
          previousSelections[profileId] !== nextSelections[profileId],
      );

      if (!didChange) {
        setEventPrizeSelections(nextSelections);
        return;
      }

      if (shouldReducePrizeAvatarMotion()) {
        pendingPrizeAvatarAnimationsRef.current = null;
        setEventPrizeSelections(nextSelections);
        return;
      }

      const previousRects = new Map<string, DOMRect>();
      for (const [profileId, element] of prizeSelectionAvatarRefs.current) {
        if (!previousSelections[profileId] || !element.isConnected) {
          continue;
        }
        previousRects.set(profileId, element.getBoundingClientRect());
        if (!nextSelections[profileId]) {
          activePrizeAvatarExitCleanupsRef.current.get(profileId)?.();
          let cleanup: (() => void) | null = null;
          cleanup = animatePrizeAvatarExit(element, () => {
            if (
              cleanup &&
              activePrizeAvatarExitCleanupsRef.current.get(profileId) ===
                cleanup
            ) {
              activePrizeAvatarExitCleanupsRef.current.delete(profileId);
            }
          });
          if (cleanup) {
            activePrizeAvatarExitCleanupsRef.current.set(profileId, cleanup);
          }
        }
      }
      const enteringProfileIds = new Set(
        Array.from(profileIds).filter(
          (profileId) =>
            !previousSelections[profileId] && !!nextSelections[profileId],
        ),
      );
      pendingPrizeAvatarAnimationsRef.current = {
        previousRects,
        enteringProfileIds,
      };
      setEventPrizeSelections(nextSelections);
    },
    [],
  );
  const invalidateParticipantLookups = useCallback(() => {
    activeParticipantLookupRef.current = null;
    participantProfileCacheRef.current.clear();
  }, []);
  const measureBracketInsets = useCallback(() => {
    const nextTop = Math.round(
      topBarRef.current?.getBoundingClientRect().height ?? 0,
    );
    const nextBottom = Math.round(
      bottomBarRef.current?.getBoundingClientRect().height ?? 0,
    );
    setBracketInsets((current) =>
      current.top === nextTop && current.bottom === nextBottom
        ? current
        : { top: nextTop, bottom: nextBottom },
    );
  }, []);

  useEffect(() => {
    const eventAutoRecoveryInFlightSet = eventAutoRecoveryInFlightRef.current;
    return () => {
      backdropGhostClickGuardCleanupRef.current?.();
      backdropGhostClickGuardCleanupRef.current = null;
      if (eventAutoRecoveryTimeoutRef.current !== null) {
        window.clearTimeout(eventAutoRecoveryTimeoutRef.current);
        eventAutoRecoveryTimeoutRef.current = null;
      }
      eventAutoRecoveryInFlightSet.clear();
    };
  }, []);

  useLayoutEffect(() => {
    return clearPrizeAvatarExitAnimations;
  }, [clearPrizeAvatarExitAnimations, modalState.eventId, modalState.isOpen]);

  useEffect(() => {
    const unsubscribe = subscribeToEventModalState((nextState) => {
      if (participantLookupModalStateRef.current !== nextState) {
        participantLookupModalStateRef.current = nextState;
        invalidateParticipantLookups();
      }
      setModalState(nextState);
    });
    return () => {
      unsubscribe();
      invalidateParticipantLookups();
    };
  }, [invalidateParticipantLookups]);

  useEffect(() => {
    if (eventAutoRecoveryTimeoutRef.current !== null) {
      window.clearTimeout(eventAutoRecoveryTimeoutRef.current);
      eventAutoRecoveryTimeoutRef.current = null;
    }
    eventAutoRecoveryAttemptsRef.current = {};
    eventAutoRecoveryLastAttemptAtMsRef.current = {};
    eventAutoRecoveryInFlightRef.current.clear();
  }, [modalState.eventId, modalState.isOpen]);

  useEffect(() => {
    setDevStubRecord(null);
    setShowDevHelperPanel(false);
  }, [modalState.eventId, modalState.isOpen]);

  useEffect(() => {
    setIsPostponing(false);
    setIsRemovingParticipant(false);
  }, [modalState.eventId, modalState.isOpen]);

  useEffect(() => {
    const eventId = modalState.eventId;
    if (!modalState.isOpen || !eventId) {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current);
        copyResetTimeoutRef.current = null;
      }
      setEventRecord(null);
      setCopyState("idle");
      setIsLoading(false);
      setIsDisqualifying(false);
      setIsPostponing(false);
      setIsRemovingParticipant(false);
      setPendingJoinEventId(null);
      setPendingJoinRequestedAtMs(0);
      ignoreNextBackdropClickRef.current = false;
      ignoreBackdropMouseDownUntilMsRef.current = 0;
      pendingBackdropTouchDismissTouchIdRef.current = null;
      return;
    }

    setIsLoading(true);
    let isDisposed = false;
    let retryAttempt = 0;
    let retryTimeoutId: number | null = null;
    let unsubscribe: (() => void) | null = null;

    const clearRetryTimeout = () => {
      if (retryTimeoutId === null) {
        return;
      }
      window.clearTimeout(retryTimeoutId);
      retryTimeoutId = null;
    };

    const attachSubscription = () => {
      if (isDisposed) {
        return;
      }
      unsubscribe?.();
      unsubscribe = connection.subscribeToEvent(
        eventId,
        (nextEvent) => {
          setEventRecord(nextEvent);
          setIsLoading(false);
          retryAttempt = 0;
          clearRetryTimeout();
        },
        () => {
          if (isDisposed) {
            return;
          }
          setIsLoading(false);
          if (
            retryTimeoutId !== null ||
            retryAttempt >= EVENT_SUBSCRIBE_RETRY_DELAYS_MS.length
          ) {
            return;
          }
          const delayMs = EVENT_SUBSCRIBE_RETRY_DELAYS_MS[retryAttempt];
          retryAttempt += 1;
          retryTimeoutId = window.setTimeout(() => {
            retryTimeoutId = null;
            setIsLoading(true);
            attachSubscription();
          }, delayMs);
        },
      );
    };

    attachSubscription();

    return () => {
      isDisposed = true;
      clearRetryTimeout();
      unsubscribe?.();
    };
  }, [modalState.eventId, modalState.isOpen]);

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current);
        copyResetTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!modalState.isOpen || typeof window === "undefined") {
      return;
    }

    let isDisposed = false;
    let timeoutId: number | null = null;

    const scheduleNextTick = () => {
      if (isDisposed) {
        return;
      }
      const currentNowMs = Date.now();
      setNowMs(currentNowMs);
      timeoutId = window.setTimeout(
        scheduleNextTick,
        getEventNowRefreshDelayMs(
          displayedEventRecord?.status ?? null,
          displayedEventRecord?.startAtMs ?? null,
          currentNowMs,
        ),
      );
    };

    scheduleNextTick();

    return () => {
      isDisposed = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    displayedEventRecord?.eventId,
    displayedEventRecord?.startAtMs,
    displayedEventRecord?.status,
    modalState.eventId,
    modalState.isOpen,
  ]);

  useEffect(() => {
    clearPrizeAvatarExitAnimations();
    committedPrizeSelectionsRef.current = {};
    hasReceivedInitialPrizeSelectionsRef.current = false;
    isHydratingInitialPrizeSelectionsRef.current = false;
    pendingPrizeAvatarAnimationsRef.current = null;
    setEventPrizeSelections({});
    setLoadedPrizeImageIds(new Set());
    setIsUpdatingPrizeSelection(false);
    if (!modalState.isOpen || !modalState.eventId || !eventPrizeConfig) {
      return;
    }
    return connection.subscribeToEventPrizeSelections(
      modalState.eventId,
      applyEventPrizeSelections,
      (error) => {
        console.error("Error subscribing to event prize selections:", error);
      },
    );
  }, [
    applyEventPrizeSelections,
    clearPrizeAvatarExitAnimations,
    eventPrizeConfig,
    modalState.eventId,
    modalState.isOpen,
  ]);

  useEffect(() => {
    if (!modalState.isOpen || typeof window === "undefined") {
      return;
    }
    if (!modalState.eventId || !eventRecord || devStubRecord) {
      if (eventAutoRecoveryTimeoutRef.current !== null) {
        window.clearTimeout(eventAutoRecoveryTimeoutRef.current);
        eventAutoRecoveryTimeoutRef.current = null;
      }
      return;
    }
    if (eventRecord.eventId !== modalState.eventId) {
      return;
    }
    const autoRecoveryReason = getEventAutoRecoveryReason(eventRecord, nowMs);
    if (!autoRecoveryReason) {
      if (eventAutoRecoveryTimeoutRef.current !== null) {
        window.clearTimeout(eventAutoRecoveryTimeoutRef.current);
        eventAutoRecoveryTimeoutRef.current = null;
      }
      return;
    }
    const canAttemptRecovery =
      autoRecoveryReason === "ended-missing-prize-assignments"
        ? isLocalEventParticipant(eventRecord)
        : isLocalEventCreator(eventRecord);
    if (!canAttemptRecovery) {
      return;
    }

    const attemptKey = `${eventRecord.eventId}:${autoRecoveryReason}`;
    const attempts = eventAutoRecoveryAttemptsRef.current[attemptKey] ?? 0;
    if (attempts >= EVENT_AUTO_RECOVERY_MAX_ATTEMPTS_PER_REASON) {
      return;
    }
    if (eventAutoRecoveryInFlightRef.current.has(attemptKey)) {
      return;
    }
    const lastAttemptAtMs =
      eventAutoRecoveryLastAttemptAtMsRef.current[attemptKey] ?? 0;
    if (Date.now() - lastAttemptAtMs < EVENT_AUTO_RECOVERY_MIN_GAP_MS) {
      return;
    }

    if (eventAutoRecoveryTimeoutRef.current !== null) {
      window.clearTimeout(eventAutoRecoveryTimeoutRef.current);
    }

    const targetEventId = eventRecord.eventId;
    eventAutoRecoveryTimeoutRef.current = window.setTimeout(() => {
      eventAutoRecoveryTimeoutRef.current = null;

      const inFlightSet = eventAutoRecoveryInFlightRef.current;
      if (inFlightSet.has(attemptKey)) {
        return;
      }

      const currentAttempts =
        eventAutoRecoveryAttemptsRef.current[attemptKey] ?? 0;
      if (currentAttempts >= EVENT_AUTO_RECOVERY_MAX_ATTEMPTS_PER_REASON) {
        return;
      }

      eventAutoRecoveryAttemptsRef.current[attemptKey] = currentAttempts + 1;
      eventAutoRecoveryLastAttemptAtMsRef.current[attemptKey] = Date.now();
      inFlightSet.add(attemptKey);

      void connection
        .syncEventState(targetEventId)
        .catch(() => {})
        .finally(() => {
          inFlightSet.delete(attemptKey);
        });
    }, EVENT_AUTO_RECOVERY_DELAY_MS);

    return () => {
      if (eventAutoRecoveryTimeoutRef.current !== null) {
        window.clearTimeout(eventAutoRecoveryTimeoutRef.current);
        eventAutoRecoveryTimeoutRef.current = null;
      }
    };
  }, [
    devStubRecord,
    eventRecord,
    modalState.eventId,
    modalState.isOpen,
    nowMs,
  ]);

  useEffect(() => {
    if (!modalState.isOpen || typeof window === "undefined") {
      return;
    }

    const handleViewportResize = () => {
      const next = getViewportSize();
      setViewportSize((current) =>
        current.width === next.width && current.height === next.height
          ? current
          : next,
      );
    };

    handleViewportResize();
    window.addEventListener("resize", handleViewportResize);
    window.visualViewport?.addEventListener("resize", handleViewportResize);
    return () => {
      window.removeEventListener("resize", handleViewportResize);
      window.visualViewport?.removeEventListener(
        "resize",
        handleViewportResize,
      );
    };
  }, [modalState.isOpen]);

  useLayoutEffect(() => {
    if (!modalState.isOpen || typeof window === "undefined") {
      return;
    }
    measureBracketInsets();
  });

  useLayoutEffect(() => {
    const el = participantsCloudRef.current;
    if (!el) {
      setParticipantsScale(1);
      setParticipantsHeight(0);
      return;
    }
    const naturalW = el.scrollWidth;
    const naturalH = el.scrollHeight;
    if (naturalW <= 0 || naturalH <= 0) {
      return;
    }
    const reservedTop = bracketInsets.top + BRACKET_EDGE_PADDING_Y;
    const reservedBottom = bracketInsets.bottom + BRACKET_EDGE_PADDING_Y;
    const availW = Math.max(1, viewportSize.width - BRACKET_EDGE_PADDING_X * 2);
    const availH = Math.max(
      1,
      viewportSize.height - reservedTop - reservedBottom,
    );
    const sx = availW / naturalW;
    const sy = availH / naturalH;
    let scale = Math.min(1, sx, sy);
    if (!Number.isFinite(scale)) scale = 1;
    scale = Math.max(0.4, scale);
    setParticipantsScale((prev) =>
      Math.abs(prev - scale) < 0.002 ? prev : scale,
    );
    const scaledHeight = naturalH * scale;
    setParticipantsHeight((prev) =>
      Math.abs(prev - scaledHeight) < 1 ? prev : scaledHeight,
    );
  }, [
    bracketInsets.top,
    bracketInsets.bottom,
    displayedEventRecord?.participants,
    modalState.eventId,
    modalState.isOpen,
    viewportSize.width,
    viewportSize.height,
  ]);

  useEffect(() => {
    if (!modalState.isOpen || typeof window === "undefined") {
      return;
    }

    let rafId = 0;
    const scheduleMeasureInsets = () => {
      if (rafId !== 0) {
        return;
      }
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        measureBracketInsets();
      });
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            scheduleMeasureInsets();
          });

    if (resizeObserver) {
      if (topBarRef.current) {
        resizeObserver.observe(topBarRef.current);
      }
      if (bottomBarRef.current) {
        resizeObserver.observe(bottomBarRef.current);
      }
    }

    window.addEventListener("resize", scheduleMeasureInsets);
    window.visualViewport?.addEventListener("resize", scheduleMeasureInsets);

    return () => {
      if (rafId !== 0) {
        window.cancelAnimationFrame(rafId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasureInsets);
      window.visualViewport?.removeEventListener(
        "resize",
        scheduleMeasureInsets,
      );
    };
  }, [measureBracketInsets, modalState.isOpen]);

  useEffect(() => {
    if (
      !modalState.isOpen ||
      !modalState.eventId ||
      pendingJoinEventId !== modalState.eventId
    ) {
      return;
    }
    const requestedAtMs =
      pendingJoinRequestedAtMs > 0 ? pendingJoinRequestedAtMs : Date.now();
    const intervalId = window.setInterval(() => {
      if (Date.now() - requestedAtMs >= PENDING_JOIN_POLL_TIMEOUT_MS) {
        setPendingJoinEventId(null);
        setPendingJoinRequestedAtMs(0);
        return;
      }
      if (storage.getProfileId("") === "") {
        return;
      }
      const eventId = pendingJoinEventId;
      setPendingJoinEventId(null);
      setPendingJoinRequestedAtMs(0);
      if (!eventId) {
        return;
      }
      setIsLoading(true);
      void connection
        .joinEvent(eventId)
        .catch(() => {})
        .finally(() => {
          setIsLoading(false);
        });
    }, PENDING_JOIN_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    modalState.eventId,
    modalState.isOpen,
    pendingJoinEventId,
    pendingJoinRequestedAtMs,
  ]);

  const participantsById = useMemo(
    () => displayedEventRecord?.participants ?? {},
    [displayedEventRecord],
  );
  const participants = useMemo(
    () => getSortedParticipants(displayedEventRecord),
    [displayedEventRecord],
  );
  useLayoutEffect(() => {
    committedPrizeSelectionsRef.current = eventPrizeSelections;
    isHydratingInitialPrizeSelectionsRef.current = false;
    const pendingAnimations = pendingPrizeAvatarAnimationsRef.current;
    if (!pendingAnimations) {
      return;
    }

    const profileIds = new Set([
      ...pendingAnimations.previousRects.keys(),
      ...pendingAnimations.enteringProfileIds,
    ]);
    const remainingPreviousRects = new Map<string, DOMRect>();
    const remainingEnteringProfileIds = new Set<string>();

    for (const profileId of profileIds) {
      if (!eventPrizeSelections[profileId]) {
        continue;
      }
      const previousRect = pendingAnimations.previousRects.get(profileId);
      const isEntering =
        pendingAnimations.enteringProfileIds.has(profileId) && !previousRect;
      const element = prizeSelectionAvatarRefs.current.get(profileId);
      if (!element?.isConnected) {
        if (previousRect) {
          remainingPreviousRects.set(profileId, previousRect);
        }
        if (isEntering) {
          remainingEnteringProfileIds.add(profileId);
        }
        continue;
      }
      animatePrizeAvatarPlacement(
        element,
        isEntering ? undefined : previousRect,
      );
    }

    pendingPrizeAvatarAnimationsRef.current =
      remainingPreviousRects.size > 0 || remainingEnteringProfileIds.size > 0
        ? {
            previousRects: remainingPreviousRects,
            enteringProfileIds: remainingEnteringProfileIds,
          }
        : null;
  }, [eventPrizeSelections, loadedPrizeImageIds, participants]);
  const removableScheduledParticipants = useMemo(() => {
    if (!eventRecord || eventRecord.status !== "scheduled") {
      return [];
    }
    if (nowMs >= eventRecord.startAtMs || !isLocalEventCreator(eventRecord)) {
      return [];
    }
    const creatorProfileId = eventRecord.createdByProfileId?.trim() ?? "";
    const creatorLoginUid = eventRecord.createdByLoginUid?.trim() ?? "";
    return getSortedParticipants(eventRecord).filter((participant) => {
      const profileId = participant.profileId?.trim() ?? "";
      const loginUid = participant.loginUid?.trim() ?? "";
      if (!profileId) {
        return false;
      }
      if (creatorProfileId && profileId === creatorProfileId) {
        return false;
      }
      if (creatorLoginUid && loginUid === creatorLoginUid) {
        return false;
      }
      return true;
    });
  }, [eventRecord, nowMs]);
  const rounds = useMemo(
    () => getSortedRounds(displayedEventRecord),
    [displayedEventRecord],
  );
  const eventPrizeAssignments = useMemo(
    () =>
      PRIZE_DISPLAY_PLACES.flatMap((place) => {
        const assignment = displayedEventRecord?.prizeAssignments?.[`${place}`];
        return assignment ? [assignment] : [];
      }),
    [displayedEventRecord],
  );
  const displayedEventPrizes = useMemo(() => {
    if (
      displayedEventRecord?.status !== "ended" ||
      eventPrizeAssignments.length === 0
    ) {
      return eventPrizes.map((prize) => ({
        prize,
        assignment: null as EventPrizeAssignment | null,
      }));
    }
    const assignedPrizeIds = new Set<EventPrizeId>();
    const orderedAssignedPrizes = eventPrizeAssignments.flatMap(
      (assignment) => {
        const prize = eventPrizes.find(
          (candidate) => candidate.id === assignment.prizeId,
        );
        if (!prize || assignedPrizeIds.has(prize.id)) {
          return [];
        }
        assignedPrizeIds.add(prize.id);
        return [{ prize, assignment }];
      },
    );
    return [
      ...orderedAssignedPrizes,
      ...eventPrizes
        .filter((prize) => !assignedPrizeIds.has(prize.id))
        .map((prize) => ({
          prize,
          assignment: null as EventPrizeAssignment | null,
        })),
    ];
  }, [displayedEventRecord?.status, eventPrizeAssignments, eventPrizes]);
  const currentProfileId = storage.getProfileId("");
  const eventUiState = useMemo(
    () => getCurrentUiState(displayedEventRecord, currentProfileId),
    [currentProfileId, displayedEventRecord],
  );
  const watchableMatch = useMemo(
    () =>
      getWatchableMatch(displayedEventRecord, currentProfileId, eventUiState),
    [currentProfileId, displayedEventRecord, eventUiState],
  );
  const currentUsername = storage.getUsername("").trim().toLowerCase();
  const canManageDisqualifications = isMonsLinkAdmin(currentUsername);
  const livePendingMatches = useMemo(
    () => getActivePendingMatches(eventRecord),
    [eventRecord],
  );
  const currentRoute = getCurrentRouteState();

  const handlePrizeSelectionClick = useCallback(
    (prizeId: string) => {
      if (
        isUpdatingPrizeSelection ||
        devStubRecord ||
        !eventPrizeConfig ||
        !currentProfileId ||
        !eventRecord?.participants[currentProfileId] ||
        eventRecord.prizeSelectionsLockedAtMs != null ||
        (eventRecord.status !== "scheduled" && eventRecord.status !== "active")
      ) {
        return;
      }
      setIsUpdatingPrizeSelection(true);
      void connection
        .toggleEventPrizeSelection(eventPrizeConfig.eventId, prizeId)
        .catch(() => {})
        .finally(() => {
          setIsUpdatingPrizeSelection(false);
        });
    },
    [
      currentProfileId,
      devStubRecord,
      eventRecord,
      eventPrizeConfig,
      isUpdatingPrizeSelection,
    ],
  );

  useEffect(() => {
    if (displayedEventRecord?.status === "dismissed") {
      setShowDevHelperPanel(false);
    }
  }, [displayedEventRecord]);

  const canRenderBracket = useMemo(
    () => canRenderSymmetricalBracket(rounds),
    [rounds],
  );
  const bracketLayout = useMemo(() => {
    if (!canRenderBracket) {
      return null;
    }
    return computeSymmetricalBracket(rounds);
  }, [canRenderBracket, rounds]);
  const thirdPlaceMatch = useMemo(
    () => getThirdPlaceMatch(displayedEventRecord),
    [displayedEventRecord],
  );
  const thirdPlaceLayout = useMemo<ThirdPlaceMatchLayout | null>(() => {
    if (!bracketLayout || !thirdPlaceMatch) {
      return null;
    }
    const finalPosition =
      bracketLayout.positions.find((position) => position.key === "FINAL") ??
      null;
    if (!finalPosition) {
      return null;
    }

    const width = BRACKET_THIRD_PLACE_MATCH_W;
    const height = BRACKET_THIRD_PLACE_MATCH_H;
    const x = Math.round(finalPosition.x + (finalPosition.width - width) / 2);
    const y = finalPosition.y + finalPosition.height + BRACKET_THIRD_PLACE_GAP;

    return {
      x,
      y,
      width,
      height,
      bottom: y + height,
      match: thirdPlaceMatch,
    };
  }, [bracketLayout, thirdPlaceMatch]);
  const resolvedWinnerPodiumEntries = useMemo(
    () =>
      getEndedEventWinnerPodiumEntries(
        displayedEventRecord,
        rounds,
        participantsById,
      ),
    [displayedEventRecord, rounds, participantsById],
  );
  const winnerPodiumEntries = useMemo(() => {
    if (eventPrizeAssignments.length > 0) {
      const assignedEntries = eventPrizeAssignments.flatMap((assignment) => {
        const participant = participantsById[assignment.profileId];
        return participant
          ? [
              {
                place: assignment.place,
                participant,
              },
            ]
          : [];
      });
      if (assignedEntries.length > 0) {
        return assignedEntries;
      }
    }
    return resolvedWinnerPodiumEntries;
  }, [eventPrizeAssignments, participantsById, resolvedWinnerPodiumEntries]);
  const showWinnerPodium = !!(
    bracketLayout &&
    displayedEventRecord?.status === "ended" &&
    winnerPodiumEntries.length > 0
  );
  const endedAwardEntries = useMemo(
    () =>
      PRIZE_DISPLAY_PLACES.flatMap((place) => {
        const assignment = eventPrizeAssignments.find(
          (candidate) => candidate.place === place,
        );
        if (!assignment) {
          return [];
        }
        const prize = eventPrizes.find(
          (candidate) => candidate.id === assignment.prizeId,
        );
        const participant = participantsById[assignment.profileId];
        return prize && participant ? [{ assignment, prize, participant }] : [];
      }),
    [eventPrizeAssignments, eventPrizes, participantsById],
  );
  const expectedEndedAwardCount = Math.min(
    eventPrizes.length,
    resolvedWinnerPodiumEntries.length,
  );
  const showEndedAwards = !!(
    modalState.isOpen &&
    showWinnerPodium &&
    expectedEndedAwardCount > 0 &&
    eventPrizeAssignments.length === expectedEndedAwardCount &&
    endedAwardEntries.length === expectedEndedAwardCount &&
    endedAwardEntries.every(
      ({ assignment }) => assignment.place <= expectedEndedAwardCount,
    )
  );
  const showBracketWinnerPodium = showWinnerPodium && !showEndedAwards;

  useLayoutEffect(() => {
    if (!showEndedAwards) {
      setEndedAwardsHeight((current) => (current === 0 ? current : 0));
      return;
    }
    const element = endedAwardsRowRef.current;
    if (!element) {
      return;
    }
    const measure = () => {
      const nextHeight = Math.round(element.getBoundingClientRect().height);
      setEndedAwardsHeight((current) =>
        current === nextHeight ? current : nextHeight,
      );
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    resizeObserver?.observe(element);
    measure();
    return () => resizeObserver?.disconnect();
  }, [showEndedAwards]);

  const endedAwardsReservedHeight = showEndedAwards
    ? endedAwardsHeight + WINNER_PODIUM_GAP_FROM_BRACKET
    : 0;
  const winnerPodiumWidth = getWinnerPodiumWidth(winnerPodiumEntries.length);
  const bracketContentHeight = bracketLayout
    ? Math.max(bracketLayout.height, thirdPlaceLayout?.bottom ?? 0)
    : 0;
  const bracketFrameWidth = bracketLayout
    ? Math.max(
        bracketLayout.width,
        showBracketWinnerPodium ? winnerPodiumWidth : 0,
      )
    : 0;
  const bracketFrameHeight = bracketLayout
    ? bracketContentHeight +
      (showBracketWinnerPodium
        ? WINNER_PODIUM_HEIGHT + WINNER_PODIUM_GAP_FROM_BRACKET
        : 0)
    : 0;
  const bracketContentOffsetX = bracketLayout
    ? Math.round((bracketFrameWidth - bracketLayout.width) / 2)
    : 0;
  const bracketContentOffsetY = showBracketWinnerPodium
    ? WINNER_PODIUM_HEIGHT + WINNER_PODIUM_GAP_FROM_BRACKET
    : 0;
  const winnerPodiumOffsetX = Math.round(
    (bracketFrameWidth - winnerPodiumWidth) / 2,
  );

  const bracketFallbackRounds = useMemo(() => {
    return rounds
      .map((round, roundOffset) => {
        const matches = getSortedMatches(round);
        if (matches.length === 0) {
          return null;
        }
        const label =
          rounds.length === 1
            ? "match"
            : roundOffset === rounds.length - 1
              ? "final"
              : `round ${roundOffset + 1}`;
        return {
          key: `round_${round.roundIndex}_${roundOffset}`,
          label,
          matches,
        };
      })
      .filter(
        (
          item,
        ): item is {
          key: string;
          label: string;
          matches: EventMatch[];
        } => item !== null,
      );
  }, [rounds]);

  const bracketScale = useMemo(() => {
    if (!bracketLayout) return 1;

    const reservedTop = bracketInsets.top + BRACKET_EDGE_PADDING_Y;
    const reservedBottom = bracketInsets.bottom + BRACKET_EDGE_PADDING_Y;
    const availW = Math.max(1, viewportSize.width - BRACKET_EDGE_PADDING_X * 2);
    const availH = Math.max(
      1,
      viewportSize.height -
        reservedTop -
        reservedBottom -
        endedAwardsReservedHeight,
    );
    const sx = availW / Math.max(1, bracketFrameWidth);
    const sy = availH / Math.max(1, bracketFrameHeight);
    const scale = Math.min(1, sx, sy);
    return Number.isFinite(scale) ? Math.max(0, scale) : 1;
  }, [
    bracketFrameHeight,
    bracketFrameWidth,
    bracketLayout,
    bracketInsets.bottom,
    bracketInsets.top,
    endedAwardsReservedHeight,
    viewportSize.height,
    viewportSize.width,
  ]);
  const isJoinWindowOpen =
    !!displayedEventRecord &&
    displayedEventRecord.status === "scheduled" &&
    nowMs < displayedEventRecord.startAtMs;

  const shouldKeepVisibleForOutsideDismiss = useCallback(() => {
    const hasShinyCardElement =
      typeof document !== "undefined" &&
      document.querySelector('[data-shiny-card="true"]') !== null;
    return (
      showsShinyCardSomewhere ||
      hasShinyCardElement ||
      !didNotDismissAnythingWithOutsideTapJustNow()
    );
  }, []);

  const guardBackdropGhostClick = useCallback(
    (clientX: number, clientY: number) => {
      if (typeof document === "undefined" || typeof window === "undefined") {
        return;
      }
      backdropGhostClickGuardCleanupRef.current?.();
      const guardStartedAtMs = Date.now();
      const maxGuardMs = 320;
      const maxDistancePx = 28;
      const maxDistanceSq = maxDistancePx * maxDistancePx;
      let timeoutId: number | null = null;
      const cleanup = () => {
        document.removeEventListener("click", handleClickGuard, true);
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (backdropGhostClickGuardCleanupRef.current === cleanup) {
          backdropGhostClickGuardCleanupRef.current = null;
        }
      };
      const handleClickGuard = (event: MouseEvent) => {
        const elapsedMs = Date.now() - guardStartedAtMs;
        const dx = event.clientX - clientX;
        const dy = event.clientY - clientY;
        if (elapsedMs <= maxGuardMs && dx * dx + dy * dy <= maxDistanceSq) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
        }
        cleanup();
      };
      backdropGhostClickGuardCleanupRef.current = cleanup;
      document.addEventListener("click", handleClickGuard, true);
      timeoutId = window.setTimeout(cleanup, maxGuardMs);
    },
    [],
  );

  const handleBackdropPointerDown = useCallback(
    (
      event:
        React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>,
    ) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      const nowMs = Date.now();
      if (event.type === "touchstart") {
        ignoreBackdropMouseDownUntilMsRef.current = nowMs + 1200;
        const shouldKeepVisible = shouldKeepVisibleForOutsideDismiss();
        ignoreNextBackdropClickRef.current = shouldKeepVisible;
        if (showDevHelperPanel) {
          pendingBackdropTouchDismissTouchIdRef.current = null;
          ignoreNextBackdropClickRef.current = false;
          setShowDevHelperPanel(false);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (shouldKeepVisible) {
          pendingBackdropTouchDismissTouchIdRef.current = null;
          return;
        }
        const touchEvent = event as React.TouchEvent<HTMLDivElement>;
        const dismissTouch =
          touchEvent.changedTouches[0] || touchEvent.touches[0];
        pendingBackdropTouchDismissTouchIdRef.current =
          typeof dismissTouch?.identifier === "number"
            ? dismissTouch.identifier
            : -1;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (
        event.type === "mousedown" &&
        nowMs <= ignoreBackdropMouseDownUntilMsRef.current
      ) {
        return;
      }
      ignoreNextBackdropClickRef.current = shouldKeepVisibleForOutsideDismiss();
    },
    [showDevHelperPanel, shouldKeepVisibleForOutsideDismiss],
  );

  const handleBackdropTouchEnd = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const pendingTouchId = pendingBackdropTouchDismissTouchIdRef.current;
      if (pendingTouchId === null) {
        return;
      }
      let matchedTouchPoint: { clientX: number; clientY: number } | null = null;
      if (pendingTouchId === -1) {
        const touch = event.changedTouches[0];
        matchedTouchPoint = touch
          ? { clientX: touch.clientX, clientY: touch.clientY }
          : null;
      } else {
        for (let i = 0; i < event.changedTouches.length; i++) {
          const touch = event.changedTouches[i];
          if (touch.identifier === pendingTouchId) {
            matchedTouchPoint = {
              clientX: touch.clientX,
              clientY: touch.clientY,
            };
            break;
          }
        }
      }
      if (!matchedTouchPoint) {
        return;
      }
      pendingBackdropTouchDismissTouchIdRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      guardBackdropGhostClick(
        matchedTouchPoint.clientX,
        matchedTouchPoint.clientY,
      );
      didDismissSomethingWithOutsideTapJustNow();
      void closeEventModal();
    },
    [guardBackdropGhostClick],
  );

  const handleBackdropTouchCancel = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const pendingTouchId = pendingBackdropTouchDismissTouchIdRef.current;
      if (pendingTouchId === null) {
        return;
      }
      if (pendingTouchId === -1) {
        pendingBackdropTouchDismissTouchIdRef.current = null;
        return;
      }
      for (let i = 0; i < event.changedTouches.length; i++) {
        if (event.changedTouches[i].identifier === pendingTouchId) {
          pendingBackdropTouchDismissTouchIdRef.current = null;
          break;
        }
      }
    },
    [],
  );

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      if (Date.now() <= ignoreBackdropMouseDownUntilMsRef.current) {
        ignoreNextBackdropClickRef.current = false;
        return;
      }
      if (showDevHelperPanel) {
        ignoreNextBackdropClickRef.current = false;
        setShowDevHelperPanel(false);
        return;
      }
      const shouldKeepVisibleForOutsideDismissNow =
        ignoreNextBackdropClickRef.current ||
        shouldKeepVisibleForOutsideDismiss();
      ignoreNextBackdropClickRef.current = false;
      if (shouldKeepVisibleForOutsideDismissNow) {
        return;
      }
      didDismissSomethingWithOutsideTapJustNow();
      void closeEventModal();
    },
    [showDevHelperPanel, shouldKeepVisibleForOutsideDismiss],
  );

  const copyEventLinkToClipboard = useCallback(() => {
    if (!modalState.eventId || typeof window === "undefined") {
      return;
    }
    connection.writeEventLinkToClipboard(modalState.eventId);
    setCopyState("copied");
    if (copyResetTimeoutRef.current !== null) {
      window.clearTimeout(copyResetTimeoutRef.current);
    }
    copyResetTimeoutRef.current = window.setTimeout(() => {
      copyResetTimeoutRef.current = null;
      setCopyState("idle");
    }, 1200);
  }, [modalState.eventId]);

  const handleCopyClick = useCallback(() => {
    copyEventLinkToClipboard();
  }, [copyEventLinkToClipboard]);

  const handleShareClick = useCallback(async () => {
    if (!modalState.eventId || typeof window === "undefined") {
      return;
    }
    const link = `${window.location.origin}/event/${modalState.eventId}`;
    const shareData = {
      url: link,
      title: "Play Mons",
    };
    if (typeof navigator.share !== "function") {
      copyEventLinkToClipboard();
      return;
    }
    if (typeof navigator.canShare === "function") {
      let canShareData = false;
      try {
        canShareData = navigator.canShare(shareData);
      } catch {
        canShareData = false;
      }
      if (!canShareData) {
        copyEventLinkToClipboard();
        return;
      }
    }
    try {
      await navigator.share(shareData);
    } catch (error) {
      const errorName =
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        typeof (error as { name?: unknown }).name === "string"
          ? (error as { name: string }).name
          : "";
      if (errorName === "AbortError") {
        return;
      }
      copyEventLinkToClipboard();
    }
  }, [copyEventLinkToClipboard, modalState.eventId]);

  const handleJoinClick = useCallback(() => {
    if (!modalState.eventId) {
      return;
    }
    if (storage.getProfileId("") === "") {
      setPendingJoinEventId(modalState.eventId);
      setPendingJoinRequestedAtMs(Date.now());
      openProfileSignInPopupForEvent();
      return;
    }
    setPendingJoinEventId(null);
    setPendingJoinRequestedAtMs(0);
    setIsLoading(true);
    void connection
      .joinEvent(modalState.eventId)
      .catch(() => {})
      .finally(() => {
        setIsLoading(false);
      });
  }, [modalState.eventId]);

  const openMatch = useCallback(
    async (inviteId: string) => {
      if (!inviteId) {
        return;
      }
      await closeEventModal({
        skipHomeTransition: true,
        reason: "launch_game",
      });
      if (
        currentRoute.mode === "invite" &&
        currentRoute.inviteId === inviteId
      ) {
        return;
      }
      connection.connectToInvite(inviteId);
    },
    [currentRoute.inviteId, currentRoute.mode],
  );

  const resolveParticipantProfile = useCallback(
    async (participant: EventParticipant) => {
      const cachedProfile = participant.loginUid
        ? getStashedPlayerProfile(participant.loginUid)
        : undefined;
      if (cachedProfile && cachedProfile.id === participant.profileId) {
        return cachedProfile;
      }
      const profileCacheKey = getParticipantProfileCacheKey(participant);
      const eventCachedProfile = profileCacheKey
        ? participantProfileCacheRef.current.get(profileCacheKey)
        : undefined;
      if (
        eventCachedProfile &&
        Date.now() - eventCachedProfile.cachedAtMs <=
          PARTICIPANT_PROFILE_CACHE_TTL_MS
      ) {
        return eventCachedProfile.profile;
      }
      if (profileCacheKey) {
        participantProfileCacheRef.current.delete(profileCacheKey);
      }
      let profileById: PlayerProfile | null = null;
      if (participant.profileId) {
        try {
          profileById = await connection.getProfileById(participant.profileId);
        } catch (error) {
          if (!participant.loginUid) {
            throw error;
          }
        }
      }
      if (profileById) {
        return profileById;
      }
      const exactProfile = participant.loginUid
        ? await connection.getProfileByLoginId(participant.loginUid)
        : null;
      return exactProfile ?? null;
    },
    [],
  );

  const handleParticipantClick = useCallback(
    async (participant: EventParticipant) => {
      const lookupModalState = getEventModalState();
      const isCurrentModalRender = lookupModalState === modalState;
      const participantKey = participant.profileId || participant.loginUid;
      if (
        !participantKey ||
        !isCurrentModalRender ||
        !lookupModalState.isOpen ||
        !lookupModalState.eventId
      ) {
        return;
      }
      const displayName = getParticipantDisplayName(participant);
      const profileCacheKey = getParticipantProfileCacheKey(participant);
      let lookupGroup = activeParticipantLookupRef.current;
      if (
        !lookupGroup ||
        lookupGroup.profileId !== participant.profileId ||
        lookupGroup.loginUid !== participant.loginUid ||
        lookupGroup.modalState !== lookupModalState
      ) {
        lookupGroup = {
          profileId: participant.profileId,
          loginUid: participant.loginUid,
          modalState: lookupModalState,
          displayName,
        };
        activeParticipantLookupRef.current = lookupGroup;
      } else {
        lookupGroup.displayName = displayName;
      }
      try {
        const profile = await resolveParticipantProfile(participant);
        if (
          !profile ||
          activeParticipantLookupRef.current !== lookupGroup ||
          getEventModalState() !== lookupGroup.modalState
        ) {
          return;
        }
        const profileCacheEntry = {
          profile,
          cachedAtMs: Date.now(),
        };
        participantProfileCacheRef.current.set(
          profileCacheKey,
          profileCacheEntry,
        );
        if (profile.id) {
          participantProfileCacheRef.current.set(
            `profile:${profile.id}`,
            profileCacheEntry,
          );
        }
        activeParticipantLookupRef.current = null;
        await showShinyCard(profile, lookupGroup.displayName, true);
      } catch {}
    },
    [modalState, resolveParticipantProfile],
  );

  const handleBracketMatchAction = useCallback(
    (action: BracketMatchAction) => {
      if (action.kind === "game") {
        void openMatch(action.inviteId);
        return;
      }
      if (action.kind === "participant") {
        void handleParticipantClick(action.participant);
      }
    },
    [handleParticipantClick, openMatch],
  );

  const handleDisqualifyClick = useCallback(() => {
    if (
      !canManageDisqualifications ||
      !modalState.eventId ||
      !eventRecord ||
      eventRecord.status !== "active" ||
      devStubRecord ||
      isDisqualifying
    ) {
      return;
    }

    const activeMatches = getActivePendingMatches(eventRecord);
    if (activeMatches.length <= 0) {
      return;
    }

    const selectionLines = activeMatches.map(({ label, match }, index) => {
      const hostLabel = getMatchSideLabel(match, "host");
      const guestLabel = getMatchSideLabel(match, "guest");
      return `${index + 1}. ${label}: ${hostLabel} vs ${guestLabel}`;
    });
    const rawSelection = window.prompt(
      `Select active game to disqualify:\n${selectionLines.join("\n")}`,
      "1",
    );
    if (!rawSelection) {
      return;
    }
    const selectedIndex = Math.floor(Number(rawSelection)) - 1;
    const selected = activeMatches[selectedIndex];
    if (!selected) {
      return;
    }

    const hostLabel = getMatchSideLabel(selected.match, "host");
    const guestLabel = getMatchSideLabel(selected.match, "guest");
    const didConfirm = window.confirm(
      `disqualify ${hostLabel} and ${guestLabel}?`,
    );
    if (!didConfirm) {
      return;
    }

    setIsDisqualifying(true);
    void connection
      .disqualifyEventMatchWinners(modalState.eventId, selected.match.matchKey)
      .catch((error) => {
        const rawMessage =
          typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof (error as { message?: unknown }).message === "string"
            ? (error as { message: string }).message.trim()
            : "";
        window.alert(
          rawMessage ||
            "Failed to disqualify selected match. Please try again.",
        );
      })
      .finally(() => {
        setIsDisqualifying(false);
      });
  }, [
    canManageDisqualifications,
    devStubRecord,
    eventRecord,
    isDisqualifying,
    modalState.eventId,
  ]);

  const handlePostponeClick = useCallback(() => {
    if (
      !modalState.eventId ||
      !eventRecord ||
      devStubRecord ||
      eventRecord.status !== "scheduled" ||
      nowMs >= eventRecord.startAtMs ||
      !isLocalEventCreator(eventRecord) ||
      isPostponing
    ) {
      return;
    }
    const rawSelection = window.prompt(
      `Postpone by how many minutes?\n${EVENT_POSTPONE_OPTIONS_MINUTES.join(" / ")}`,
      "5",
    );
    if (!rawSelection) {
      return;
    }
    const selectedMinutes = Math.floor(Number(rawSelection.trim()));
    if (
      !EVENT_POSTPONE_OPTIONS_MINUTES.includes(selectedMinutes as 5 | 10 | 15)
    ) {
      window.alert("Please enter 5, 10, or 15.");
      return;
    }
    const didConfirm = window.confirm(
      `postpone event by ${selectedMinutes} minutes?`,
    );
    if (!didConfirm) {
      return;
    }
    setIsPostponing(true);
    void connection
      .postponeEventStart(modalState.eventId, selectedMinutes)
      .catch((error) => {
        const rawMessage =
          typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof (error as { message?: unknown }).message === "string"
            ? (error as { message: string }).message.trim()
            : "";
        window.alert(
          rawMessage || "Failed to postpone event start. Please try again.",
        );
      })
      .finally(() => {
        setIsPostponing(false);
      });
  }, [devStubRecord, eventRecord, isPostponing, modalState.eventId, nowMs]);

  const handleRemoveParticipantClick = useCallback(() => {
    if (
      !modalState.eventId ||
      !eventRecord ||
      devStubRecord ||
      eventRecord.status !== "scheduled" ||
      nowMs >= eventRecord.startAtMs ||
      !isLocalEventCreator(eventRecord) ||
      isRemovingParticipant ||
      removableScheduledParticipants.length <= 0
    ) {
      return;
    }
    const selectionLines = removableScheduledParticipants.map(
      (participant, index) =>
        `${index + 1}. ${getParticipantDisplayName(participant)}`,
    );
    const rawSelection = window.prompt(
      `Select participant to remove:\n${selectionLines.join("\n")}`,
      "1",
    );
    if (!rawSelection) {
      return;
    }
    const selectedIndex = Math.floor(Number(rawSelection)) - 1;
    const selectedParticipant = removableScheduledParticipants[selectedIndex];
    if (!selectedParticipant || !selectedParticipant.profileId) {
      return;
    }
    const didConfirm = window.confirm(
      `remove ${getParticipantDisplayName(selectedParticipant)} from this event?`,
    );
    if (!didConfirm) {
      return;
    }

    setIsRemovingParticipant(true);
    void connection
      .removeEventParticipant(modalState.eventId, selectedParticipant.profileId)
      .catch((error) => {
        const rawMessage =
          typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof (error as { message?: unknown }).message === "string"
            ? (error as { message: string }).message.trim()
            : "";
        window.alert(
          rawMessage ||
            "Failed to remove selected participant. Please try again.",
        );
      })
      .finally(() => {
        setIsRemovingParticipant(false);
      });
  }, [
    devStubRecord,
    eventRecord,
    isRemovingParticipant,
    modalState.eventId,
    nowMs,
    removableScheduledParticipants,
  ]);

  const handleCreateStubBracket = useCallback(() => {
    const normalizedPlayerCount = clampDevStubPlayerCount(devStubPlayerCount);
    setDevStubPlayerCount(normalizedPlayerCount);
    setDevStubRecord(
      createStubEventRecord({
        source: eventRecord,
        playerCount: normalizedPlayerCount,
        fallbackEventId: modalState.eventId,
      }),
    );
  }, [devStubPlayerCount, eventRecord, modalState.eventId]);

  const handleResetStubBracket = useCallback(() => {
    setDevStubRecord(null);
  }, []);

  if (!modalState.isOpen) {
    return null;
  }

  const hasBracket =
    (displayedEventRecord?.status === "active" ||
      displayedEventRecord?.status === "ended") &&
    bracketLayout !== null;
  const isDismissedState = displayedEventRecord?.status === "dismissed";
  const displayedParticipantCount = displayedEventRecord
    ? Object.keys(displayedEventRecord.participants ?? {}).length
    : 0;
  const isPendingDismissState =
    displayedEventRecord?.status === "scheduled" &&
    nowMs >= displayedEventRecord.startAtMs &&
    displayedParticipantCount < 2;
  const isBracketStatus =
    displayedEventRecord?.status === "active" ||
    displayedEventRecord?.status === "ended";
  const showBracketFallbackGrid =
    isBracketStatus && !hasBracket && bracketFallbackRounds.length > 0;
  const showParticipantsPanel =
    !!displayedEventRecord &&
    !isBracketStatus &&
    !isDismissedState &&
    !isPendingDismissState;
  const centeredContentHeight =
    hasBracket && bracketLayout
      ? bracketFrameHeight * bracketScale
      : showParticipantsPanel
        ? participantsHeight
        : 0;
  const bracketOffsetY = getCenteredContentOffsetY({
    contentHeight: centeredContentHeight,
    viewportHeight: viewportSize.height,
    insetTop: bracketInsets.top,
    insetBottom: bracketInsets.bottom,
  });
  const endedAwardsBottom = Math.round(
    (bracketFrameHeight + bracketFrameHeight * bracketScale) / 2 +
      WINNER_PODIUM_GAP_FROM_BRACKET,
  );
  const fallbackMaxContentHeight = Math.max(
    1,
    viewportSize.height -
      bracketInsets.top -
      bracketInsets.bottom -
      BRACKET_EDGE_PADDING_Y * 2 -
      CONTENT_AREA_PADDING_PX * 2,
  );
  const fallbackOffsetY = Math.round(
    (bracketInsets.top - bracketInsets.bottom) / 2,
  );
  const canDisqualifyFromLiveBracket =
    canManageDisqualifications &&
    !devStubRecord &&
    eventRecord?.status === "active";
  const canPostponeScheduledEvent =
    !devStubRecord &&
    eventRecord?.status === "scheduled" &&
    nowMs < eventRecord.startAtMs &&
    isLocalEventCreator(eventRecord);
  const canRemoveScheduledParticipant =
    !devStubRecord && removableScheduledParticipants.length > 0;
  const disableDisqualifyButton =
    isDisqualifying || livePendingMatches.length <= 0;
  const showEventPrizes =
    !!eventPrizeConfig && !!displayedEventRecord && !isDismissedState;
  const showTopBarEventPrizes = showEventPrizes && !showEndedAwards;
  const canSelectEventPrize = !!(
    showEventPrizes &&
    !devStubRecord &&
    currentProfileId &&
    eventRecord?.participants[currentProfileId] &&
    eventRecord.prizeSelectionsLockedAtMs == null &&
    (eventRecord.status === "scheduled" || eventRecord.status === "active")
  );
  const topBarTitleText = devStubRecord
    ? ""
    : formatRelativeStart(displayedEventRecord, nowMs);
  const topBarSubtitleText = devStubRecord
    ? ""
    : formatAbsoluteStart(displayedEventRecord);
  const pendingCreateStatusText =
    modalState.isPendingCreate && !modalState.eventId
      ? modalState.pendingCreateError || "CREATING"
      : null;
  const overlayStatusText = pendingCreateStatusText
    ? pendingCreateStatusText
    : isDismissedState
      ? "EVENT DISMISSED"
      : isPendingDismissState
        ? "LOADING"
        : !displayedEventRecord
          ? isLoading
            ? "LOADING"
            : null
          : !hasBracket && !showBracketFallbackGrid
            ? displayedEventRecord.status === "active"
              ? "building bracket..."
              : displayedEventRecord.status === "ended"
                ? "no bracket yet"
                : null
            : null;

  return (
    <Overlay
      onMouseDownCapture={handleBackdropPointerDown}
      onTouchStartCapture={handleBackdropPointerDown}
      onTouchEndCapture={handleBackdropTouchEnd}
      onTouchCancelCapture={handleBackdropTouchCancel}
      onClick={handleBackdropClick}
    >
      {modalState.eventId && !isDismissedState && (
        <DevBracketHelper>
          <DevHelperToggle
            type="button"
            aria-label="Bracket stub helper"
            onClick={() => setShowDevHelperPanel((current) => !current)}
          >
            *
          </DevHelperToggle>
          {showDevHelperPanel && (
            <DevHelperPanel>
              <DevHelperSelect
                value={devStubPlayerCount}
                onChange={(event) =>
                  setDevStubPlayerCount(
                    clampDevStubPlayerCount(Number(event.target.value)),
                  )
                }
              >
                {Array.from(
                  {
                    length: DEV_STUB_MAX_PLAYERS - DEV_STUB_MIN_PLAYERS + 1,
                  },
                  (_, index) => DEV_STUB_MIN_PLAYERS + index,
                ).map((count) => (
                  <option key={count} value={count}>
                    {count} players
                  </option>
                ))}
              </DevHelperSelect>
              <DevHelperAction type="button" onClick={handleCreateStubBracket}>
                Generate
              </DevHelperAction>
              {canPostponeScheduledEvent && (
                <DevHelperAction
                  type="button"
                  onClick={handlePostponeClick}
                  disabled={isPostponing}
                >
                  {isPostponing ? "..." : "Postpone"}
                </DevHelperAction>
              )}
              {canRemoveScheduledParticipant && (
                <DevHelperAction
                  type="button"
                  onClick={handleRemoveParticipantClick}
                  disabled={isRemovingParticipant}
                >
                  {isRemovingParticipant ? "..." : "Remove Participant"}
                </DevHelperAction>
              )}
              {canDisqualifyFromLiveBracket && (
                <DevHelperAction
                  type="button"
                  onClick={handleDisqualifyClick}
                  disabled={disableDisqualifyButton}
                >
                  {isDisqualifying ? "..." : "Disqualify"}
                </DevHelperAction>
              )}
              {devStubRecord && (
                <DevHelperAction type="button" onClick={handleResetStubBracket}>
                  Live
                </DevHelperAction>
              )}
            </DevHelperPanel>
          )}
        </DevBracketHelper>
      )}

      {!isDismissedState && (topBarTitleText || showTopBarEventPrizes) && (
        <TopBar ref={topBarRef}>
          <TopBarStack>
            {topBarTitleText && (
              <TopBarTitle>
                <div>{topBarTitleText}</div>
                {topBarSubtitleText && (
                  <TopBarSubtitle>{topBarSubtitleText}</TopBarSubtitle>
                )}
              </TopBarTitle>
            )}
            {showTopBarEventPrizes && (
              <PrizesRow role="group" aria-label="Event prizes">
                {displayedEventPrizes.map(({ prize, assignment }) => {
                  const selectedParticipants = participants.filter(
                    (participant) =>
                      eventPrizeSelections[participant.profileId] === prize.id,
                  );
                  const prizeSelectionDensity = getPrizeSelectionDensity(
                    selectedParticipants.length,
                  );
                  const isSelected =
                    eventPrizeSelections[currentProfileId] === prize.id;
                  const selectionCountLabel = `${selectedParticipants.length} ${
                    selectedParticipants.length === 1
                      ? "participant"
                      : "participants"
                  } selected`;
                  const actionLabel = isSelected ? "Deselect" : "Select";
                  const awardedParticipant = assignment
                    ? participantsById[assignment.profileId]
                    : null;
                  const awardLabel = assignment
                    ? ` Awarded to ${
                        awardedParticipant
                          ? getParticipantDisplayName(awardedParticipant)
                          : assignment.profileId
                      } for place ${assignment.place}.`
                    : "";
                  return (
                    <PrizeChoice key={prize.id}>
                      <PrizeChoiceButton
                        type="button"
                        $imageWidth={prize.imageWidth}
                        $imageHeight={prize.imageHeight}
                        disabled={
                          !canSelectEventPrize || isUpdatingPrizeSelection
                        }
                        aria-pressed={isSelected}
                        aria-busy={
                          isUpdatingPrizeSelection ? "true" : undefined
                        }
                        aria-label={`${
                          canSelectEventPrize
                            ? `${actionLabel} ${prize.alt}`
                            : prize.alt
                        }. ${selectionCountLabel}.${awardLabel}`}
                        onClick={() => handlePrizeSelectionClick(prize.id)}
                      >
                        <PrizeImage
                          src={prize.imageUrl}
                          alt={prize.alt}
                          width={prize.imageWidth}
                          height={prize.imageHeight}
                          draggable={false}
                          onLoad={() => markPrizeImageLoaded(prize.id)}
                        />
                      </PrizeChoiceButton>
                      {displayedEventRecord.status !== "ended" &&
                        loadedPrizeImageIds.has(prize.id) &&
                        selectedParticipants.length > 0 && (
                          <PrizeSelectionAvatars
                            $density={prizeSelectionDensity}
                            role="group"
                            aria-label={`Selected by ${selectedParticipants
                              .map(getParticipantDisplayName)
                              .join(", ")}`}
                          >
                            {selectedParticipants.map((participant) => {
                              const scatter = getPrizeAvatarScatter(
                                prize.id,
                                participant.profileId,
                                prizeSelectionDensity,
                              );
                              return (
                                <PrizeSelectionAvatarSlot
                                  key={participant.profileId}
                                  type="button"
                                  data-player-card-trigger="true"
                                  $density={prizeSelectionDensity}
                                  $offsetX={scatter.x}
                                  $offsetY={scatter.y}
                                  $layer={scatter.layer}
                                  title={getParticipantDisplayName(participant)}
                                  aria-label={`Open ${getParticipantDisplayName(participant)}`}
                                  onClick={() =>
                                    void handleParticipantClick(participant)
                                  }
                                >
                                  <PrizeSelectionAvatarMotion
                                    ref={(element) => {
                                      if (element) {
                                        prizeSelectionAvatarRefs.current.set(
                                          participant.profileId,
                                          element,
                                        );
                                      } else {
                                        prizeSelectionAvatarRefs.current.delete(
                                          participant.profileId,
                                        );
                                      }
                                    }}
                                  >
                                    <EventAvatar
                                      size={PRIZE_SELECTION_AVATAR_PX}
                                      emojiId={participant.emojiId}
                                      displayName={participant.displayName}
                                    />
                                  </PrizeSelectionAvatarMotion>
                                </PrizeSelectionAvatarSlot>
                              );
                            })}
                          </PrizeSelectionAvatars>
                        )}
                    </PrizeChoice>
                  );
                })}
              </PrizesRow>
            )}
          </TopBarStack>
        </TopBar>
      )}

      {overlayStatusText && <OverlayStatus>{overlayStatusText}</OverlayStatus>}

      {hasBracket && bracketLayout && (
        <BracketPlacement $offsetY={bracketOffsetY}>
          {showEndedAwards && (
            <EndedAwardsRow
              ref={endedAwardsRowRef}
              $bottom={endedAwardsBottom}
              role="group"
              aria-label="Event prize winners"
            >
              {endedAwardEntries.map(({ assignment, prize, participant }) => (
                <EndedAwardColumn key={assignment.place}>
                  <EndedAwardPrize
                    $place={assignment.place}
                    $imageWidth={prize.imageWidth}
                    $imageHeight={prize.imageHeight}
                  >
                    <PrizeImage
                      src={prize.imageUrl}
                      alt={`${prize.alt}, awarded to ${getParticipantDisplayName(participant)} for place ${assignment.place}`}
                      width={prize.imageWidth}
                      height={prize.imageHeight}
                      draggable={false}
                    />
                    <EndedAwardSparkles
                      $place={assignment.place}
                      aria-hidden="true"
                    >
                      <span />
                      <span />
                      <span />
                      <span />
                      <span />
                      <span />
                      <span />
                    </EndedAwardSparkles>
                  </EndedAwardPrize>
                  <WinnerPodiumColumn
                    type="button"
                    $place={assignment.place}
                    data-player-card-trigger="true"
                    onClick={() => void handleParticipantClick(participant)}
                    aria-label={`Open ${getParticipantDisplayName(participant)}`}
                  >
                    <WinnerPodiumAvatarSlot
                      data-avatar-slot
                      data-single-known="true"
                      $place={assignment.place}
                    >
                      <EventAvatar
                        size={WINNER_PODIUM_AVATAR_PX}
                        emojiId={participant.emojiId}
                        displayName={participant.displayName}
                      />
                    </WinnerPodiumAvatarSlot>
                    <WinnerPodiumBar $place={assignment.place}>
                      <WinnerPodiumPlaceLabel>
                        {assignment.place}
                      </WinnerPodiumPlaceLabel>
                    </WinnerPodiumBar>
                  </WinnerPodiumColumn>
                </EndedAwardColumn>
              ))}
            </EndedAwardsRow>
          )}
          <BracketContainer
            $w={bracketFrameWidth}
            $h={bracketFrameHeight}
            $scale={bracketScale}
          >
            {showBracketWinnerPodium && (
              <WinnerPodium
                $x={winnerPodiumOffsetX}
                $y={0}
                $width={winnerPodiumWidth}
              >
                {winnerPodiumEntries.map((entry) => {
                  const participantKey =
                    entry.participant.profileId ||
                    entry.participant.loginUid ||
                    `winner_podium_${entry.place}`;
                  return (
                    <WinnerPodiumColumn
                      key={participantKey}
                      type="button"
                      $place={entry.place}
                      data-player-card-trigger="true"
                      onClick={() =>
                        void handleParticipantClick(entry.participant)
                      }
                      aria-label={`Open ${getParticipantDisplayName(entry.participant)}`}
                    >
                      <WinnerPodiumAvatarSlot
                        data-avatar-slot
                        data-single-known="true"
                        $place={entry.place}
                      >
                        <EventAvatar
                          size={WINNER_PODIUM_AVATAR_PX}
                          emojiId={entry.participant.emojiId}
                          displayName={entry.participant.displayName}
                        />
                      </WinnerPodiumAvatarSlot>
                      <WinnerPodiumBar $place={entry.place}>
                        <WinnerPodiumPlaceLabel>
                          {entry.place}
                        </WinnerPodiumPlaceLabel>
                      </WinnerPodiumBar>
                    </WinnerPodiumColumn>
                  );
                })}
              </WinnerPodium>
            )}
            {bracketLayout.positions.map((mp) => {
              const action = getBracketMatchAction(mp.match, participantsById);
              const interaction: BracketCardInteraction =
                action.kind === "game"
                  ? "game"
                  : action.kind === "participant"
                    ? "participant"
                    : "none";
              const hostSideData = getMatchSideData(mp.match, "host");
              const guestSideData = getMatchSideData(mp.match, "guest");
              const displayedSides = getDisplayedMatchSides(mp.match);
              return (
                <ClassicMatchCard
                  key={mp.key}
                  type="button"
                  $x={mp.x + bracketContentOffsetX}
                  $y={mp.y + bracketContentOffsetY}
                  $w={mp.width}
                  $h={mp.height}
                  $interaction={interaction}
                  disabled={action.kind === "none"}
                  data-player-card-trigger={
                    action.kind === "participant" ? "true" : undefined
                  }
                  onClick={() => handleBracketMatchAction(action)}
                >
                  {displayedSides.map((side) => {
                    const sideData =
                      side === "host" ? hostSideData : guestSideData;
                    return (
                      <MatchAvatarSlot
                        key={side}
                        data-avatar-slot
                        data-single-known={
                          action.kind === "participant" && action.side === side
                            ? "true"
                            : undefined
                        }
                      >
                        <EventAvatar
                          size={BRACKET_AVATAR_PX}
                          emojiId={sideData.emojiId}
                          displayName={sideData.displayName}
                          isBlocked={isMatchSideBlocked(mp.match, side)}
                        />
                      </MatchAvatarSlot>
                    );
                  })}
                </ClassicMatchCard>
              );
            })}
            {thirdPlaceLayout &&
              (() => {
                const action = getBracketMatchAction(
                  thirdPlaceLayout.match,
                  participantsById,
                );
                const interaction: BracketCardInteraction =
                  action.kind === "game"
                    ? "game"
                    : action.kind === "participant"
                      ? "participant"
                      : "none";
                const displayedSides = getDisplayedMatchSides(
                  thirdPlaceLayout.match,
                );
                return (
                  <ClassicMatchCard
                    key="THIRD_PLACE"
                    type="button"
                    $x={thirdPlaceLayout.x + bracketContentOffsetX}
                    $y={thirdPlaceLayout.y + bracketContentOffsetY}
                    $w={thirdPlaceLayout.width}
                    $h={thirdPlaceLayout.height}
                    $interaction={interaction}
                    disabled={action.kind === "none"}
                    data-player-card-trigger={
                      action.kind === "participant" ? "true" : undefined
                    }
                    onClick={() => handleBracketMatchAction(action)}
                  >
                    {displayedSides.map((side) => {
                      const sideData = getMatchSideData(
                        thirdPlaceLayout.match,
                        side,
                      );
                      return (
                        <MatchAvatarSlot
                          key={side}
                          data-avatar-slot
                          data-single-known={
                            action.kind === "participant" &&
                            action.side === side
                              ? "true"
                              : undefined
                          }
                        >
                          <EventAvatar
                            size={BRACKET_THIRD_PLACE_AVATAR_PX}
                            emojiId={sideData.emojiId}
                            displayName={sideData.displayName}
                            isBlocked={isMatchSideBlocked(
                              thirdPlaceLayout.match,
                              side,
                            )}
                          />
                        </MatchAvatarSlot>
                      );
                    })}
                  </ClassicMatchCard>
                );
              })()}
            <ClassicConnectorSvg
              style={{
                left: bracketContentOffsetX,
                top: bracketContentOffsetY,
              }}
              width={bracketLayout.width}
              height={bracketLayout.height}
              viewBox={`0 0 ${bracketLayout.width} ${bracketLayout.height}`}
            >
              {bracketLayout.connectors.map((connector, i) => {
                if (connector.isBlocked) {
                  return (
                    <g key={i} data-blocked-connector="true">
                      <path d={connector.d} data-blocked="true" />
                      {connector.crossX !== null &&
                        connector.crossY !== null && (
                          <>
                            <line
                              x1={connector.crossX - 5}
                              y1={connector.crossY - 5}
                              x2={connector.crossX + 5}
                              y2={connector.crossY + 5}
                            />
                            <line
                              x1={connector.crossX - 5}
                              y1={connector.crossY + 5}
                              x2={connector.crossX + 5}
                              y2={connector.crossY - 5}
                            />
                          </>
                        )}
                    </g>
                  );
                }
                return <path key={i} d={connector.d} data-blocked="false" />;
              })}
            </ClassicConnectorSvg>
          </BracketContainer>
        </BracketPlacement>
      )}

      {showBracketFallbackGrid && (
        <BracketPlacement $offsetY={fallbackOffsetY}>
          <BracketFallbackPanel $maxContentHeight={fallbackMaxContentHeight}>
            {bracketFallbackRounds.map((round) => (
              <BracketFallbackRound key={round.key}>
                <BracketFallbackRoundTitle>
                  {round.label}
                </BracketFallbackRoundTitle>
                <BracketFallbackGrid>
                  {round.matches.map((match, index) => {
                    const action = getBracketMatchAction(
                      match,
                      participantsById,
                    );
                    const interaction: BracketCardInteraction =
                      action.kind === "game"
                        ? "game"
                        : action.kind === "participant"
                          ? "participant"
                          : "none";
                    const hostSideData = getMatchSideData(match, "host");
                    const guestSideData = getMatchSideData(match, "guest");
                    const displayedSides = getDisplayedMatchSides(match);
                    return (
                      <BracketFallbackMatchCard
                        key={`${round.key}_${match.matchKey}_${index}`}
                        type="button"
                        $interaction={interaction}
                        disabled={action.kind === "none"}
                        data-player-card-trigger={
                          action.kind === "participant" ? "true" : undefined
                        }
                        onClick={() => handleBracketMatchAction(action)}
                      >
                        {displayedSides.map((side) => {
                          const sideData =
                            side === "host" ? hostSideData : guestSideData;
                          return (
                            <MatchAvatarSlot
                              key={side}
                              data-avatar-slot
                              data-single-known={
                                action.kind === "participant" &&
                                action.side === side
                                  ? "true"
                                  : undefined
                              }
                            >
                              <EventAvatar
                                size={FALLBACK_AVATAR_PX}
                                emojiId={sideData.emojiId}
                                displayName={sideData.displayName}
                                isBlocked={isMatchSideBlocked(match, side)}
                              />
                            </MatchAvatarSlot>
                          );
                        })}
                      </BracketFallbackMatchCard>
                    );
                  })}
                </BracketFallbackGrid>
              </BracketFallbackRound>
            ))}
          </BracketFallbackPanel>
        </BracketPlacement>
      )}

      {showParticipantsPanel && (
        <BracketPlacement $offsetY={bracketOffsetY}>
          <ParticipantsCloud
            ref={participantsCloudRef}
            $scale={participantsScale}
          >
            {participants.map((participant) => (
              <ParticipantPill
                key={participant.profileId}
                type="button"
                data-player-card-trigger="true"
                onClick={() => void handleParticipantClick(participant)}
              >
                <EventAvatar
                  emojiId={participant.emojiId}
                  displayName={participant.displayName}
                  size={FALLBACK_AVATAR_PX}
                />
                <ParticipantPillName>
                  {getParticipantDisplayName(participant)}
                </ParticipantPillName>
              </ParticipantPill>
            ))}
          </ParticipantsCloud>
        </BracketPlacement>
      )}

      {modalState.eventId && !isDismissedState && (
        <BottomBar ref={bottomBarRef}>
          <ButtonRow>
            <BottomPillButton
              type="button"
              $isBlue={true}
              onClick={handleCopyClick}
            >
              {copyState !== "copied" && <FaLink />}
              {copyState === "copied" ? "Link is copied" : "Copy Link"}
            </BottomPillButton>
            <BottomPillButton
              type="button"
              $isBlue={true}
              onClick={handleShareClick}
            >
              <FaShareAlt />
              Share
            </BottomPillButton>

            {!eventUiState.isJoined && isJoinWindowOpen && (
              <BottomPillButton
                type="button"
                onClick={handleJoinClick}
                disabled={isLoading}
                $isViewOnly={isLoading}
              >
                Join
              </BottomPillButton>
            )}

            {eventUiState.playableMatch && (
              <BottomPillButton
                type="button"
                onClick={() =>
                  void openMatch(eventUiState.playableMatch!.inviteId as string)
                }
              >
                Play
              </BottomPillButton>
            )}

            {displayedEventRecord?.status === "active" &&
              !eventUiState.playableMatch &&
              watchableMatch && (
                <BottomPillButton
                  type="button"
                  onClick={() =>
                    void openMatch(getEventMatchInviteId(watchableMatch))
                  }
                >
                  Watch
                </BottomPillButton>
              )}
          </ButtonRow>
        </BottomBar>
      )}
    </Overlay>
  );
};

export default EventModal;
