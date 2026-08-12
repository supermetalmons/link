import React, { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import styled from "styled-components";
import { problems, getCompletedProblemIds } from "../content/problems";
import { useGameAssets } from "../hooks/useGameAssets";
import { FiCheck, FiCircle, FiPlus } from "react-icons/fi";
import {
  NavigationGameItem,
  NavigationGameStatus,
  NavigationItem,
  NavigationEventItem,
} from "../connection/connectionModels";
import { emojis } from "../content/emojis";

interface NavigationPickerProps {
  showsHomeNavigation: boolean;
  navigateHome?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  topGames?: NavigationItem[];
  pagedGames?: NavigationItem[];
  selectedProblemId?: string | null;
  selectedNavigationItemId?: string | null;
  isGamesLoading?: boolean;
  isLoadingMoreGames?: boolean;
  hasMoreGames?: boolean;
  onSelectGame?: (
    item: NavigationItem,
    options?: { status?: NavigationGameStatus },
  ) => void;
  onRemoveGame?: (inviteId: string) => void;
  removingGameInviteIds?: Set<string>;
  onSelectProblem: (problemId: string) => void;
  onLoadMoreGames?: () => void;
}

const NavigationPickerContainer = styled.div`
  position: fixed;
  bottom: max(50px, calc(env(safe-area-inset-bottom) + 44px));
  right: 8px;
  height: 480px;
  max-height: calc(100dvh - 120px - env(safe-area-inset-bottom));
  width: 150pt;
  display: flex;
  flex-direction: column;
  background-color: var(--panel-light-90);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  border-radius: 7pt;
  overflow: hidden;
  padding: 0;
  gap: 0;
  z-index: 7;

  @media (prefers-color-scheme: dark) {
    background-color: var(--panel-dark-90);
  }

  @media screen and (max-height: 453px) {
    bottom: max(44px, calc(env(safe-area-inset-bottom) + 38px));
  }
`;

const ScrollableList = styled.div`
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  flex-grow: 1;
  padding: 6px 0 8px;
  scrollbar-width: none;
  user-select: none;
  -webkit-user-select: none;

  &::-webkit-scrollbar {
    display: none;
  }
`;

const SectionSeparator = () => null;

const NavigationPickerButton = styled.button<{ $isSelected?: boolean }>`
  background: ${(props) =>
    props.$isSelected ? "rgba(117, 187, 255, 0.22)" : "transparent"};
  border-radius: 0;
  font-size: 0.8rem;
  border: none;
  padding: 6px 12px;
  cursor: pointer;
  text-align: left;
  color: var(--color-gray-33);
  width: 100%;
  display: flex;
  align-items: center;
  gap: 5px;
  font-weight: 400;
  user-select: none;
  -webkit-user-select: none;

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: ${(props) =>
        props.$isSelected
          ? "rgba(117, 187, 255, 0.30)"
          : "var(--interactiveHoverBackgroundLight)"};
    }
  }

  &:active {
    background-color: ${(props) =>
      props.$isSelected
        ? "rgba(117, 187, 255, 0.38)"
        : "var(--interactiveActiveBackgroundLight)"};
  }

  @media (prefers-color-scheme: dark) {
    color: var(--color-gray-f0);
    background: ${(props) =>
      props.$isSelected ? "rgba(75, 150, 255, 0.24)" : "transparent"};

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: ${(props) =>
          props.$isSelected
            ? "rgba(75, 150, 255, 0.34)"
            : "var(--interactiveHoverBackgroundDark)"};
      }
    }

    &:active {
      background-color: ${(props) =>
        props.$isSelected
          ? "rgba(75, 150, 255, 0.42)"
          : "var(--interactiveActiveBackgroundDark)"};
    }
  }
`;

const GameRow = styled(NavigationPickerButton)<{
  $hasTrailingAction?: boolean;
}>`
  width: 100%;
  min-width: 0;
  padding-right: 12px;
`;

const EventRow = styled(GameRow)`
  && {
    background: transparent;
  }

  @media (hover: hover) and (pointer: fine) {
    &&:hover {
      background-color: transparent;
    }
  }

  &&:active {
    background-color: transparent;
  }

  @media (prefers-color-scheme: dark) {
    && {
      background: transparent;
    }

    @media (hover: hover) and (pointer: fine) {
      &&:hover {
        background-color: transparent;
      }
    }

    &&:active {
      background-color: transparent;
    }
  }
`;

const GameRowContainer = styled.div`
  position: relative;
  width: 100%;
  min-width: 0;
`;

const GameEmojiImage = styled.img.attrs({ draggable: false })`
  width: 20px;
  height: 20px;
  border-radius: 2px;
  flex-shrink: 0;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
`;

const GameEmojiPlaceholder = styled.div`
  width: 20px;
  height: 20px;
  border-radius: 2px;
  background: rgba(128, 128, 128, 0.22);
  flex-shrink: 0;
`;

type QueueManaSlot = "top" | "right" | "bottom" | "left";

const QueueManaCluster = styled.span`
  position: relative;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
`;

const QueueManaIcon = styled.img<{ $slot: QueueManaSlot }>`
  position: absolute;
  width: 11px;
  height: 11px;
  object-fit: contain;
  left: ${(props) => {
    if (props.$slot === "left") {
      return "27%";
    }
    if (props.$slot === "right") {
      return "73%";
    }
    return "50%";
  }};
  top: ${(props) => {
    if (props.$slot === "top") {
      return "27%";
    }
    if (props.$slot === "bottom") {
      return "73%";
    }
    return "50%";
  }};
  transform: translate(-50%, -50%);
  pointer-events: none;
`;

const GameText = styled.span`
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const FightCloudWrap = styled.div`
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  flex: 1;
`;

const EventAvatarImage = styled(GameEmojiImage)``;
const EventAvatarPlaceholder = styled(GameEmojiPlaceholder)`
  background: transparent;
`;
const EventAvatarQuestionSlot = styled(EventAvatarPlaceholder)`
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: 2px;
  border-radius: 999px;
  background: rgba(120, 120, 120, 0.12);
  color: rgba(74, 74, 74, 0.48);

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.05);
    color: rgba(220, 220, 220, 0.34);
  }
`;

const EventAvatarQuestionIcon = styled(FiPlus)`
  width: 11px;
  height: 11px;
  stroke-width: 2.3;
`;

const FightCloudCanvas = styled.svg`
  position: absolute;
  top: 50%;
  left: -8px;
  transform: translateY(-50%);
  width: calc(100% + 18px);
  height: 28px;
  overflow: visible;
  pointer-events: none;
`;

const CloudShape = styled.path`
  fill: currentColor;
  fill-opacity: 0.05;
  stroke: currentColor;
  stroke-opacity: 0.09;
  stroke-width: 0.6;
  transition:
    fill-opacity 0.12s,
    stroke-opacity 0.12s;

  @media (hover: hover) and (pointer: fine) {
    button:hover & {
      fill-opacity: 0.1;
      stroke-opacity: 0.15;
    }
  }

  button:active & {
    fill-opacity: 0.14;
    stroke-opacity: 0.19;
  }

  @media (prefers-color-scheme: dark) {
    fill-opacity: 0.07;
    stroke-opacity: 0.12;

    @media (hover: hover) and (pointer: fine) {
      button:hover & {
        fill-opacity: 0.12;
        stroke-opacity: 0.17;
      }
    }

    button:active & {
      fill-opacity: 0.16;
      stroke-opacity: 0.21;
    }
  }
`;

const FightCloudInner = styled.div`
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  min-width: 0;
  z-index: 1;
`;

const EventPreviewGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 1px;
  flex-shrink: 0;
  margin-left: 2px;
`;

const FightCloudBadge = styled.span`
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: 18px;
  height: 18px;
  padding: 0 3px;
  border-radius: 9px;
  font-size: 0.55rem;
  font-weight: 600;
  color: var(--navigationTextMuted);
  flex-shrink: 0;
  letter-spacing: -0.02em;
  white-space: nowrap;
  background: rgba(128, 128, 128, 0.08);

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.06);
  }
`;

const EventTrailingContent = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 6px;
  flex-shrink: 0;
`;

const QueuePrimaryContent = styled(GameText)``;

const GameStatus = styled.span<{
  $isSelected?: boolean;
  $highlightSelected?: boolean;
}>`
  margin-left: auto;
  font-size: 0.52rem;
  color: ${(props) =>
    props.$isSelected && props.$highlightSelected
      ? "var(--color-blue-primary)"
      : "var(--navigationTextMuted)"};
  text-transform: uppercase;

  @media (prefers-color-scheme: dark) {
    color: ${(props) =>
      props.$isSelected && props.$highlightSelected
        ? "var(--color-blue-primary-dark)"
        : "var(--navigationTextMuted)"};
  }
`;

const LiveDot = styled.span`
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background-color: var(--color-blue-primary);
  margin-left: auto;
  flex-shrink: 0;

  @media (prefers-color-scheme: dark) {
    background-color: var(--color-blue-primary-dark);
  }
`;

const GameRemoveButton = styled.button<{ $isDisabled?: boolean }>`
  position: absolute;
  top: 50%;
  right: 8px;
  transform: translateY(-50%);
  z-index: 2;
  pointer-events: auto;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: none;
  padding: 0;
  background: rgba(128, 128, 128, 0.1);
  color: var(--navigationTextMuted);
  opacity: ${(props) => (props.$isDisabled ? 0.55 : 0.9)};
  cursor: ${(props) => (props.$isDisabled ? "default" : "pointer")};
  user-select: none;
  flex-shrink: 0;

  &::before,
  &::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    width: 8px;
    height: 1.25px;
    border-radius: 999px;
    background: currentColor;
    transform-origin: center;
  }

  &::before {
    transform: translate(-50%, -50%) rotate(45deg);
  }

  &::after {
    transform: translate(-50%, -50%) rotate(-45deg);
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: ${(props) =>
        props.$isDisabled
          ? "transparent"
          : "var(--interactiveHoverBackgroundLight)"};
      color: var(--color-gray-33);
    }
  }

  &:active {
    background-color: ${(props) =>
      props.$isDisabled
        ? "transparent"
        : "var(--interactiveActiveBackgroundLight)"};
  }

  @media (prefers-color-scheme: dark) {
    background: rgba(255, 255, 255, 0.08);
    color: var(--navigationTextMuted);

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: ${(props) =>
          props.$isDisabled
            ? "transparent"
            : "var(--interactiveHoverBackgroundDark)"};
        color: var(--color-gray-f0);
      }
    }

    &:active {
      background-color: ${(props) =>
        props.$isDisabled
          ? "transparent"
          : "var(--interactiveActiveBackgroundDark)"};
    }
  }
`;

const CompletedIcon = styled(FiCheck)`
  color: var(--navigationTextMuted);
  width: 0.63rem;
  height: 0.63rem;
  margin-left: auto;
  flex-shrink: 0;
  padding-left: 4px;
  stroke-width: 1.5;
  stroke: currentColor;

  & path {
    fill: none;
  }
`;

const IncompleteIcon = styled(FiCircle)`
  color: var(--navigationTextMuted);
  width: 0.63rem;
  height: 0.63rem;
  margin-left: auto;
  flex-shrink: 0;
  padding-left: 4px;
  stroke-width: 1.5;
  stroke: currentColor;
  transform: scale(0.8);
  transform-origin: center;
  overflow: visible;

  & path {
    fill: none;
  }
`;

const PlaceholderImage = styled.img.attrs({ draggable: false })`
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  user-select: none;
  -webkit-user-select: none;
  -webkit-user-drag: none;
`;

const HomeBoardButton = styled.button<{ $withTopBorder?: boolean }>`
  position: sticky;
  bottom: 0;
  background-color: var(--color-blue-primary);
  color: white;
  border-radius: 21px;
  padding: 8px 16px;
  height: 42px;
  font-size: 0.777rem;
  font-weight: bold;
  border: none;
  cursor: pointer;
  text-align: center;
  width: calc(100% - 12px);
  margin: ${(props) => (props.$withTopBorder ? "8px" : "0")} 6px 8px;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  outline: none;
  z-index: 2;

  &:active {
    background-color: var(--bottomButtonBackgroundActive);
  }

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: var(--bottomButtonBackgroundHover);
    }
  }

  @media (prefers-color-scheme: dark) {
    background-color: var(--color-blue-primary-dark);

    &:active {
      background-color: var(--bottomButtonBackgroundActiveDark);
    }

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: var(--bottomButtonBackgroundHoverDark);
      }
    }
  }
`;

const MIN_AUTO_LOAD_NEXT_PAGE_THRESHOLD_PX = 640;
const MIN_REASONABLE_EPOCH_MS = Date.UTC(2000, 0, 1);
const SELECTED_ITEM_VISIBILITY_MARGIN_PX = 8;
const QUEUE_MANA_SLOTS: QueueManaSlot[] = ["top", "right", "bottom", "left"];

function buildFightCloudPath(w: number, h: number): string {
  const parts: string[] = [];
  const insetX = 2.2;
  const insetY = 3.8;
  const left = insetX;
  const right = w - insetX;
  const top = insetY;
  const bottom = h - insetY;
  const midY = h / 2;
  const sideInset = Math.min(6.2, Math.max(4.6, w * 0.11));
  const topStartX = left + sideInset;
  const topEndX = right - sideInset;
  const topPuffCount = Math.max(
    3,
    Math.min(5, Math.round((topEndX - topStartX) / 21)),
  );
  const topStep = (topEndX - topStartX) / topPuffCount;
  const topAmp = Math.min(4.6, Math.max(3.3, (bottom - top) * 0.22));
  const bottomAmp = Math.min(4.2, Math.max(3.0, (bottom - top) * 0.2));
  const sideAmp = Math.min(3.6, Math.max(2.8, w * 0.045));
  const sidePeakOffsetY = (bottom - top) * 0.09;

  const startY = top + 0.45;
  parts.push(`M${topStartX.toFixed(1)},${startY.toFixed(1)}`);

  for (let i = 0; i < topPuffCount; i++) {
    const nextX = topStartX + (i + 1) * topStep;
    const peakX =
      topStartX +
      i * topStep +
      topStep * (0.5 + Math.sin(i * 1.17 + 0.45) * 0.06);
    const peakY = top - topAmp * (0.92 + Math.cos(i * 0.93 - 0.4) * 0.12);
    const valleyY = top + 0.4 + Math.sin((i + 1) * 1.21 + 0.3) * 0.28;

    parts.push(
      `Q${peakX.toFixed(1)},${peakY.toFixed(1)},${nextX.toFixed(1)},${valleyY.toFixed(1)}`,
    );
  }

  parts.push(
    `Q${(right + sideAmp).toFixed(1)},${(midY - sidePeakOffsetY).toFixed(1)},${(topEndX - 0.1).toFixed(1)},${(bottom - 0.45).toFixed(1)}`,
  );

  for (let i = 0; i < topPuffCount; i++) {
    const nextX = topEndX - (i + 1) * topStep;
    const peakX =
      topEndX - i * topStep - topStep * (0.5 + Math.sin(i * 1.11 + 0.8) * 0.06);
    const peakY = bottom + bottomAmp * (0.9 + Math.cos(i * 0.98 + 0.2) * 0.12);
    const valleyY = bottom - 0.42 - Math.sin((i + 1) * 1.17 + 0.55) * 0.26;

    parts.push(
      `Q${peakX.toFixed(1)},${peakY.toFixed(1)},${nextX.toFixed(1)},${valleyY.toFixed(1)}`,
    );
  }

  parts.push(
    `Q${(left - sideAmp).toFixed(1)},${(midY + sidePeakOffsetY).toFixed(1)},${topStartX.toFixed(1)},${startY.toFixed(1)}`,
  );
  parts.push("Z");
  return parts.join("");
}

const fightCloudCache = new Map<string, string>();
function getFightCloudPath(w: number, h: number) {
  const k = `${w}|${h}`;
  let v = fightCloudCache.get(k);
  if (!v) {
    v = buildFightCloudPath(w, h);
    fightCloudCache.set(k, v);
  }
  return v;
}

const FIGHT_CLOUD_BASE_W = 160;
const FIGHT_CLOUD_H = 28;

const NavigationPicker: React.FC<NavigationPickerProps> = ({
  showsHomeNavigation,
  navigateHome,
  topGames = [],
  pagedGames = [],
  selectedProblemId = null,
  selectedNavigationItemId = null,
  isGamesLoading = false,
  isLoadingMoreGames = false,
  hasMoreGames = false,
  onSelectGame,
  onRemoveGame,
  removingGameInviteIds,
  onSelectProblem,
  onLoadMoreGames,
}) => {
  const navigationPickerRef = useRef<HTMLDivElement>(null);
  const scrollableListRef = useRef<HTMLDivElement>(null);
  const isAutoLoadPendingRef = useRef(false);
  const hasUserScrolledRef = useRef(false);
  const canRunOneFollowUpLoadRef = useRef(false);
  const hasResolvedInitialScrollPositionRef = useRef(false);
  const isIgnoringInitialProgrammaticScrollRef = useRef(false);
  const { assets } = useGameAssets();

  const handleNavigationSelect = (id: string) => {
    onSelectProblem(id);
  };

  const preventScroll = (e: React.TouchEvent) => {
    e.preventDefault();
  };

  const handleHomeClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    navigateHome?.(e);
  };

  const maybeLoadMoreGames = useCallback(
    (container: HTMLDivElement | null, source: "scroll" | "effect") => {
      if (
        !container ||
        !onLoadMoreGames ||
        !hasMoreGames ||
        isGamesLoading ||
        isLoadingMoreGames ||
        isAutoLoadPendingRef.current
      ) {
        return;
      }

      const isScrollable = container.scrollHeight > container.clientHeight + 1;
      if (!hasUserScrolledRef.current && isScrollable) {
        return;
      }

      if (
        hasUserScrolledRef.current &&
        source === "effect" &&
        !canRunOneFollowUpLoadRef.current
      ) {
        return;
      }

      const thresholdPx = Math.max(
        MIN_AUTO_LOAD_NEXT_PAGE_THRESHOLD_PX,
        container.clientHeight * 2,
      );
      const remainingScroll =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      if (remainingScroll > thresholdPx) {
        return;
      }

      if (source === "scroll" && hasUserScrolledRef.current) {
        canRunOneFollowUpLoadRef.current = true;
      } else if (source === "effect") {
        canRunOneFollowUpLoadRef.current = false;
      }

      isAutoLoadPendingRef.current = true;
      onLoadMoreGames();
    },
    [hasMoreGames, isGamesLoading, isLoadingMoreGames, onLoadMoreGames],
  );

  const handleScrollableListScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (isIgnoringInitialProgrammaticScrollRef.current) {
        isIgnoringInitialProgrammaticScrollRef.current = false;
        return;
      }

      if (event.currentTarget.scrollTop > 0) {
        hasUserScrolledRef.current = true;
      }
      maybeLoadMoreGames(event.currentTarget, "scroll");
    },
    [maybeLoadMoreGames],
  );

  useEffect(() => {
    if (!isLoadingMoreGames) {
      isAutoLoadPendingRef.current = false;
      maybeLoadMoreGames(scrollableListRef.current, "effect");
    }
  }, [isLoadingMoreGames, maybeLoadMoreGames]);

  useEffect(() => {
    maybeLoadMoreGames(scrollableListRef.current, "effect");
  }, [maybeLoadMoreGames, topGames.length, pagedGames.length]);

  useLayoutEffect(() => {
    if (hasResolvedInitialScrollPositionRef.current) {
      return;
    }

    hasResolvedInitialScrollPositionRef.current = true;

    const container = scrollableListRef.current;
    if (!container) {
      return;
    }

    const selectedElement =
      container.querySelector<HTMLElement>(
        "[data-navigation-selected-primary='true']",
      ) ??
      container.querySelector<HTMLElement>("[data-navigation-active='true']") ??
      container.querySelector<HTMLElement>("[data-navigation-selected='true']");
    if (!selectedElement) {
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const selectedRect = selectedElement.getBoundingClientRect();

    let nextScrollTop = container.scrollTop;
    const topLimit = containerRect.top + SELECTED_ITEM_VISIBILITY_MARGIN_PX;
    const bottomLimit =
      containerRect.bottom - SELECTED_ITEM_VISIBILITY_MARGIN_PX;

    if (selectedRect.top < topLimit) {
      nextScrollTop -= topLimit - selectedRect.top;
    } else if (selectedRect.bottom > bottomLimit) {
      nextScrollTop += selectedRect.bottom - bottomLimit;
    } else {
      return;
    }

    const maxScrollTop = Math.max(
      0,
      container.scrollHeight - container.clientHeight,
    );
    const clampedScrollTop = Math.max(0, Math.min(nextScrollTop, maxScrollTop));
    if (Math.abs(clampedScrollTop - container.scrollTop) < 1) {
      return;
    }

    isIgnoringInitialProgrammaticScrollRef.current = true;
    container.scrollTop = clampedScrollTop;

    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => {
        isIgnoringInitialProgrammaticScrollRef.current = false;
      });
    } else {
      isIgnoringInitialProgrammaticScrollRef.current = false;
    }
  }, []);

  const getIconImage = (iconName: string) => {
    if (!assets || !assets[iconName]) {
      return "data:image/svg+xml,%3Csvg width='20' height='20' viewBox='0 0 20 20' xmlns='http://www.w3.org/2000/svg'%3E%3Ccircle cx='10' cy='10' r='8' fill='%23cccccc' fill-opacity='0.5'/%3E%3C/svg%3E";
    }
    return `data:image/png;base64,${assets[iconName]}`;
  };

  const getGameStatusLabel = (game: NavigationGameItem): string => {
    if (game.status === "pending") {
      return "pending";
    }
    if (game.status === "active") {
      return "active";
    }
    if (game.status === "ended") {
      const lastUpdateMs = Number.isFinite(game.listSortAtMs)
        ? Math.floor(game.listSortAtMs)
        : 0;
      if (lastUpdateMs < MIN_REASONABLE_EPOCH_MS) {
        return "long ago";
      }
      const date = new Date(lastUpdateMs);
      if (Number.isNaN(date.getTime())) {
        return "long ago";
      }
      const now = new Date();
      const includeYear = date.getFullYear() !== now.getFullYear();
      return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        ...(includeYear ? { year: "numeric" } : {}),
      });
    }
    return "waiting";
  };

  const getQueuePrimaryLabel = (game: NavigationGameItem): string => {
    if (game.status === "pending") {
      return "Automatching";
    }
    return "Waiting for opponent";
  };

  const queueManaImage = getIconImage("mana");

  const getEventStatusLabel = (event: NavigationEventItem): string => {
    if (event.status === "ended" || event.status === "dismissed") {
      const sourceMs =
        event.endedAtMs ?? event.updatedAtMs ?? event.listSortAtMs;
      if (!Number.isFinite(sourceMs) || sourceMs < MIN_REASONABLE_EPOCH_MS) {
        return "long ago";
      }

      const date = new Date(sourceMs);
      if (Number.isNaN(date.getTime())) {
        return "long ago";
      }

      const now = new Date();
      const includeYear = date.getFullYear() !== now.getFullYear();
      return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        ...(includeYear ? { year: "numeric" } : {}),
      });
    }
    if (event.status === "waiting") {
      return "SOON";
    }

    return event.status;
  };

  const completedProblemsSet = getCompletedProblemIds();
  const visibleTopGames = topGames.filter(
    (item) => !(item.entityType === "event" && item.status === "dismissed"),
  );
  const visiblePagedGames = pagedGames.filter(
    (item) => !(item.entityType === "event" && item.status === "dismissed"),
  );

  const isWaitingForOpponentGame = (item: NavigationItem) =>
    item.entityType === "game" && item.status === "waiting";

  const waitingForOpponentGames = [
    ...visibleTopGames.filter(isWaitingForOpponentGame),
    ...visiblePagedGames.filter(isWaitingForOpponentGame),
  ];
  const nonWaitingTopGames = visibleTopGames.filter(
    (item) => !isWaitingForOpponentGame(item),
  );
  const nonWaitingPagedGames = visiblePagedGames.filter(
    (item) => !isWaitingForOpponentGame(item),
  );

  const shouldRenderWaitingGamesSection = waitingForOpponentGames.length > 0;
  const shouldRenderTopGamesSection = nonWaitingTopGames.length > 0;
  const shouldRenderPagedGamesSection = nonWaitingPagedGames.length > 0;
  const shouldRenderLearnSection = true;
  const hasScrollableContent =
    shouldRenderLearnSection ||
    shouldRenderWaitingGamesSection ||
    shouldRenderTopGamesSection ||
    shouldRenderPagedGamesSection;

  const renderEventPreview = (
    event: NavigationEventItem,
  ): { preview: React.ReactNode; badge: React.ReactNode | null } | null => {
    const normalizedParticipantCount = Number.isFinite(event.participantCount)
      ? Math.max(0, Math.trunc(event.participantCount))
      : 0;
    const showBadge = normalizedParticipantCount > 6;
    const maxVisible = showBadge ? 5 : 6;
    const previewEmojiIds = event.participantPreview.reduce<number[]>(
      (result, participant) => {
        if (result.length >= maxVisible) {
          return result;
        }
        const normalizedEmojiId =
          participant.emojiId == null ? NaN : Number(participant.emojiId);
        if (Number.isFinite(normalizedEmojiId) && normalizedEmojiId > 0) {
          result.push(Math.trunc(normalizedEmojiId));
        }
        return result;
      },
      [],
    );
    const shouldShowUnknownOpponentSlot =
      event.status === "waiting" && normalizedParticipantCount === 1;
    const overflow = Math.max(
      0,
      normalizedParticipantCount - previewEmojiIds.length,
    );
    const hasBadge = showBadge && overflow > 0;
    const hasPreviewContent =
      previewEmojiIds.length > 0 || shouldShowUnknownOpponentSlot || hasBadge;
    const cloudW = FIGHT_CLOUD_BASE_W;
    const cloud = getFightCloudPath(cloudW, FIGHT_CLOUD_H);

    return {
      preview: (
        <FightCloudWrap>
          <FightCloudCanvas
            width={cloudW}
            height={FIGHT_CLOUD_H}
            viewBox={`0 0 ${cloudW} ${FIGHT_CLOUD_H}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <CloudShape d={cloud} />
          </FightCloudCanvas>
          <FightCloudInner>
            {hasPreviewContent && (
              <EventPreviewGroup>
                {previewEmojiIds.map((emojiId, index) => (
                  <EventAvatarImage
                    key={`slot_${index}`}
                    src={emojis.getEmojiUrl(emojiId.toString())}
                    alt=""
                  />
                ))}
                {shouldShowUnknownOpponentSlot && (
                  <EventAvatarQuestionSlot aria-hidden="true">
                    <EventAvatarQuestionIcon />
                  </EventAvatarQuestionSlot>
                )}
              </EventPreviewGroup>
            )}
          </FightCloudInner>
        </FightCloudWrap>
      ),
      badge: hasBadge && <FightCloudBadge>+{overflow}</FightCloudBadge>,
    };
  };

  const renderGameRows = (gamesToRender: NavigationItem[]) => (
    <>
      {gamesToRender.map((item) => {
        const isGame = item.entityType === "game";
        const isActiveItem = selectedNavigationItemId === item.id;
        const isSelected = isGame && isActiveItem;
        const game = isGame ? item : null;
        const event = item.entityType === "event" ? item : null;
        const isQueueStatus =
          !!game && (game.status === "waiting" || game.status === "pending");
        const canRemove = !!game && game.status === "waiting" && !!onRemoveGame;
        const isRemoving =
          !!game && !!removingGameInviteIds?.has(game.inviteId);
        const shouldHighlightSelectedStatus = event?.status === "waiting";
        const eventTrailingContent =
          event == null ? null : event.status === "active" ? (
            <LiveDot />
          ) : (
            <GameStatus
              $isSelected={isSelected}
              $highlightSelected={shouldHighlightSelectedStatus}
            >
              {getEventStatusLabel(event)}
            </GameStatus>
          );
        const handleRemoveClick = (
          event: React.MouseEvent<HTMLButtonElement>,
        ) => {
          event.preventDefault();
          event.stopPropagation();
          if (!isRemoving && game) {
            onRemoveGame?.(game.inviteId);
          }
        };
        const Row = event ? EventRow : GameRow;
        return (
          <GameRowContainer key={item.id}>
            <Row
              $isSelected={isSelected}
              $hasTrailingAction={canRemove}
              data-navigation-active={isActiveItem ? "true" : undefined}
              data-navigation-selected={isSelected ? "true" : undefined}
              data-navigation-selected-primary={isSelected ? "true" : undefined}
              onClick={() =>
                onSelectGame?.(
                  item,
                  isGame ? { status: item.status } : undefined,
                )
              }
            >
              {isQueueStatus && game ? (
                <>
                  <QueueManaCluster aria-hidden="true">
                    {QUEUE_MANA_SLOTS.map((slot) => (
                      <QueueManaIcon
                        key={slot}
                        $slot={slot}
                        src={queueManaImage}
                        alt=""
                      />
                    ))}
                  </QueueManaCluster>
                  <QueuePrimaryContent>
                    {getQueuePrimaryLabel(game)}
                  </QueuePrimaryContent>
                  {game.status === "pending" ? (
                    <GameStatus>NOW</GameStatus>
                  ) : null}
                </>
              ) : event ? (
                <>
                  {(() => {
                    const previewData = renderEventPreview(event);
                    const { preview, badge } = previewData ?? {
                      preview: null,
                      badge: null,
                    };
                    return (
                      <>
                        {preview}
                        <EventTrailingContent>
                          {badge}
                          {eventTrailingContent}
                        </EventTrailingContent>
                      </>
                    );
                  })()}
                </>
              ) : game ? (
                <>
                  {typeof game.opponentEmoji === "number" ? (
                    <GameEmojiImage
                      src={emojis.getEmojiUrl(game.opponentEmoji.toString())}
                      alt=""
                    />
                  ) : (
                    <GameEmojiPlaceholder />
                  )}
                  <GameText>
                    {game.opponentName && game.opponentName !== ""
                      ? game.opponentName
                      : "anon"}
                  </GameText>
                  {game.status === "active" ? (
                    <LiveDot />
                  ) : (
                    <GameStatus $isSelected={isSelected}>
                      {getGameStatusLabel(game)}
                    </GameStatus>
                  )}
                </>
              ) : null}
            </Row>
            {canRemove && (
              <GameRemoveButton
                type="button"
                aria-label="Remove waiting game"
                $isDisabled={!!isRemoving}
                disabled={!!isRemoving}
                onClick={handleRemoveClick}
              />
            )}
          </GameRowContainer>
        );
      })}
    </>
  );

  const renderLearnSection = () => (
    <>
      {problems.map((item) => {
        const isSelected = selectedProblemId === item.id;
        const isCompleted = completedProblemsSet.has(item.id);
        return (
          <NavigationPickerButton
            key={item.id}
            $isSelected={isSelected}
            data-navigation-selected={isSelected ? "true" : undefined}
            data-navigation-selected-primary={
              !selectedNavigationItemId && isSelected ? "true" : undefined
            }
            onClick={() => handleNavigationSelect(item.id)}
          >
            <PlaceholderImage src={getIconImage(item.icon)} alt="" />
            {item.label}
            {isCompleted ? <CompletedIcon /> : <IncompleteIcon />}
          </NavigationPickerButton>
        );
      })}
    </>
  );

  return (
    <NavigationPickerContainer
      ref={navigationPickerRef}
      onTouchMove={preventScroll}
    >
      {hasScrollableContent && (
        <ScrollableList
          ref={scrollableListRef}
          onScroll={handleScrollableListScroll}
        >
          {shouldRenderWaitingGamesSection &&
            renderGameRows(waitingForOpponentGames)}
          {shouldRenderTopGamesSection && renderGameRows(nonWaitingTopGames)}
          {shouldRenderLearnSection && shouldRenderTopGamesSection && (
            <SectionSeparator />
          )}
          {shouldRenderLearnSection && renderLearnSection()}
          {shouldRenderLearnSection && shouldRenderPagedGamesSection && (
            <SectionSeparator />
          )}
          {shouldRenderPagedGamesSection &&
            renderGameRows(nonWaitingPagedGames)}
        </ScrollableList>
      )}
      {showsHomeNavigation && (
        <HomeBoardButton
          onClick={handleHomeClick}
          $withTopBorder={hasScrollableContent}
        >
          Home Board →
        </HomeBoardButton>
      )}
    </NavigationPickerContainer>
  );
};

export default NavigationPicker;
