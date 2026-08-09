import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import styled, { css } from "styled-components";
import { FaLink, FaShareAlt } from "react-icons/fa";
import { connection } from "../connection/connection";
import {
  EventMatch,
  EventParticipant,
  EventPrizeAssignment,
  EventPrizeId,
  EventPrizeSelections,
  EventRecord,
  EventRound,
  PlayerProfile,
} from "../connection/connectionModels";
import {
  closeEventModal,
  EVENT_MODAL_Z_INDEX,
  type EventModalState,
  getEventModalState,
  subscribeToEventModalState,
} from "./eventModalController";
import { emojis } from "../content/emojis";
import { storage } from "../utils/storage";
import { openProfileSignInPopupForEvent } from "./ProfileSignIn";
import { getCurrentRouteState } from "../navigation/routeState";
import {
  didDismissSomethingWithOutsideTapJustNow,
  didNotDismissAnythingWithOutsideTapJustNow,
} from "./BottomControls";
import { showShinyCard, showsShinyCardSomewhere } from "./ShinyCard";
import { getStashedPlayerProfile } from "../utils/playerMetadata";
import { BottomPillButton } from "./BottomControlsStyles";
import {
  EVENT_POSTPONE_OPTIONS_MINUTES,
  MAX_EVENT_PARTICIPANTS,
  buildEventMatchKey,
  buildEventSeedOrder,
  getEventBracketSize,
  isMonsLinkAdmin,
  parseEventMatchKey,
} from "@mons/shared/events";
import { shuffle } from "@mons/shared/ids";
import {
  getEventPrizeConfig,
  isEventPrizeEvent,
  type EventPrizeDefinition,
} from "@mons/shared/event-prizes";

const BRACKET_MATCH_W = 72;
const BRACKET_MATCH_H = 40;
const BRACKET_AVATAR_PX = 28;
const BRACKET_THIRD_PLACE_SCALE = 0.86;
const BRACKET_THIRD_PLACE_MATCH_W = Math.round(
  BRACKET_MATCH_W * BRACKET_THIRD_PLACE_SCALE,
);
const BRACKET_THIRD_PLACE_MATCH_H = Math.round(
  BRACKET_MATCH_H * BRACKET_THIRD_PLACE_SCALE,
);
const BRACKET_THIRD_PLACE_AVATAR_PX = Math.round(
  BRACKET_AVATAR_PX * BRACKET_THIRD_PLACE_SCALE,
);
const BRACKET_THIRD_PLACE_GAP = 10;
const BRACKET_SLOT_PITCH = 88;
const BRACKET_CONNECTOR_W = 40;
const BRACKET_COMPACT_CONNECTOR_W = 18;
const BRACKET_EDGE_PADDING_X = 24;
const BRACKET_EDGE_PADDING_Y = 16;
const BRACKET_CORNER_R = 10;
const CONTENT_AREA_PADDING_PX = 16;
const WINNER_PODIUM_AVATAR_PX = 34;
const WINNER_PODIUM_COLUMN_W = 70;
const WINNER_PODIUM_COLUMN_GAP = 10;
const WINNER_PODIUM_PRIMARY_BAR_H = 36;
const WINNER_PODIUM_SECONDARY_BAR_H = 30;
const WINNER_PODIUM_TERTIARY_BAR_H = 24;
const WINNER_PODIUM_AVATAR_OVERLAP = 10;
const WINNER_PODIUM_GAP_FROM_BRACKET = 10;
const WINNER_PODIUM_AVATAR_UPLIFT_PX = 3;
const WINNER_PODIUM_THIRD_PLACE_AVATAR_UPLIFT_PX = 5;
const WINNER_PODIUM_HEIGHT =
  WINNER_PODIUM_PRIMARY_BAR_H +
  WINNER_PODIUM_AVATAR_PX -
  WINNER_PODIUM_AVATAR_OVERLAP;

const FALLBACK_MATCH_H = 40;
const FALLBACK_AVATAR_PX = 28;
const PRIZE_SELECTION_AVATAR_PX = 27;
const PRIZE_SELECTION_GAP_PX = 12;
const ENDED_AWARD_PRIZE_GAP_CSS = "clamp(15px, 5vw, 20px)";
const ENDED_AWARD_LEFT_PRIZE_OFFSET_X_CSS =
  "clamp(-30px, calc(95px - 32vw), 0px)";
const ENDED_AWARD_RIGHT_PRIZE_OFFSET_X_CSS =
  "clamp(0px, calc(32vw - 95px), 30px)";
const PRIZE_AVATAR_MOVE_DURATION_MS = 180;
const PRIZE_AVATAR_APPEAR_DURATION_MS = 130;
const PRIZE_AVATAR_DISAPPEAR_DURATION_MS = 120;
const PRIZE_DISPLAY_PLACES = [2, 1, 3] as const;
const PRIZE_IMAGE_WIDTH_CSS =
  "min(clamp(44.8px, 10.4vh, 96px), calc((min(424px, 100vw - 36px) - 20px) / 3))";
const EMPTY_EVENT_PRIZES = Object.freeze([]) as readonly EventPrizeDefinition[];
const PARTICIPANT_PROFILE_CACHE_TTL_MS = 30_000;

type BracketCardInteraction = "none" | "game" | "participant";
type WinnerPodiumPlace = 1 | 2 | 3;
type PrizeSelectionDensity = "relaxed" | "compact" | "crowded";
type PendingPrizeAvatarAnimations = {
  previousRects: Map<string, DOMRect>;
  enteringProfileIds: Set<string>;
};

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

const getWinnerPodiumBarHeight = (place: WinnerPodiumPlace): number => {
  if (place === 1) {
    return WINNER_PODIUM_PRIMARY_BAR_H;
  }
  if (place === 2) {
    return WINNER_PODIUM_SECONDARY_BAR_H;
  }
  return WINNER_PODIUM_TERTIARY_BAR_H;
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

const Overlay = styled.div`
  position: fixed;
  inset: 0;
  z-index: ${EVENT_MODAL_Z_INDEX};
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.1);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;

  img {
    user-select: none;
    -webkit-user-select: none;
    -ms-user-select: none;
    -webkit-user-drag: none;
    pointer-events: none;
  }

  @media (prefers-color-scheme: dark) and (hover: none) and (pointer: coarse) {
    background: rgba(15, 15, 15, 0.11);
  }

  @media (prefers-color-scheme: light) {
    background: rgba(0, 0, 0, 0.01);
  }
`;

const TopBar = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px 20px;
  pointer-events: none;
  z-index: ${EVENT_MODAL_Z_INDEX + 1};

  & > * {
    pointer-events: auto;
    cursor: default;
  }
`;

const statusPillStyles = css`
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 0.9rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--navigationTextMuted);
  background: rgba(255, 255, 255, 0.82);
  text-align: center;

  @media (prefers-color-scheme: dark) {
    background: rgba(12, 12, 12, 0.82);
  }
`;

const TopBarTitle = styled.div`
  ${statusPillStyles}
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 6px 14px;
`;

const TopBarStack = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 100%;
`;

const PrizesRow = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 10px;
  max-width: min(424px, calc(100vw - 36px));
  cursor: default;
`;

const PrizeChoice = styled.div`
  width: ${PRIZE_IMAGE_WIDTH_CSS};
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
`;

const PrizeChoiceButton = styled.button`
  width: 100%;
  height: auto;
  aspect-ratio: 4 / 5;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  line-height: 0;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
`;

const PrizeImage = styled.img`
  display: block;
  min-width: 0;
  height: 100%;
  max-width: 100%;
  width: 100%;
`;

const PrizeSelectionAvatars = styled.div<{
  $density: PrizeSelectionDensity;
}>`
  width: 100%;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  column-gap: ${(props) =>
    props.$density === "relaxed"
      ? "4px"
      : props.$density === "compact"
        ? "1px"
        : "0"};
  row-gap: 0;
  margin-top: ${PRIZE_SELECTION_GAP_PX}px;
`;

const PrizeSelectionAvatarSlot = styled.button<{
  $density: PrizeSelectionDensity;
  $offsetX: number;
  $offsetY: number;
  $layer: number;
}>`
  position: relative;
  z-index: ${(props) => props.$layer};
  width: ${PRIZE_SELECTION_AVATAR_PX}px;
  height: ${PRIZE_SELECTION_AVATAR_PX}px;
  flex: 0 0 ${PRIZE_SELECTION_AVATAR_PX}px;
  margin: ${(props) =>
    props.$density === "relaxed"
      ? "-6px 0"
      : props.$density === "compact"
        ? "-6px -4px"
        : "-6px -8px"};
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  line-height: 0;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transform: translate(
    ${(props) => props.$offsetX}px,
    ${(props) => props.$offsetY}px
  );
`;

const PrizeSelectionAvatarMotion = styled.span`
  display: block;
  width: 100%;
  height: 100%;
  line-height: 0;
  transform-origin: center;
`;

const TopBarSubtitle = styled.div`
  font-size: 0.7rem;
  font-weight: 500;
  letter-spacing: 0.03em;
  text-transform: none;
  opacity: 0.7;
`;

const DevBracketHelper = styled.div`
  position: fixed;
  top: 12px;
  left: 12px;
  z-index: ${EVENT_MODAL_Z_INDEX + 2};
  display: flex;
  flex-direction: column;
  gap: 6px;
`;

const DevHelperToggle = styled.button`
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 999px;
  border: none;
  background: transparent;
  color: rgba(0, 0, 0, 0.16);
  font-size: 0.95rem;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  opacity: 0;

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      opacity: 0;
    }
  }

  @media (prefers-color-scheme: dark) {
    color: rgba(255, 255, 255, 0.24);
  }
`;

const DevHelperPanel = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.92);

  @media (prefers-color-scheme: dark) {
    background: rgba(20, 20, 20, 0.92);
  }
`;

const DevHelperSelect = styled.select`
  height: 28px;
  border: none;
  border-radius: 8px;
  padding: 0 8px;
  font-size: 0.78rem;
  background: var(--color-gray-f0);
  color: var(--color-gray-25);

  @media (prefers-color-scheme: dark) {
    background: var(--color-gray-33);
    color: var(--color-gray-f0);
  }
`;

const DevHelperAction = styled.button`
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
  background: var(--color-blue-primary);
  color: white;

  &:disabled {
    cursor: default;
    opacity: 0.55;
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover:not(:disabled) {
      background: var(--bottomButtonBackgroundHover);
    }
  }

  @media (prefers-color-scheme: dark) {
    background: var(--color-blue-primary-dark);

    @media (hover: hover) and (pointer: fine) {
      &:hover:not(:disabled) {
        background: var(--bottomButtonBackgroundHoverDark);
      }
    }
  }
`;

const ContentArea = styled.div`
  width: min(400px, calc(100vw - 48px));
  max-height: min(560px, calc(100vh - 96px));
  max-height: min(560px, calc(100dvh - 96px));
  overflow-y: auto;
  padding: ${CONTENT_AREA_PADDING_PX}px;
  border-radius: 16px;
  background: var(--color-white);
  cursor: default;

  @media (prefers-color-scheme: dark) {
    background: var(--color-deep-gray);
  }
`;

const ParticipantsCloud = styled.div<{ $scale: number }>`
  width: min(880px, calc(100vw - 48px));
  display: flex;
  flex-wrap: wrap;
  align-content: center;
  justify-content: center;
  gap: 10px;
  padding: 8px 16px;
  pointer-events: none;
  transform: scale(${(p) => p.$scale});
  transform-origin: center center;
`;

const ParticipantPill = styled.button`
  min-height: ${FALLBACK_MATCH_H}px;
  max-width: 100%;
  border: none;
  border-radius: ${FALLBACK_MATCH_H / 2}px;
  padding: 6px 12px 6px 6px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  pointer-events: auto;
  -webkit-tap-highlight-color: transparent;
  background: var(--color-gray-f0);
  transition: background-color 0.15s ease;

  &:disabled {
    cursor: default;
    opacity: 0.72;
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover:not(:disabled) {
      background: var(--color-gray-e0);
    }
  }

  @media (prefers-color-scheme: dark) {
    background: var(--color-gray-27);

    @media (hover: hover) and (pointer: fine) {
      &:hover:not(:disabled) {
        background: var(--color-gray-33);
      }
    }
  }
`;

const Avatar = styled.img.attrs({
  draggable: false,
})<{ $size?: number }>`
  user-select: none;
  -webkit-user-select: none;
  -ms-user-select: none;
  -webkit-user-drag: none;
  pointer-events: none;
  width: ${(props) => props.$size ?? 24}px;
  height: ${(props) => props.$size ?? 24}px;
  border-radius: ${(props) =>
    Math.max(4, Math.round((props.$size ?? 24) / 4))}px;
  flex-shrink: 0;
`;

const AvatarFallback = styled.span<{ $size?: number }>`
  width: ${(props) => Math.round((props.$size ?? 24) * 0.7)}px;
  height: ${(props) => Math.round((props.$size ?? 24) * 0.7)}px;
  border-radius: 50%;
  background: rgba(128, 128, 128, 0.13);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: ${(props) => Math.round((props.$size ?? 24) * 0.38)}px;
  font-weight: 600;
  color: rgba(128, 128, 128, 0.55);
  line-height: 1;
  user-select: none;

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.3);
  }
`;

const ParticipantPillName = styled.div`
  min-width: 0;
  max-width: min(44vw, 180px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--color-gray-25);

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-f5);
  }
`;

const BracketContainer = styled.div<{
  $w: number;
  $h: number;
  $scale: number;
}>`
  position: relative;
  flex: 0 0 auto;
  width: ${(p) => p.$w}px;
  height: ${(p) => p.$h}px;
  cursor: default;
  pointer-events: none;
  transform: scale(${(p) => p.$scale});
  transform-origin: center center;
`;

const BracketPlacement = styled.div<{ $offsetY: number }>`
  position: relative;
  z-index: 1;
  pointer-events: none;
  transform: translateY(${(p) => p.$offsetY}px);
`;

const EndedAwardsRow = styled.div<{ $bottom: number }>`
  position: absolute;
  z-index: 2;
  left: 50%;
  bottom: ${(p) => p.$bottom}px;
  transform: translateX(-50%);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: ${WINNER_PODIUM_COLUMN_GAP}px;
  max-width: min(424px, calc(100vw - 36px));
  pointer-events: none;
`;

const EndedAwardColumn = styled.div`
  width: max(${WINNER_PODIUM_COLUMN_W}px, ${PRIZE_IMAGE_WIDTH_CSS});
  min-width: 0;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: ${ENDED_AWARD_PRIZE_GAP_CSS};
`;

const EndedAwardPrize = styled.div<{ $place: WinnerPodiumPlace }>`
  width: ${PRIZE_IMAGE_WIDTH_CSS};
  min-width: 0;
  aspect-ratio: 4 / 5;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  line-height: 0;
  pointer-events: auto;
  cursor: default;
  transform: translateX(
    ${(p) =>
      p.$place === 2
        ? ENDED_AWARD_LEFT_PRIZE_OFFSET_X_CSS
        : p.$place === 3
          ? ENDED_AWARD_RIGHT_PRIZE_OFFSET_X_CSS
          : "0px"}
  );
`;

const WinnerPodium = styled.div<{
  $x: number;
  $y: number;
  $width: number;
}>`
  position: absolute;
  left: ${(p) => p.$x}px;
  top: ${(p) => p.$y}px;
  width: ${(p) => p.$width}px;
  height: ${WINNER_PODIUM_HEIGHT}px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: ${WINNER_PODIUM_COLUMN_GAP}px;
  pointer-events: none;
`;

const WinnerPodiumColumn = styled.button<{ $place: WinnerPodiumPlace }>`
  position: relative;
  isolation: isolate;
  width: ${WINNER_PODIUM_COLUMN_W}px;
  height: ${(p) =>
    getWinnerPodiumBarHeight(p.$place) +
    WINNER_PODIUM_AVATAR_PX -
    WINNER_PODIUM_AVATAR_OVERLAP}px;
  flex: 0 0 auto;
  border: none;
  margin: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
  pointer-events: auto;
  -webkit-tap-highlight-color: transparent;

  &:disabled {
    cursor: default;
    opacity: 0.72;
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover:not(:disabled) [data-avatar-slot][data-single-known="true"] {
      transform: translate(
          -50%,
          ${(p) =>
            `-${p.$place === 3 ? WINNER_PODIUM_THIRD_PLACE_AVATAR_UPLIFT_PX : WINNER_PODIUM_AVATAR_UPLIFT_PX}px`}
        )
        scale(1.06);
    }
  }
`;

const WinnerPodiumBar = styled.div<{ $place: WinnerPodiumPlace }>`
  position: absolute;
  z-index: 1;
  left: 0;
  right: 0;
  bottom: 0;
  top: ${WINNER_PODIUM_AVATAR_PX - WINNER_PODIUM_AVATAR_OVERLAP}px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  box-sizing: border-box;
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--navigationTextMuted);
  background: var(--color-gray-f0);

  @media (prefers-color-scheme: dark) {
    background: var(--color-gray-27);
  }
`;

const WinnerPodiumAvatarSlot = styled.div<{ $place: WinnerPodiumPlace }>`
  position: absolute;
  z-index: 2;
  top: 0;
  left: 50%;
  transform: translate(
    -50%,
    ${(p) =>
      `-${p.$place === 3 ? WINNER_PODIUM_THIRD_PLACE_AVATAR_UPLIFT_PX : WINNER_PODIUM_AVATAR_UPLIFT_PX}px`}
  );
  width: ${WINNER_PODIUM_AVATAR_PX}px;
  height: ${WINNER_PODIUM_AVATAR_PX}px;
  border: none;
  border-radius: 999px;
  margin: 0;
  padding: 0;
  line-height: 0;
  background: transparent;
  pointer-events: none;
  transition: transform 0.15s ease;
`;

const WinnerPodiumPlaceLabel = styled.span`
  opacity: 0.82;
`;

const ClassicConnectorSvg = styled.svg`
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 1;

  path {
    fill: none;
    stroke: rgba(160, 160, 160, 0.5);
    stroke-width: 2;
  }

  line {
    stroke: rgba(160, 160, 160, 0.5);
    stroke-width: 2;
    stroke-linecap: round;
  }

  g[data-blocked-connector="true"] {
    opacity: 0.5;
  }

  g[data-blocked-connector="true"] path,
  g[data-blocked-connector="true"] line {
    stroke: rgb(160, 160, 160);
  }

  @media (prefers-color-scheme: dark) {
    path {
      stroke: rgba(140, 140, 140, 0.4);
    }

    line {
      stroke: rgba(140, 140, 140, 0.4);
    }

    g[data-blocked-connector="true"] {
      opacity: 0.4;
    }

    g[data-blocked-connector="true"] path,
    g[data-blocked-connector="true"] line {
      stroke: rgb(140, 140, 140);
    }
  }
`;

const ClassicMatchCard = styled.button<{
  $x: number;
  $y: number;
  $w: number;
  $h: number;
  $interaction: BracketCardInteraction;
}>`
  position: absolute;
  left: ${(p) => p.$x}px;
  top: ${(p) => p.$y}px;
  width: ${(p) => p.$w}px;
  height: ${(p) => p.$h}px;
  border: none;
  border-radius: ${(p) => Math.round(Math.min(p.$w, p.$h) / 2)}px;
  padding: 4px;
  box-sizing: border-box;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: ${(p) => (p.$interaction === "none" ? "default" : "pointer")};
  pointer-events: auto;
  -webkit-tap-highlight-color: transparent;
  background: var(--color-gray-f0);
  transition: background-color 0.15s ease;
  overflow: visible;

  @media (hover: hover) and (pointer: fine) {
    ${(p) =>
      p.$interaction === "game"
        ? css`
            &:hover:not(:disabled) {
              background: var(--color-gray-e0);
            }
          `
        : ""}

    ${(p) =>
      p.$interaction === "participant"
        ? css`
            &:hover [data-avatar-slot][data-single-known="true"] {
              transform: scale(1.08);
            }
          `
        : ""}
  }

  @media (prefers-color-scheme: dark) {
    background: var(--color-gray-27);

    @media (hover: hover) and (pointer: fine) {
      ${(p) =>
        p.$interaction === "game"
          ? css`
              &:hover:not(:disabled) {
                background: var(--color-gray-33);
              }
            `
          : ""}

      ${(p) =>
        p.$interaction === "participant"
          ? css`
              &:hover [data-avatar-slot][data-single-known="true"] {
                transform: scale(1.08);
              }
            `
          : ""}
    }
  }
`;

const MatchAvatarSlot = styled.div`
  line-height: 0;
  transition: transform 0.15s ease;
`;

const BracketFallbackPanel = styled(ContentArea)<{
  $maxContentHeight: number;
}>`
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: min(560px, calc(100vh - 96px), ${(p) => p.$maxContentHeight}px);
  max-height: min(560px, calc(100dvh - 96px), ${(p) => p.$maxContentHeight}px);
  pointer-events: auto;
`;

const BracketFallbackRound = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const BracketFallbackRoundTitle = styled.div`
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--navigationTextMuted);
`;

const BracketFallbackGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(82px, 1fr));
  gap: 8px;
`;

const BracketFallbackMatchCard = styled.button<{
  $interaction: BracketCardInteraction;
}>`
  min-height: ${FALLBACK_MATCH_H}px;
  border: none;
  border-radius: ${FALLBACK_MATCH_H / 2}px;
  padding: 6px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: ${(p) => (p.$interaction === "none" ? "default" : "pointer")};
  -webkit-tap-highlight-color: transparent;
  background: var(--color-gray-f0);
  transition: background-color 0.15s ease;
  overflow: visible;

  @media (hover: hover) and (pointer: fine) {
    ${(p) =>
      p.$interaction === "game"
        ? css`
            &:hover:not(:disabled) {
              background: var(--color-gray-e0);
            }
          `
        : ""}

    ${(p) =>
      p.$interaction === "participant"
        ? css`
            &:hover [data-avatar-slot][data-single-known="true"] {
              transform: scale(1.08);
            }
          `
        : ""}
  }

  @media (prefers-color-scheme: dark) {
    background: var(--color-gray-27);

    @media (hover: hover) and (pointer: fine) {
      ${(p) =>
        p.$interaction === "game"
          ? css`
              &:hover:not(:disabled) {
                background: var(--color-gray-33);
              }
            `
          : ""}

      ${(p) =>
        p.$interaction === "participant"
          ? css`
              &:hover [data-avatar-slot][data-single-known="true"] {
                transform: scale(1.08);
              }
            `
          : ""}
    }
  }
`;

const BottomBar = styled.div`
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 20px;
  pointer-events: none;
  z-index: ${EVENT_MODAL_Z_INDEX + 1};

  & > * {
    pointer-events: auto;
    cursor: default;
  }
`;

const ButtonRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
  max-width: min(560px, calc(100vw - 40px));
`;

const OverlayStatus = styled.div`
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  ${statusPillStyles}
  pointer-events: none;
`;

type EventUiState = {
  isJoined: boolean;
  isEliminated: boolean;
  playableMatch: EventMatch | null;
  waitingForNext: boolean;
};

type EventAutoRecoveryReason =
  | "start-overdue"
  | "active-no-rounds"
  | "active-pending-without-invite"
  | "active-should-end"
  | "ended-missing-prize-assignments";

const PENDING_JOIN_POLL_INTERVAL_MS = 350;
const PENDING_JOIN_POLL_TIMEOUT_MS = 60_000;
const EVENT_SUBSCRIBE_RETRY_DELAYS_MS = [600, 1600, 3200] as const;
const DEFAULT_NOW_REFRESH_MS = 30_000;
const POST_START_NOW_REFRESH_MS = 5_000;
const MAX_NOW_REFRESH_MS = 60_000;
const NOW_REFRESH_BOUNDARY_FUDGE_MS = 50;
const EVENT_AUTO_RECOVERY_DELAY_MS = 1_000;
const EVENT_AUTO_RECOVERY_MIN_GAP_MS = 6_000;
const EVENT_AUTO_RECOVERY_MAX_ATTEMPTS_PER_REASON = 2;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const formatRelativeStartUnit = (value: number, unit: string): string =>
  `${value} ${unit}${value === 1 ? "" : "s"}`;

const formatRelativeStartUnits = (
  primary: string,
  secondaryValue: number,
  secondaryUnit: string,
): string =>
  secondaryValue <= 0
    ? `in ${primary}`
    : `in ${primary} ${formatRelativeStartUnit(secondaryValue, secondaryUnit)}`;

const formatRelativeStart = (
  event: EventRecord | null,
  nowMs: number,
): string => {
  if (!event) {
    return "";
  }
  if (event.status === "dismissed") {
    return "";
  }
  if (event.status === "ended") {
    return event.winnerDisplayName ? "" : "";
  }
  if (event.status === "active") {
    return "";
  }
  const deltaMs = event.startAtMs - nowMs;
  if (deltaMs <= 0) {
    const participantCount = Object.keys(event.participants).length;
    return participantCount < 2 ? "" : "starting now";
  }

  const roundedMinutes = Math.max(1, Math.ceil(deltaMs / MINUTE_MS));
  if (deltaMs >= DAY_MS) {
    const days = Math.floor(deltaMs / DAY_MS);
    const hours = Math.floor((deltaMs % DAY_MS) / HOUR_MS);
    return formatRelativeStartUnits(
      formatRelativeStartUnit(days, "day"),
      hours,
      "hour",
    );
  }

  if (deltaMs >= HOUR_MS) {
    const hours = Math.floor(roundedMinutes / 60);
    const minutes = roundedMinutes % 60;
    return formatRelativeStartUnits(
      formatRelativeStartUnit(hours, "hour"),
      minutes,
      "minute",
    );
  }

  const minutes = roundedMinutes;
  return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
};

const formatAbsoluteStart = (event: EventRecord | null): string => {
  if (!event || event.status !== "scheduled") {
    return "";
  }
  const d = new Date(event.startAtMs);
  const now = new Date();
  const time = d.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) {
    return time;
  }
  const date = d.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${time} · ${date}`;
};

const getEventNowRefreshDelayMs = (
  eventStatus: EventRecord["status"] | null,
  eventStartAtMs: number | null,
  nowMs: number,
): number => {
  if (
    eventStatus !== "scheduled" ||
    typeof eventStartAtMs !== "number" ||
    !Number.isFinite(eventStartAtMs)
  ) {
    return DEFAULT_NOW_REFRESH_MS;
  }

  const deltaMs = eventStartAtMs - nowMs;
  if (deltaMs <= 0) {
    return POST_START_NOW_REFRESH_MS;
  }

  const minuteRemainderMs = deltaMs % MINUTE_MS;
  const untilNextMinuteBoundaryMs =
    minuteRemainderMs === 0 ? MINUTE_MS : minuteRemainderMs;

  return Math.min(
    MAX_NOW_REFRESH_MS,
    untilNextMinuteBoundaryMs + NOW_REFRESH_BOUNDARY_FUDGE_MS,
  );
};

const getParticipantCount = (event: EventRecord | null): number => {
  if (!event || !event.participants) {
    return 0;
  }
  return Object.keys(event.participants).length;
};

const isLocalEventCreator = (event: EventRecord | null): boolean => {
  if (!event) {
    return false;
  }
  const localLoginUid = storage.getLoginId("").trim();
  const localProfileId = storage.getProfileId("").trim();
  const creatorLoginUid = event.createdByLoginUid?.trim() ?? "";
  const creatorProfileId = event.createdByProfileId?.trim() ?? "";

  return (
    (localLoginUid !== "" &&
      creatorLoginUid !== "" &&
      localLoginUid === creatorLoginUid) ||
    (localProfileId !== "" &&
      creatorProfileId !== "" &&
      localProfileId === creatorProfileId)
  );
};

const isLocalEventParticipant = (event: EventRecord | null): boolean => {
  if (!event) {
    return false;
  }
  if (isLocalEventCreator(event)) {
    return true;
  }
  const localLoginUid = storage.getLoginId("").trim();
  const localProfileId = storage.getProfileId("").trim();
  if (localProfileId && event.participants[localProfileId]) {
    return true;
  }
  return Object.values(event.participants).some((participant) => {
    const participantLoginUid = participant.loginUid?.trim() ?? "";
    return (
      localLoginUid !== "" &&
      participantLoginUid !== "" &&
      localLoginUid === participantLoginUid
    );
  });
};

const getSortedParticipants = (
  event: EventRecord | null,
): EventParticipant[] => {
  if (!event) {
    return [];
  }
  return Object.values(event.participants).sort(
    (left, right) => left.joinedAtMs - right.joinedAtMs,
  );
};

const getSortedRounds = (event: EventRecord | null): EventRound[] => {
  if (!event) {
    return [];
  }
  return Object.values(event.rounds).sort(
    (left, right) => left.roundIndex - right.roundIndex,
  );
};

const getThirdPlaceMatch = (event: EventRecord | null): EventMatch | null => {
  if (!event || !event.thirdPlaceMatch) {
    return null;
  }
  return event.thirdPlaceMatch;
};

const getEventAutoRecoveryReason = (
  event: EventRecord | null,
  nowMs: number,
): EventAutoRecoveryReason | null => {
  if (!event) {
    return null;
  }

  if (event.status === "scheduled") {
    if (nowMs >= event.startAtMs && getParticipantCount(event) >= 2) {
      return "start-overdue";
    }
    return null;
  }

  if (
    event.status === "ended" &&
    isEventPrizeEvent(event.eventId) &&
    Object.keys(event.prizeAssignments ?? {}).length === 0
  ) {
    return "ended-missing-prize-assignments";
  }

  if (event.status !== "active") {
    return null;
  }

  const rounds = getSortedRounds(event);
  if (rounds.length === 0) {
    return "active-no-rounds";
  }

  for (const round of rounds) {
    for (const match of getSortedMatches(round)) {
      if (match.status === "pending" && getEventMatchInviteId(match) === "") {
        return "active-pending-without-invite";
      }
    }
  }

  const finalRound = rounds[rounds.length - 1] ?? null;
  if (!finalRound) {
    return null;
  }
  const finalRoundMatches = getSortedMatches(finalRound);
  if (finalRoundMatches.length <= 0) {
    return null;
  }
  const isFinalRoundResolved = finalRoundMatches.every((match) =>
    isResolvedEventMatch(match),
  );
  if (!isFinalRoundResolved) {
    return null;
  }
  const thirdPlaceMatch = getThirdPlaceMatch(event);
  if (thirdPlaceMatch && !isResolvedEventMatch(thirdPlaceMatch)) {
    return null;
  }

  return "active-should-end";
};

const isProfileParticipatingInMatch = (
  match: EventMatch,
  profileId: string,
): boolean => {
  return (
    match.hostProfileId === profileId || match.guestProfileId === profileId
  );
};

const getMatchKeyIndex = (matchKey: string): number | null => {
  return parseEventMatchKey(matchKey)?.matchIndex ?? null;
};

const getSortedMatches = (round: EventRound | null): EventMatch[] => {
  if (!round) {
    return [];
  }
  return Object.values(round.matches).sort((left, right) => {
    const leftIndex = getMatchKeyIndex(left.matchKey);
    const rightIndex = getMatchKeyIndex(right.matchKey);
    if (leftIndex !== null && rightIndex !== null) {
      return leftIndex - rightIndex;
    }
    if (leftIndex !== null) {
      return -1;
    }
    if (rightIndex !== null) {
      return 1;
    }
    return left.matchKey.localeCompare(right.matchKey);
  });
};

type MatchSide = "host" | "guest";

type MatchSideData = {
  profileId: string | null;
  loginUid: string | null;
  displayName: string | null;
  emojiId: number | null;
  aura: string | null;
};

type BracketMatchAction =
  | { kind: "none" }
  | { kind: "game"; inviteId: string }
  | {
      kind: "participant";
      participant: EventParticipant;
      side: MatchSide;
    };

const getMatchSideData = (
  match: EventMatch,
  side: MatchSide,
): MatchSideData => {
  if (side === "host") {
    return {
      profileId: match.hostProfileId,
      loginUid: match.hostLoginUid,
      displayName: match.hostDisplayName,
      emojiId: match.hostEmojiId,
      aura: match.hostAura,
    };
  }
  return {
    profileId: match.guestProfileId,
    loginUid: match.guestLoginUid,
    displayName: match.guestDisplayName,
    emojiId: match.guestEmojiId,
    aura: match.guestAura,
  };
};

const isKnownMatchSide = (side: MatchSideData): boolean => {
  const displayName = side.displayName?.trim();
  return (
    !!side.profileId ||
    !!side.loginUid ||
    !!displayName ||
    (typeof side.emojiId === "number" && Number.isFinite(side.emojiId))
  );
};

const getSingleKnownMatchSide = (match: EventMatch): MatchSide | null => {
  const hostKnown = isKnownMatchSide(getMatchSideData(match, "host"));
  const guestKnown = isKnownMatchSide(getMatchSideData(match, "guest"));
  if (hostKnown === guestKnown) {
    return null;
  }
  return hostKnown ? "host" : "guest";
};

const getDisplayedByeSide = (match: EventMatch): MatchSide => {
  return isKnownMatchSide(getMatchSideData(match, "host")) ? "host" : "guest";
};

const isMatchSideBlocked = (match: EventMatch, side: MatchSide): boolean => {
  return side === "host" ? match.hostSlotBlocked : match.guestSlotBlocked;
};

const getDisplayedMatchSides = (match: EventMatch): MatchSide[] => {
  const hostBlocked = isMatchSideBlocked(match, "host");
  const guestBlocked = isMatchSideBlocked(match, "guest");
  const singleKnownSide = getSingleKnownMatchSide(match);

  if (hostBlocked && guestBlocked) {
    return [singleKnownSide ?? "host"];
  }

  if (hostBlocked !== guestBlocked && singleKnownSide) {
    return [singleKnownSide];
  }

  if (match.winnerDisqualified === true) {
    return ["host", "guest"];
  }
  if (hostBlocked || guestBlocked) {
    return ["host", "guest"];
  }
  if (match.status === "bye") {
    return [getDisplayedByeSide(match)];
  }
  return ["host", "guest"];
};

const getMatchSideLabel = (match: EventMatch, side: MatchSide): string => {
  const sideData = getMatchSideData(match, side);
  const displayName = sideData.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  const loginUid = sideData.loginUid?.trim();
  if (loginUid) {
    return loginUid;
  }
  return side === "host" ? "host" : "guest";
};

const buildParticipantFromMatchSide = (
  match: EventMatch,
  side: MatchSide,
  participantsById: Record<string, EventParticipant>,
): EventParticipant | null => {
  const sideData = getMatchSideData(match, side);
  const sideProfileId = sideData.profileId?.trim() ?? "";
  if (sideProfileId) {
    const participant = participantsById[sideProfileId];
    if (participant) {
      const participantLoginUid = participant.loginUid?.trim() ?? "";
      const sideLoginUid = sideData.loginUid?.trim() ?? "";
      if (!participantLoginUid && sideLoginUid) {
        return {
          ...participant,
          loginUid: sideLoginUid,
        };
      }
      return participant;
    }
  }

  const loginUid = sideData.loginUid?.trim() ?? "";
  if (!sideProfileId && !loginUid) {
    return null;
  }

  const displayName = sideData.displayName?.trim() ?? "";
  const emojiId =
    typeof sideData.emojiId === "number" && Number.isFinite(sideData.emojiId)
      ? sideData.emojiId
      : 0;

  return {
    profileId: sideProfileId,
    loginUid,
    username: displayName,
    displayName,
    emojiId,
    aura: sideData.aura ?? "",
    joinedAtMs: 0,
    state: "active",
    eliminatedRoundIndex: null,
    eliminatedByProfileId: null,
  };
};

const getBracketMatchAction = (
  match: EventMatch,
  participantsById: Record<string, EventParticipant>,
): BracketMatchAction => {
  const inviteId = match.inviteId?.trim() ?? "";
  if (inviteId) {
    return {
      kind: "game",
      inviteId,
    };
  }

  const singleKnownSide = getSingleKnownMatchSide(match);
  if (!singleKnownSide) {
    return { kind: "none" };
  }

  const participant = buildParticipantFromMatchSide(
    match,
    singleKnownSide,
    participantsById,
  );
  if (!participant) {
    return { kind: "none" };
  }

  return {
    kind: "participant",
    participant,
    side: singleKnownSide,
  };
};

type IndexedEventMatch = {
  roundIndex: number;
  matchIndex: number;
  match: EventMatch;
};

const getEventMatchInviteId = (match: EventMatch): string => {
  return match.inviteId?.trim() ?? "";
};

const isResolvedEventMatch = (match: EventMatch): boolean => {
  return (
    match.status === "host" ||
    match.status === "guest" ||
    match.status === "bye"
  );
};

const isPendingInviteEventMatch = (match: EventMatch): boolean => {
  return match.status === "pending" && getEventMatchInviteId(match) !== "";
};

const isActionablePendingInviteEventMatch = (match: EventMatch): boolean => {
  return isPendingInviteEventMatch(match) && match.winnerDisqualified !== true;
};

const getIndexedMatchesForRound = (round: EventRound): IndexedEventMatch[] => {
  return getSortedMatches(round).map((match, sortedIndex) => ({
    roundIndex: round.roundIndex,
    matchIndex: parseEventMatchKey(match.matchKey)?.matchIndex ?? sortedIndex,
    match,
  }));
};

const getFirstPendingInviteMatch = (
  event: EventRecord | null,
): EventMatch | null => {
  if (!event) {
    return null;
  }
  const rounds = getSortedRounds(event);
  for (const round of rounds) {
    const indexedMatches = getIndexedMatchesForRound(round);
    for (const indexedMatch of indexedMatches) {
      if (isActionablePendingInviteEventMatch(indexedMatch.match)) {
        return indexedMatch.match;
      }
    }
  }
  const thirdPlaceMatch = getThirdPlaceMatch(event);
  if (thirdPlaceMatch && isActionablePendingInviteEventMatch(thirdPlaceMatch)) {
    return thirdPlaceMatch;
  }
  return null;
};

const getActivePendingMatches = (
  event: EventRecord | null,
): Array<{ roundIndex: number | null; label: string; match: EventMatch }> => {
  if (!event || event.status !== "active") {
    return [];
  }
  const matches: Array<{
    roundIndex: number | null;
    label: string;
    match: EventMatch;
  }> = [];
  const rounds = getSortedRounds(event);
  for (const round of rounds) {
    const roundMatches = getSortedMatches(round);
    for (const match of roundMatches) {
      if (isActionablePendingInviteEventMatch(match)) {
        matches.push({
          roundIndex: round.roundIndex,
          label: `Round ${round.roundIndex + 1}`,
          match,
        });
      }
    }
  }
  const thirdPlaceMatch = getThirdPlaceMatch(event);
  if (thirdPlaceMatch && isActionablePendingInviteEventMatch(thirdPlaceMatch)) {
    matches.push({
      roundIndex: null,
      label: "Third place",
      match: thirdPlaceMatch,
    });
  }
  return matches;
};

const getRoundMatchByIndex = (
  round: EventRound,
  matchIndex: number,
): EventMatch | null => {
  const directMatch =
    round.matches[buildEventMatchKey(round.roundIndex, matchIndex)];
  if (directMatch) {
    return directMatch;
  }
  const fallbackMatch =
    getSortedMatches(round).find((candidate) => {
      const parsed = parseEventMatchKey(candidate.matchKey);
      return parsed?.matchIndex === matchIndex;
    }) ?? null;
  return fallbackMatch;
};

const findPendingInviteMatchInBranch = (
  roundsByIndex: Map<number, EventRound>,
  roundIndex: number,
  matchIndex: number,
): EventMatch | null => {
  if (roundIndex < 0 || !Number.isFinite(matchIndex) || matchIndex < 0) {
    return null;
  }
  const round = roundsByIndex.get(roundIndex);
  if (!round) {
    return null;
  }
  const match = getRoundMatchByIndex(round, matchIndex);
  if (!match) {
    return null;
  }
  if (isActionablePendingInviteEventMatch(match)) {
    return match;
  }
  if (isResolvedEventMatch(match) || roundIndex === 0) {
    return null;
  }
  const leftBranchMatch = findPendingInviteMatchInBranch(
    roundsByIndex,
    roundIndex - 1,
    matchIndex * 2,
  );
  if (leftBranchMatch) {
    return leftBranchMatch;
  }
  return findPendingInviteMatchInBranch(
    roundsByIndex,
    roundIndex - 1,
    matchIndex * 2 + 1,
  );
};

const getAwaitedPendingInviteMatchForParticipant = (
  event: EventRecord | null,
  profileId: string,
): EventMatch | null => {
  if (!event || !profileId) {
    return null;
  }
  const rounds = getSortedRounds(event);
  const roundsByIndex = new Map<number, EventRound>();
  for (const round of rounds) {
    roundsByIndex.set(round.roundIndex, round);
  }

  for (const round of rounds) {
    const indexedMatches = getIndexedMatchesForRound(round);
    for (const indexedMatch of indexedMatches) {
      const match = indexedMatch.match;
      const participantSide: MatchSide | null =
        match.hostProfileId === profileId
          ? "host"
          : match.guestProfileId === profileId
            ? "guest"
            : null;
      if (!participantSide) {
        continue;
      }
      if (isResolvedEventMatch(match) || isPendingInviteEventMatch(match)) {
        continue;
      }
      if (indexedMatch.roundIndex <= 0) {
        continue;
      }
      const awaitedMatchIndex =
        indexedMatch.matchIndex * 2 + (participantSide === "host" ? 1 : 0);
      const awaitedMatch = findPendingInviteMatchInBranch(
        roundsByIndex,
        indexedMatch.roundIndex - 1,
        awaitedMatchIndex,
      );
      if (awaitedMatch) {
        return awaitedMatch;
      }
    }
  }
  return null;
};

const getCurrentUiState = (
  event: EventRecord | null,
  profileId: string,
): EventUiState => {
  if (!event || !profileId) {
    return {
      isJoined: false,
      isEliminated: false,
      playableMatch: null,
      waitingForNext: false,
    };
  }

  const participant = event.participants[profileId];
  if (!participant) {
    return {
      isJoined: false,
      isEliminated: false,
      playableMatch: null,
      waitingForNext: false,
    };
  }

  const thirdPlaceMatch = getThirdPlaceMatch(event);
  const thirdPlacePlayableMatch =
    thirdPlaceMatch &&
    isActionablePendingInviteEventMatch(thirdPlaceMatch) &&
    isProfileParticipatingInMatch(thirdPlaceMatch, profileId)
      ? thirdPlaceMatch
      : null;

  if (participant.state === "eliminated" && !thirdPlacePlayableMatch) {
    return {
      isJoined: true,
      isEliminated: true,
      playableMatch: null,
      waitingForNext: false,
    };
  }

  const rounds = getSortedRounds(event);
  let playableMatch: EventMatch | null = thirdPlacePlayableMatch;
  for (const round of rounds) {
    if (playableMatch) {
      break;
    }
    const candidate =
      getSortedMatches(round).find(
        (match) =>
          isActionablePendingInviteEventMatch(match) &&
          (match.hostProfileId === profileId ||
            match.guestProfileId === profileId),
      ) ?? null;
    if (candidate) {
      playableMatch = candidate;
      break;
    }
  }

  return {
    isJoined: true,
    isEliminated: participant.state === "eliminated",
    playableMatch,
    waitingForNext: event.status === "active" && !playableMatch,
  };
};

const getWatchableMatch = (
  event: EventRecord | null,
  profileId: string,
  eventUiState: EventUiState,
): EventMatch | null => {
  if (!event || event.status !== "active" || eventUiState.playableMatch) {
    return null;
  }
  if (
    eventUiState.isJoined &&
    !eventUiState.isEliminated &&
    eventUiState.waitingForNext
  ) {
    const awaitedMatch = getAwaitedPendingInviteMatchForParticipant(
      event,
      profileId,
    );
    if (awaitedMatch) {
      return awaitedMatch;
    }
  }
  return getFirstPendingInviteMatch(event);
};

type ClassicBracketMatchPosition = {
  x: number;
  y: number;
  key: string;
  match: EventMatch;
  width: number;
  height: number;
};

type ClassicBracketConnector = {
  d: string;
  isBlocked: boolean;
  crossX: number | null;
  crossY: number | null;
};

type ClassicBracketLayout = {
  width: number;
  height: number;
  positions: ClassicBracketMatchPosition[];
  connectors: ClassicBracketConnector[];
};

type ThirdPlaceMatchLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
  bottom: number;
  match: EventMatch;
};

type BracketMatchLayout = {
  width: number;
  height: number;
  useCompactEntry: boolean;
};

const getBracketMatchLayout = (
  roundIndex: number,
  totalRounds: number,
): BracketMatchLayout => {
  return {
    width: BRACKET_MATCH_W,
    height: BRACKET_MATCH_H,
    useCompactEntry: roundIndex < totalRounds - 1,
  };
};

const getBracketMatchTop = (
  depthIndex: number,
  matchIndex: number,
  matchHeight: number,
): number => {
  const slotSpan = BRACKET_SLOT_PITCH * Math.pow(2, depthIndex);
  return Math.round((slotSpan - matchHeight) / 2 + matchIndex * slotSpan);
};

const getBracketMatchCenterY = (
  depthIndex: number,
  matchIndex: number,
  matchHeight: number,
): number => {
  return (
    getBracketMatchTop(depthIndex, matchIndex, matchHeight) + matchHeight / 2
  );
};

const getClassicConnectorMidX = (x1: number, x2: number): number => {
  return x1 + (x2 - x1) / 2;
};

const buildClassicElbowConnectorPath = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string => {
  const direction = x2 >= x1 ? 1 : -1;
  const mx = getClassicConnectorMidX(x1, x2);
  const dy = y2 - y1;
  if (Math.abs(dy) < 1) {
    return `M${x1},${y1}H${x2}`;
  }
  const signY = dy > 0 ? 1 : -1;
  const r = Math.min(
    BRACKET_CORNER_R,
    Math.abs(dy) / 2,
    Math.abs(mx - x1),
    Math.abs(x2 - mx),
  );
  if (r < 1) {
    return `M${x1},${y1}H${mx}V${y2}H${x2}`;
  }
  return [
    `M${x1},${y1}`,
    `H${mx - direction * r}`,
    `Q${mx},${y1} ${mx},${y1 + signY * r}`,
    `V${y2 - signY * r}`,
    `Q${mx},${y2} ${mx + direction * r},${y2}`,
    `H${x2}`,
  ].join("");
};

const buildClassicTopBottomEntryConnectorPath = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string => {
  const direction = x2 >= x1 ? 1 : -1;
  const dy = y2 - y1;
  if (Math.abs(dy) < 1) {
    return `M${x1},${y1}H${x2}`;
  }
  const signY = dy > 0 ? 1 : -1;
  const r = Math.min(BRACKET_CORNER_R, Math.abs(dy), Math.abs(x2 - x1));
  if (r < 1) {
    return `M${x1},${y1}H${x2}V${y2}`;
  }
  return [
    `M${x1},${y1}`,
    `H${x2 - direction * r}`,
    `Q${x2},${y1} ${x2},${y1 + signY * r}`,
    `V${y2}`,
  ].join("");
};

const getClassicElbowConnectorCrossPoint = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { x: number; y: number } => {
  const dy = y2 - y1;
  if (Math.abs(dy) < 1) {
    return {
      x: getClassicConnectorMidX(x1, x2),
      y: y1,
    };
  }

  const direction = x2 >= x1 ? 1 : -1;
  const mx = getClassicConnectorMidX(x1, x2);
  const r = Math.min(
    BRACKET_CORNER_R,
    Math.abs(dy) / 2,
    Math.abs(mx - x1),
    Math.abs(x2 - mx),
  );
  const horizontalEndX = r < 1 ? mx : mx - direction * r;

  return {
    x: getClassicConnectorMidX(x1, horizontalEndX),
    y: y1,
  };
};

const getClassicTopBottomEntryConnectorCrossPoint = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { x: number; y: number } => {
  const dy = y2 - y1;
  if (Math.abs(dy) < 1) {
    return {
      x: getClassicConnectorMidX(x1, x2),
      y: y1,
    };
  }

  const direction = x2 >= x1 ? 1 : -1;
  const r = Math.min(BRACKET_CORNER_R, Math.abs(dy), Math.abs(x2 - x1));
  const horizontalEndX = r < 1 ? x2 : x2 - direction * r;

  return {
    x: getClassicConnectorMidX(x1, horizontalEndX),
    y: y1,
  };
};

const canRenderSymmetricalBracket = (rounds: EventRound[]): boolean => {
  if (rounds.length === 0) {
    return false;
  }

  const matchCounts = rounds.map((round) => getSortedMatches(round).length);
  if (matchCounts.some((count) => count <= 0)) {
    return false;
  }

  const hasCanonicalMatchKeys = rounds.every((round) => {
    const matches = getSortedMatches(round);
    for (let i = 0; i < matches.length; i += 1) {
      const parsed = parseEventMatchKey(matches[i].matchKey);
      if (!parsed || parsed.roundIndex !== round.roundIndex) {
        return false;
      }
      if (parsed.matchIndex !== i) {
        return false;
      }
    }
    return true;
  });
  if (!hasCanonicalMatchKeys) {
    return false;
  }

  if (rounds.length === 1) {
    return matchCounts[0] === 1;
  }

  if (matchCounts[rounds.length - 1] !== 1) {
    return false;
  }

  for (let i = 0; i < rounds.length - 1; i += 1) {
    if (matchCounts[i] !== matchCounts[i + 1] * 2) {
      return false;
    }
  }

  return true;
};

const computeSymmetricalBracket = (
  rounds: EventRound[],
): ClassicBracketLayout | null => {
  if (rounds.length === 0) {
    return null;
  }

  const totalRounds = rounds.length;
  const sideRounds = totalRounds - 1;
  const roundLayouts = rounds.map((_, roundIndex) =>
    getBracketMatchLayout(roundIndex, totalRounds),
  );
  const finalLayout = roundLayouts[totalRounds - 1];

  if (sideRounds === 0) {
    const match = getSortedMatches(rounds[0])[0];
    if (!match) return null;
    return {
      width: finalLayout.width,
      height: finalLayout.height,
      positions: [
        {
          x: 0,
          y: 0,
          key: "FINAL",
          match,
          width: finalLayout.width,
          height: finalLayout.height,
        },
      ],
      connectors: [],
    };
  }

  const totalCols = 2 * sideRounds + 1;
  const columnRoundIndices = [
    ...Array.from({ length: sideRounds }, (_, roundIndex) => roundIndex),
    totalRounds - 1,
    ...Array.from(
      { length: sideRounds },
      (_, offset) => sideRounds - 1 - offset,
    ),
  ];
  const columnWidths = [
    ...roundLayouts.slice(0, sideRounds).map((layout) => layout.width),
    finalLayout.width,
    ...roundLayouts
      .slice(0, sideRounds)
      .reverse()
      .map((layout) => layout.width),
  ];
  const gapAfterColumn = Array.from(
    { length: Math.max(0, totalCols - 1) },
    (_, colIndex) => {
      const inwardColumnIndex = colIndex < sideRounds ? colIndex + 1 : colIndex;
      if (inwardColumnIndex === sideRounds) {
        return BRACKET_CONNECTOR_W;
      }
      const inwardRoundIndex = columnRoundIndices[inwardColumnIndex];
      return roundLayouts[inwardRoundIndex]?.useCompactEntry
        ? BRACKET_COMPACT_CONNECTOR_W
        : BRACKET_CONNECTOR_W;
    },
  );
  const columnX: number[] = [];
  let currentX = 0;
  for (let i = 0; i < totalCols; i += 1) {
    columnX.push(currentX);
    currentX += columnWidths[i] + (gapAfterColumn[i] ?? 0);
  }
  const width =
    totalCols === 0 ? 0 : columnX[totalCols - 1] + columnWidths[totalCols - 1];

  const positions: ClassicBracketMatchPosition[] = [];
  const connectors: ClassicBracketConnector[] = [];
  let maxBottom = 0;

  const colX = (col: number): number => columnX[col] ?? 0;
  const pushPosition = (
    x: number,
    y: number,
    key: string,
    match: EventMatch,
    layout: BracketMatchLayout,
  ): void => {
    positions.push({
      x,
      y,
      key,
      match,
      width: layout.width,
      height: layout.height,
    });
    maxBottom = Math.max(maxBottom, y + layout.height);
  };
  const pushConnector = (
    d: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    isBlocked: boolean,
    crossPoint?: { x: number; y: number },
  ): void => {
    connectors.push({
      d,
      isBlocked,
      crossX: isBlocked ? (crossPoint?.x ?? (x1 + x2) / 2) : null,
      crossY: isBlocked ? (crossPoint?.y ?? (y1 + y2) / 2) : null,
    });
  };

  for (let r = 0; r < sideRounds; r++) {
    const layout = roundLayouts[r];
    const x = colX(r);
    const roundMatches = getSortedMatches(rounds[r]);
    const perSideCount = Math.ceil(roundMatches.length / 2);

    for (let m = 0; m < perSideCount; m++) {
      const match = roundMatches[m];
      const y = getBracketMatchTop(r, m, layout.height);
      pushPosition(x, y, `L${r}_${m}`, match, layout);
    }

    if (r < sideRounds - 1) {
      const nextX = colX(r + 1);
      const nextLayout = roundLayouts[r + 1];
      const nextPerSideCount = Math.ceil(
        getSortedMatches(rounds[r + 1]).length / 2,
      );
      for (let j = 0; j < nextPerSideCount; j++) {
        const srcA = 2 * j;
        const srcB = 2 * j + 1;
        if (srcA >= perSideCount) {
          continue;
        }
        const y1 = getBracketMatchCenterY(r, srcA, layout.height);
        const nextMatchTop = getBracketMatchTop(r + 1, j, nextLayout.height);
        const sx = x + layout.width;
        const sourceMatchA = roundMatches[srcA];
        if (nextLayout.useCompactEntry) {
          const entryX = nextX + nextLayout.width / 2;
          pushConnector(
            buildClassicTopBottomEntryConnectorPath(
              sx,
              y1,
              entryX,
              nextMatchTop,
            ),
            sx,
            y1,
            entryX,
            nextMatchTop,
            sourceMatchA?.winnerDisqualified === true,
            getClassicTopBottomEntryConnectorCrossPoint(
              sx,
              y1,
              entryX,
              nextMatchTop,
            ),
          );
          if (srcB < perSideCount) {
            const y2 = getBracketMatchCenterY(r, srcB, layout.height);
            const sourceMatchB = roundMatches[srcB];
            pushConnector(
              buildClassicTopBottomEntryConnectorPath(
                sx,
                y2,
                entryX,
                nextMatchTop + nextLayout.height,
              ),
              sx,
              y2,
              entryX,
              nextMatchTop + nextLayout.height,
              sourceMatchB?.winnerDisqualified === true,
              getClassicTopBottomEntryConnectorCrossPoint(
                sx,
                y2,
                entryX,
                nextMatchTop + nextLayout.height,
              ),
            );
          }
        }
      }
    }

    if (r === sideRounds - 1) {
      const y = getBracketMatchCenterY(r, 0, layout.height);
      const sx = x + layout.width;
      const ex = colX(sideRounds);
      const finalY = getBracketMatchCenterY(r, 0, finalLayout.height);
      pushConnector(
        buildClassicElbowConnectorPath(sx, y, ex, finalY),
        sx,
        y,
        ex,
        finalY,
        roundMatches[0]?.winnerDisqualified === true,
        getClassicElbowConnectorCrossPoint(sx, y, ex, finalY),
      );
    }
  }

  {
    const x = colX(sideRounds);
    const finalRound = rounds[totalRounds - 1];
    const finalMatches = getSortedMatches(finalRound);
    const match = finalMatches[0];
    if (match) {
      const y = getBracketMatchTop(sideRounds - 1, 0, finalLayout.height);
      pushPosition(x, y, "FINAL", match, finalLayout);
    }
  }

  for (let r = 0; r < sideRounds; r++) {
    const layout = roundLayouts[r];
    const col = 2 * sideRounds - r;
    const x = colX(col);
    const roundMatches = getSortedMatches(rounds[r]);
    const totalCount = roundMatches.length;
    const perSideCount = Math.ceil(totalCount / 2);
    const offset = perSideCount;

    for (let m = 0; m < totalCount - perSideCount; m++) {
      const match = roundMatches[offset + m];
      const y = getBracketMatchTop(r, m, layout.height);
      pushPosition(x, y, `R${r}_${m}`, match, layout);
    }

    if (r < sideRounds - 1) {
      const innerCol = 2 * sideRounds - (r + 1);
      const innerX = colX(innerCol);
      const nextLayout = roundLayouts[r + 1];
      const nextRoundMatches = getSortedMatches(rounds[r + 1]);
      const nextTotalCount = nextRoundMatches.length;
      const nextPerSide = Math.ceil(nextTotalCount / 2);
      const innerMatchCount = nextTotalCount - nextPerSide;
      const currentSideCount = totalCount - perSideCount;
      for (let j = 0; j < innerMatchCount; j++) {
        const srcA = 2 * j;
        const srcB = 2 * j + 1;
        if (srcA >= currentSideCount) {
          continue;
        }
        const y1 = getBracketMatchCenterY(r, srcA, layout.height);
        const nextMatchTop = getBracketMatchTop(r + 1, j, nextLayout.height);
        const sx = x;
        const sourceMatchA = roundMatches[offset + srcA];
        if (nextLayout.useCompactEntry) {
          const entryX = innerX + nextLayout.width / 2;
          pushConnector(
            buildClassicTopBottomEntryConnectorPath(
              sx,
              y1,
              entryX,
              nextMatchTop,
            ),
            sx,
            y1,
            entryX,
            nextMatchTop,
            sourceMatchA?.winnerDisqualified === true,
            getClassicTopBottomEntryConnectorCrossPoint(
              sx,
              y1,
              entryX,
              nextMatchTop,
            ),
          );
          if (srcB < currentSideCount) {
            const y2 = getBracketMatchCenterY(r, srcB, layout.height);
            const sourceMatchB = roundMatches[offset + srcB];
            pushConnector(
              buildClassicTopBottomEntryConnectorPath(
                sx,
                y2,
                entryX,
                nextMatchTop + nextLayout.height,
              ),
              sx,
              y2,
              entryX,
              nextMatchTop + nextLayout.height,
              sourceMatchB?.winnerDisqualified === true,
              getClassicTopBottomEntryConnectorCrossPoint(
                sx,
                y2,
                entryX,
                nextMatchTop + nextLayout.height,
              ),
            );
          }
        }
      }
    }

    if (r === sideRounds - 1) {
      const y = getBracketMatchCenterY(r, 0, layout.height);
      const sx = x;
      const ex = colX(sideRounds) + finalLayout.width;
      const finalY = getBracketMatchCenterY(r, 0, finalLayout.height);
      pushConnector(
        buildClassicElbowConnectorPath(sx, y, ex, finalY),
        sx,
        y,
        ex,
        finalY,
        roundMatches[offset]?.winnerDisqualified === true,
        getClassicElbowConnectorCrossPoint(sx, y, ex, finalY),
      );
    }
  }

  return {
    width,
    height: Math.max(maxBottom, finalLayout.height),
    positions,
    connectors,
  };
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

const getParticipantDisplayName = (participant: EventParticipant): string => {
  const displayName = participant.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  const username = participant.username?.trim();
  if (username) {
    return username;
  }
  return "anon";
};

const getPrizeAvatarScatter = (
  prizeId: string,
  profileId: string,
  density: PrizeSelectionDensity,
) => {
  const value = `${prizeId}:${profileId}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const normalizedHash = hash >>> 0;
  const scatterScale =
    density === "relaxed" ? 0.4 : density === "compact" ? 0.75 : 1;
  return {
    x: ((normalizedHash % 9) - 4) * scatterScale,
    y: (((normalizedHash >>> 4) % 7) - 3) * scatterScale,
    layer: (normalizedHash >>> 6) % 8,
  };
};

const getParticipantProfileCacheKey = (
  participant: EventParticipant,
): string => {
  if (participant.profileId) {
    return `profile:${participant.profileId}`;
  }
  return participant.loginUid ? `login:${participant.loginUid}` : "";
};

type WinnerPodiumEntry = {
  place: WinnerPodiumPlace;
  participant: EventParticipant;
};

const getParticipantIdentityKey = (
  participant: EventParticipant | null | undefined,
): string => {
  return participant?.profileId?.trim() || participant?.loginUid?.trim() || "";
};

const getDisqualifiedParticipantIdentityKeys = (
  event: EventRecord | null,
  rounds: EventRound[],
): Set<string> => {
  const disqualifiedKeys = new Set<string>();
  const addMatchParticipantKeys = (match: EventMatch | null | undefined) => {
    if (!match || match.winnerDisqualified !== true) {
      return;
    }
    const hostProfileId = match.hostProfileId?.trim() ?? "";
    const hostLoginUid = match.hostLoginUid?.trim() ?? "";
    const guestProfileId = match.guestProfileId?.trim() ?? "";
    const guestLoginUid = match.guestLoginUid?.trim() ?? "";
    if (hostProfileId) {
      disqualifiedKeys.add(hostProfileId);
    }
    if (hostLoginUid) {
      disqualifiedKeys.add(hostLoginUid);
    }
    if (guestProfileId) {
      disqualifiedKeys.add(guestProfileId);
    }
    if (guestLoginUid) {
      disqualifiedKeys.add(guestLoginUid);
    }
  };

  for (const round of rounds) {
    for (const match of getSortedMatches(round)) {
      addMatchParticipantKeys(match);
    }
  }
  addMatchParticipantKeys(getThirdPlaceMatch(event));
  return disqualifiedKeys;
};

const isParticipantDisqualified = (
  participant: EventParticipant | null | undefined,
  disqualifiedIdentityKeys: Set<string>,
): boolean => {
  if (!participant) {
    return false;
  }
  const profileId = participant.profileId?.trim() ?? "";
  if (profileId && disqualifiedIdentityKeys.has(profileId)) {
    return true;
  }
  const loginUid = participant.loginUid?.trim() ?? "";
  if (loginUid && disqualifiedIdentityKeys.has(loginUid)) {
    return true;
  }
  return false;
};

const addParticipantIdentityKeys = (
  identityKeys: Set<string>,
  participant: EventParticipant | null | undefined,
): void => {
  if (!participant) {
    return;
  }
  const profileId = participant.profileId?.trim() ?? "";
  if (profileId) {
    identityKeys.add(profileId);
  }
  const loginUid = participant.loginUid?.trim() ?? "";
  if (loginUid) {
    identityKeys.add(loginUid);
  }
  const primaryIdentityKey = getParticipantIdentityKey(participant);
  if (primaryIdentityKey) {
    identityKeys.add(primaryIdentityKey);
  }
};

const hasAnyParticipantIdentityKey = (
  identityKeys: Set<string>,
  participant: EventParticipant | null | undefined,
): boolean => {
  if (!participant) {
    return false;
  }
  const profileId = participant.profileId?.trim() ?? "";
  if (profileId && identityKeys.has(profileId)) {
    return true;
  }
  const loginUid = participant.loginUid?.trim() ?? "";
  if (loginUid && identityKeys.has(loginUid)) {
    return true;
  }
  const primaryIdentityKey = getParticipantIdentityKey(participant);
  if (primaryIdentityKey && identityKeys.has(primaryIdentityKey)) {
    return true;
  }
  return false;
};

const getMatchSideForProfileId = (
  match: EventMatch,
  profileId: string | null | undefined,
): MatchSide | null => {
  const normalizedProfileId = profileId?.trim() ?? "";
  if (!normalizedProfileId) {
    return null;
  }
  if (match.hostProfileId === normalizedProfileId) {
    return "host";
  }
  if (match.guestProfileId === normalizedProfileId) {
    return "guest";
  }
  return null;
};

const resolveMatchParticipant = (
  match: EventMatch,
  participantsById: Record<string, EventParticipant>,
  profileId: string | null | undefined,
): EventParticipant | null => {
  const normalizedProfileId = profileId?.trim() ?? "";
  if (!normalizedProfileId) {
    return null;
  }
  const knownParticipant = participantsById[normalizedProfileId];
  if (knownParticipant) {
    return knownParticipant;
  }
  const side = getMatchSideForProfileId(match, normalizedProfileId);
  if (!side) {
    return null;
  }
  return buildParticipantFromMatchSide(match, side, participantsById);
};

const getResolvedMatchWinnerSide = (match: EventMatch): MatchSide | null => {
  if (match.status === "host") {
    return "host";
  }
  if (match.status === "guest") {
    return "guest";
  }
  if (match.status === "bye") {
    return getDisplayedByeSide(match);
  }
  return null;
};

const getEndedEventWinnerPodiumEntries = (
  event: EventRecord | null,
  rounds: EventRound[],
  participantsById: Record<string, EventParticipant>,
): WinnerPodiumEntry[] => {
  if (!event || event.status !== "ended" || rounds.length === 0) {
    return [];
  }
  const finalRound = rounds[rounds.length - 1];
  const finalMatch = getSortedMatches(finalRound)[0];
  if (!finalMatch) {
    return [];
  }
  const disqualifiedParticipantIdentityKeys =
    getDisqualifiedParticipantIdentityKeys(event, rounds);
  const participantList = Object.values(event.participants ?? {});
  const shouldShowTopThree = participantList.length >= 3;

  const winnerSide = getResolvedMatchWinnerSide(finalMatch);
  const winner =
    resolveMatchParticipant(
      finalMatch,
      participantsById,
      event.winnerProfileId,
    ) ??
    resolveMatchParticipant(
      finalMatch,
      participantsById,
      finalMatch.winnerProfileId,
    ) ??
    (winnerSide
      ? buildParticipantFromMatchSide(finalMatch, winnerSide, participantsById)
      : null);

  const runnerUpSide: MatchSide | null =
    winnerSide === "host" ? "guest" : winnerSide === "guest" ? "host" : null;
  const runnerUp =
    resolveMatchParticipant(
      finalMatch,
      participantsById,
      finalMatch.loserProfileId,
    ) ??
    (runnerUpSide
      ? buildParticipantFromMatchSide(
          finalMatch,
          runnerUpSide,
          participantsById,
        )
      : null);

  const winnerKey = getParticipantIdentityKey(winner);
  if (
    !winner ||
    !winnerKey ||
    isParticipantDisqualified(winner, disqualifiedParticipantIdentityKeys)
  ) {
    return [];
  }

  const entriesByPlace = new Map<WinnerPodiumPlace, EventParticipant>();
  entriesByPlace.set(1, winner);
  const reservedParticipantKeys = new Set<string>();
  addParticipantIdentityKeys(reservedParticipantKeys, winner);
  const placementCandidates: EventParticipant[] = [];
  const pushPlacementCandidate = (
    participant: EventParticipant | null | undefined,
  ) => {
    if (!participant) {
      return;
    }
    if (
      hasAnyParticipantIdentityKey(reservedParticipantKeys, participant) ||
      isParticipantDisqualified(
        participant,
        disqualifiedParticipantIdentityKeys,
      )
    ) {
      return;
    }
    addParticipantIdentityKeys(reservedParticipantKeys, participant);
    placementCandidates.push(participant);
  };
  pushPlacementCandidate(runnerUp);

  if (shouldShowTopThree) {
    const thirdPlaceMatch = getThirdPlaceMatch(event);
    const thirdPlaceWinnerSide = thirdPlaceMatch
      ? getResolvedMatchWinnerSide(thirdPlaceMatch)
      : null;
    const thirdPlaceMatchWinner =
      thirdPlaceMatch &&
      (resolveMatchParticipant(
        thirdPlaceMatch,
        participantsById,
        thirdPlaceMatch.winnerProfileId,
      ) ??
        (thirdPlaceWinnerSide
          ? buildParticipantFromMatchSide(
              thirdPlaceMatch,
              thirdPlaceWinnerSide,
              participantsById,
            )
          : null));
    pushPlacementCandidate(thirdPlaceMatchWinner);
  }

  const fallbackPlacementCandidates = participantList
    .filter((participant) => {
      return !isParticipantDisqualified(
        participant,
        disqualifiedParticipantIdentityKeys,
      );
    })
    .sort((left, right) => {
      const leftEliminationRound = left.eliminatedRoundIndex ?? -1;
      const rightEliminationRound = right.eliminatedRoundIndex ?? -1;
      if (leftEliminationRound !== rightEliminationRound) {
        return rightEliminationRound - leftEliminationRound;
      }
      if (left.joinedAtMs !== right.joinedAtMs) {
        return left.joinedAtMs - right.joinedAtMs;
      }
      return left.profileId.localeCompare(right.profileId);
    });
  for (const candidate of fallbackPlacementCandidates) {
    pushPlacementCandidate(candidate);
  }

  const runnerUpPlacement = placementCandidates[0] ?? null;
  if (runnerUpPlacement) {
    entriesByPlace.set(2, runnerUpPlacement);
  }
  const thirdPlacePlacement =
    shouldShowTopThree && placementCandidates.length > 1
      ? placementCandidates[1]
      : null;
  if (thirdPlacePlacement) {
    entriesByPlace.set(3, thirdPlacePlacement);
  }

  return ([2, 1, 3] as WinnerPodiumPlace[]).flatMap((place) => {
    const participant = entriesByPlace.get(place);
    if (!participant) {
      return [];
    }
    return [
      {
        place,
        participant,
      },
    ];
  });
};

const DEV_STUB_MIN_PLAYERS = 2;
const DEV_STUB_MAX_PLAYERS = MAX_EVENT_PARTICIPANTS;
const DEV_STUB_DEFAULT_PLAYERS = 8;
const DEV_STUB_NAME_LENGTH = 9;
const DEV_STUB_NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz";

const clampDevStubPlayerCount = (value: number): number => {
  if (!Number.isFinite(value)) {
    return DEV_STUB_MIN_PLAYERS;
  }
  return Math.min(
    DEV_STUB_MAX_PLAYERS,
    Math.max(DEV_STUB_MIN_PLAYERS, Math.round(value)),
  );
};

const createRandomStubName = (): string => {
  let name = "";
  for (let index = 0; index < DEV_STUB_NAME_LENGTH; index += 1) {
    const letterIndex = Math.floor(
      Math.random() * DEV_STUB_NAME_ALPHABET.length,
    );
    name += DEV_STUB_NAME_ALPHABET[letterIndex];
  }
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
};

const createStubParticipants = (
  playerCount: number,
  nowMs: number,
): EventParticipant[] => {
  const displayNames = new Set<string>();
  while (displayNames.size < playerCount) {
    displayNames.add(createRandomStubName());
  }

  return shuffle(
    Array.from(displayNames, (displayName, index) => {
      const profileId = `dev_stub_profile_${index + 1}`;
      const [emojiIdString] = emojis.getRandomEmojiUrl(true);
      const emojiId = Number(emojiIdString);
      return {
        profileId,
        loginUid: `dev_stub_login_${index + 1}`,
        username: displayName.toLowerCase(),
        displayName,
        emojiId: Number.isFinite(emojiId) ? emojiId : 1,
        aura: "",
        joinedAtMs: nowMs - (playerCount - index) * 3000,
        state: "active",
        eliminatedRoundIndex: null,
        eliminatedByProfileId: null,
      } satisfies EventParticipant;
    }),
  );
};

const createStubEventRecord = ({
  source,
  playerCount,
  fallbackEventId,
}: {
  source: EventRecord | null;
  playerCount: number;
  fallbackEventId?: string | null;
}): EventRecord => {
  const normalizedPlayerCount = clampDevStubPlayerCount(playerCount);
  const bracketSize = getEventBracketSize(normalizedPlayerCount);
  const roundCount = Math.max(1, Math.round(Math.log2(bracketSize)));
  const nowMs = Date.now();
  const participants = createStubParticipants(normalizedPlayerCount, nowMs);
  const participantsById: Record<string, EventParticipant> = {};
  for (const participant of participants) {
    participantsById[participant.profileId] = participant;
  }
  const sourceCreator = participants[0] ?? null;
  const sourceEventId = source?.eventId?.trim();

  if (source?.status === "scheduled") {
    const scheduledStartAtMs =
      typeof source.startAtMs === "number" && source.startAtMs > nowMs
        ? source.startAtMs
        : nowMs + 15 * 60_000;
    return {
      schemaVersion: source?.schemaVersion ?? 1,
      eventId: sourceEventId || fallbackEventId?.trim() || "dev_stub_event",
      status: "scheduled",
      createdAtMs: source?.createdAtMs ?? nowMs - 60_000,
      updatedAtMs: nowMs,
      startAtMs: scheduledStartAtMs,
      startedAtMs: null,
      endedAtMs: null,
      createdByProfileId:
        source?.createdByProfileId ?? sourceCreator?.profileId ?? "dev_stub",
      createdByLoginUid:
        source?.createdByLoginUid ?? sourceCreator?.loginUid ?? "dev_stub",
      createdByUsername:
        source?.createdByUsername ?? sourceCreator?.username ?? "dev_stub",
      winnerProfileId: null,
      winnerDisplayName: null,
      currentRoundIndex: null,
      bracketSize,
      roundCount: 0,
      participants: participantsById,
      rounds: {},
    };
  }

  const seedOrder = buildEventSeedOrder(bracketSize);
  const seedToSlotIndex = new Map<number, number>();
  seedOrder.forEach((seed, slotIndex) => {
    seedToSlotIndex.set(seed, slotIndex);
  });

  let roundEntrants: Array<EventParticipant | null> = Array.from(
    { length: bracketSize },
    () => null,
  );
  for (let seed = 1; seed <= normalizedPlayerCount; seed += 1) {
    const slotIndex = seedToSlotIndex.get(seed);
    const participant = participants[seed - 1];
    if (slotIndex === undefined || !participant) {
      continue;
    }
    roundEntrants[slotIndex] = participant;
  }

  const eliminationsByProfileId: Record<
    string,
    { eliminatedRoundIndex: number; eliminatedByProfileId: string | null }
  > = {};
  const rounds: Record<string, EventRound> = {};

  for (let roundIndex = 0; roundIndex < roundCount; roundIndex += 1) {
    const matchCount = Math.max(1, Math.floor(roundEntrants.length / 2));
    const nextRoundEntrants: Array<EventParticipant | null> = Array.from(
      { length: matchCount },
      () => null,
    );
    const matches: Record<string, EventMatch> = {};

    for (let matchIndex = 0; matchIndex < matchCount; matchIndex += 1) {
      const host = roundEntrants[matchIndex * 2] ?? null;
      const guest = roundEntrants[matchIndex * 2 + 1] ?? null;
      const matchKey = buildEventMatchKey(roundIndex, matchIndex);
      let status: EventMatch["status"] = "upcoming";
      let winner: EventParticipant | null = null;
      let loser: EventParticipant | null = null;

      if (host && guest) {
        const hostWon = Math.random() >= 0.5;
        winner = hostWon ? host : guest;
        loser = hostWon ? guest : host;
        status = hostWon ? "host" : "guest";
      } else if (host || guest) {
        winner = host ?? guest;
        status = "bye";
      }

      nextRoundEntrants[matchIndex] = winner;
      if (winner && loser) {
        eliminationsByProfileId[loser.profileId] = {
          eliminatedRoundIndex: roundIndex,
          eliminatedByProfileId: winner.profileId,
        };
      }

      const resolvedAtMs =
        winner !== null
          ? nowMs - (roundCount - roundIndex) * 60_000 - matchIndex * 250
          : null;

      matches[matchKey] = {
        matchKey,
        inviteId: null,
        status,
        resolvedAtMs,
        winnerDisqualified: false,
        winnerProfileId: winner?.profileId ?? null,
        loserProfileId: loser?.profileId ?? null,
        hostSlotBlocked: false,
        hostProfileId: host?.profileId ?? null,
        hostLoginUid: host?.loginUid ?? null,
        hostDisplayName: host?.displayName ?? null,
        hostEmojiId: host?.emojiId ?? null,
        hostAura: host?.aura ?? null,
        guestSlotBlocked: false,
        guestProfileId: guest?.profileId ?? null,
        guestLoginUid: guest?.loginUid ?? null,
        guestDisplayName: guest?.displayName ?? null,
        guestEmojiId: guest?.emojiId ?? null,
        guestAura: guest?.aura ?? null,
      };
    }

    rounds[String(roundIndex)] = {
      roundIndex,
      status: "completed",
      createdAtMs: nowMs - (roundCount - roundIndex + 1) * 60_000,
      completedAtMs: nowMs - (roundCount - roundIndex) * 60_000,
      matches,
    };
    roundEntrants = nextRoundEntrants;
  }

  const winner = roundEntrants[0] ?? participants[0] ?? null;
  for (const participant of participants) {
    const elimination = eliminationsByProfileId[participant.profileId];
    if (winner && participant.profileId === winner.profileId) {
      participantsById[participant.profileId] = {
        ...participant,
        state: "winner",
        eliminatedRoundIndex: null,
        eliminatedByProfileId: null,
      };
      continue;
    }
    participantsById[participant.profileId] = {
      ...participant,
      state: "eliminated",
      eliminatedRoundIndex:
        elimination?.eliminatedRoundIndex ?? Math.max(0, roundCount - 1),
      eliminatedByProfileId:
        elimination?.eliminatedByProfileId ?? winner?.profileId ?? null,
    };
  }

  return {
    schemaVersion: source?.schemaVersion ?? 1,
    eventId: sourceEventId || fallbackEventId?.trim() || "dev_stub_event",
    status: "ended",
    createdAtMs: source?.createdAtMs ?? nowMs - (roundCount + 3) * 60_000,
    updatedAtMs: nowMs,
    startAtMs: source?.startAtMs ?? nowMs - (roundCount + 2) * 60_000,
    startedAtMs: source?.startedAtMs ?? nowMs - (roundCount + 2) * 60_000,
    endedAtMs: nowMs - 10_000,
    createdByProfileId:
      source?.createdByProfileId ??
      sourceCreator?.profileId ??
      winner?.profileId ??
      "dev_stub",
    createdByLoginUid:
      source?.createdByLoginUid ??
      sourceCreator?.loginUid ??
      winner?.loginUid ??
      "dev_stub",
    createdByUsername:
      source?.createdByUsername ??
      sourceCreator?.username ??
      winner?.username ??
      "dev_stub",
    winnerProfileId: winner?.profileId ?? null,
    winnerDisplayName: winner?.displayName ?? null,
    currentRoundIndex: Math.max(0, roundCount - 1),
    bracketSize,
    roundCount,
    participants: participantsById,
    rounds,
  };
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
        endedAwardsReservedHeight * 2,
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
                  <EndedAwardPrize $place={assignment.place}>
                    <PrizeImage
                      src={prize.imageUrl}
                      alt={`${prize.alt}, awarded to ${getParticipantDisplayName(participant)} for place ${assignment.place}`}
                      draggable={false}
                    />
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
              isBlue={true}
              onClick={handleCopyClick}
            >
              {copyState !== "copied" && <FaLink />}
              {copyState === "copied" ? "Link is copied" : "Copy Link"}
            </BottomPillButton>
            <BottomPillButton
              type="button"
              isBlue={true}
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
                isViewOnly={isLoading}
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
