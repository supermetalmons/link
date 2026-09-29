import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FaLink, FaShareAlt } from "react-icons/fa";
import {
  EventMatch,
  EventPrizeAssignment,
  EventPrizeId,
  EventRecord,
} from "../../connection/connectionModels";
import { BottomPillButton } from "../BottomControlsStyles";
import {
  didDismissSomethingWithOutsideTapJustNow,
  didNotDismissAnythingWithOutsideTapJustNow,
} from "../controls/outsideTapState";
import { showsShinyCardSomewhere } from "../shinyCardUiPort";
import {
  type ThirdPlaceMatchLayout,
  canRenderSymmetricalBracket,
  computeSymmetricalBracket,
} from "./bracketGeometry";
import {
  DEV_STUB_DEFAULT_PLAYERS,
  DEV_STUB_MAX_PLAYERS,
  DEV_STUB_MIN_PLAYERS,
  clampDevStubPlayerCount,
  createStubEventRecord,
} from "./devFixtures";
import { EventAvatar } from "./EventAvatar";
import {
  BRACKET_AVATAR_PX,
  BRACKET_EDGE_PADDING_X,
  BRACKET_EDGE_PADDING_Y,
  BRACKET_THIRD_PLACE_AVATAR_PX,
  BRACKET_THIRD_PLACE_GAP,
  BRACKET_THIRD_PLACE_MATCH_H,
  BRACKET_THIRD_PLACE_MATCH_W,
  type BracketCardInteraction,
  CONTENT_AREA_PADDING_PX,
  FALLBACK_AVATAR_PX,
  PRIZE_DISPLAY_PLACES,
  WINNER_PODIUM_AVATAR_PX,
  WINNER_PODIUM_COLUMN_GAP,
  WINNER_PODIUM_COLUMN_W,
  WINNER_PODIUM_GAP_FROM_BRACKET,
  WINNER_PODIUM_HEIGHT,
} from "./eventLayout";
import {
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
  PrizeImage,
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
} from "./eventPresentation";
import { EventPrizePanel } from "./EventPrizePanel";
import {
  type BracketMatchAction,
  canLeaveEvent,
  formatAbsoluteStart,
  formatRelativeStart,
  getBracketMatchAction,
  getDisplayedMatchSides,
  getEventMatchInviteId,
  getMatchSideData,
  getSortedMatches,
  getSortedRounds,
  getThirdPlaceMatch,
  canSelectEventPrize as isEventPrizeSelectionAvailable,
  isLocalEventCreator,
  isMatchSideBlocked,
} from "./eventState";
import { closeEventModal } from "./modalState";
import { useEventModalController } from "./useEventModalController";

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

const EventModal: React.FC = () => {
  const [devStubRecord, setDevStubRecord] = useState<EventRecord | null>(null);
  const [showDevHelperPanel, setShowDevHelperPanel] = useState(false);
  const [devStubPlayerCount, setDevStubPlayerCount] = useState(
    DEV_STUB_DEFAULT_PLAYERS,
  );
  const [endedAwardsHeight, setEndedAwardsHeight] = useState(0);
  const [viewportSize, setViewportSize] = useState(getViewportSize);
  const [bracketInsets, setBracketInsets] = useState({ top: 0, bottom: 0 });
  const [participantsScale, setParticipantsScale] = useState(1);
  const [participantsHeight, setParticipantsHeight] = useState(0);
  const ignoreNextBackdropClickRef = useRef(false);
  const ignoreBackdropMouseDownUntilMsRef = useRef(0);
  const pendingBackdropTouchDismissTouchIdRef = useRef<number | null>(null);
  const backdropGhostClickGuardCleanupRef = useRef<(() => void) | null>(null);
  const topBarRef = useRef<HTMLDivElement | null>(null);
  const bottomBarRef = useRef<HTMLDivElement | null>(null);
  const participantsCloudRef = useRef<HTMLDivElement | null>(null);
  const endedAwardsRowRef = useRef<HTMLDivElement | null>(null);
  const controller = useEventModalController(devStubRecord);
  const {
    modalState,
    eventRecord,
    displayedEventRecord,
    isLoading,
    isEventFresh,
    nowMs,
  } = controller.session;
  const {
    currentProfileId,
    currentLoginUid,
    eventProfileIds,
    isResolvingEventProfileIds,
  } = controller.identity;
  const {
    participants,
    participantsById,
    eventUiState,
    watchableMatch,
    openParticipant: handleParticipantClick,
  } = controller.participants;
  const {
    eventPrizeConfig,
    eventPrizes,
    areEventPrizesConcealed,
    prizeSelection,
    isUpdatingPrizeSelection,
  } = controller.prizes;
  const {
    isJoining,
    isLeaving,
    join: handleJoinClick,
    leave: handleLeaveClick,
    selectPrize: handlePrizeSelectionClick,
  } = controller.participation;
  const {
    isDisqualifying,
    isPostponing,
    isRemovingParticipant,
    canManageDisqualifications,
    livePendingMatches,
    removableScheduledParticipants,
    disqualify: handleDisqualifyClick,
    postpone: handlePostponeClick,
    removeParticipant: handleRemoveParticipantClick,
  } = controller.administration;
  const {
    copyState,
    copy: handleCopyClick,
    share: handleShareClick,
    openMatch,
  } = controller.navigation;
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

  useEffect(
    () => () => {
      backdropGhostClickGuardCleanupRef.current?.();
      backdropGhostClickGuardCleanupRef.current = null;
    },
    [],
  );

  useEffect(() => {
    setDevStubRecord(null);
    setShowDevHelperPanel(false);
  }, [modalState.eventId, modalState.isOpen]);

  useEffect(() => {
    if (modalState.isOpen && modalState.eventId) return;
    ignoreNextBackdropClickRef.current = false;
    ignoreBackdropMouseDownUntilMsRef.current = 0;
    pendingBackdropTouchDismissTouchIdRef.current = null;
  }, [modalState.eventId, modalState.isOpen]);

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
  const isJoinPending =
    eventRecord?.eventId !== modalState.eventId ||
    isLoading ||
    isJoining ||
    isLeaving ||
    isUpdatingPrizeSelection;
  const isLeavePending =
    isJoinPending || !isEventFresh || isResolvingEventProfileIds;

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
    !isLoading &&
    !isJoining &&
    !isLeaving &&
    isEventFresh &&
    isEventPrizeSelectionAvailable(eventRecord, currentProfileId, nowMs)
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
              <EventPrizePanel
                prizes={displayedEventPrizes}
                participants={participants}
                participantsById={participantsById}
                currentProfileId={currentProfileId}
                eventStatus={displayedEventRecord.status}
                concealed={areEventPrizesConcealed}
                canSelect={canSelectEventPrize}
                selection={prizeSelection}
                onSelect={handlePrizeSelectionClick}
                onParticipantClick={handleParticipantClick}
              />
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
                disabled={isJoinPending}
                $isViewOnly={isJoinPending}
              >
                Join
              </BottomPillButton>
            )}

            {!devStubRecord &&
              canLeaveEvent(
                eventRecord,
                currentProfileId,
                nowMs,
                currentLoginUid,
                eventProfileIds,
              ) && (
                <BottomPillButton
                  type="button"
                  onClick={() => void handleLeaveClick()}
                  disabled={isLeavePending}
                  $isViewOnly={isLeavePending}
                >
                  Leave
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
