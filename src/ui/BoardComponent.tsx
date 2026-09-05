import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import styled from "styled-components";
import { FaTimes, FaCheck } from "react-icons/fa";
import {
  isWatchOnly,
  subscribeToWatchOnly,
  didClickBotStrengthControlButton,
  getCurrentDisplayedBoardSquareTypes,
  subscribeToDisplayedBoardSquareTypes,
} from "../game/gameController";
import type { BoardSquareTypeGrid } from "../game/boardSquareTypes";
import {
  ColorSet,
  colors,
  getCurrentColorSet,
  isCustomPictureBoardEnabled,
  isPangchiuBoard,
  subscribeToBoardColorSetChanges,
} from "../content/boardStyles";
import { defaultInputEventName, isMobile } from "../utils/misc";
import { generateBoardPattern } from "../utils/boardPatternGenerator";
import {
  attachRainbowAura,
  hideRainbowAura as hideAuraDom,
  setRainbowAuraMask,
  showRainbowAura as showAuraDom,
} from "./rainbowAura";
import {
  playerSideMetadata,
  opponentSideMetadata,
  openBoardPlayerInfoProfile,
  setWagerRenderHandler,
  setWagerSlotLayouts,
  WAGER_WIN_PILE_SCALE as WAGER_WIN_STACK_SCALE,
  WagerPileSide,
  WagerPileRect,
  WagerSlotLayout,
  WagerRenderState,
  WagerPileRenderState,
  applyInviteBotButtonLayout,
} from "../game/board";
import {
  setWagerPanelOutsideTapHandler,
  setWagerPanelVisibilityChecker,
} from "./controls/bottomControlsPort";
import {
  bindBoardVideoReactionHandler,
  resetBoardVideoReactionHandler,
  showVideoReaction,
} from "./controls/boardReactionPort";
import { connection } from "../connection/connection";
import { MatchWagerState } from "../connection/connectionModels";
import { subscribeToWagerState } from "../game/wagerState";
import { rocksMiningService } from "../services/rocksMiningService";
import {
  computeAvailableMaterials,
  getFrozenMaterials,
  getFrozenMaterialsStatus,
  subscribeToFrozenMaterials,
} from "../services/wagerMaterialsService";
import { registerBoardTransientUiHandler } from "./uiSession";
import {
  bindBoardUiHandlers,
  createEmptyPlayerInfoOverlayState,
  playerInfoOverlayStatesEqual,
} from "../game/boardUiPort";
import type {
  BoardInviteBotButtonLayout,
  BoardEndOfGameMarker,
  BoardPlayerInfoOverlayState,
  BoardPlayerInfoSlotState,
} from "../game/boardUiPort";
import type { BotAutomoveMode } from "../game/botAutomoveMode";

export type {
  BoardInviteBotButtonLayout,
  BoardPlayerInfoOverlayState,
  BoardPlayerInfoSlotState,
  BoardTimerColor,
} from "../game/boardUiPort";

const PANGCHIU_BOARD_BACKGROUND_URL =
  "https://cdn.lil.org/mons/boards/backgrounds/pangchiu.jpg";

const CircularButton = styled.button`
  width: 50%;
  aspect-ratio: 1;
  border-radius: 50%;
  background-color: var(--boardCircularButtonBackground);
  color: var(--color-blue-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  outline: none;
  border: none;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  overflow: visible;

  @media (hover: hover) and (pointer: fine) {
    &:hover {
      background-color: var(--boardCircularButtonBackgroundHover);
    }
  }

  &:active {
    background-color: var(--boardCircularButtonBackgroundActive);
  }

  @media (prefers-color-scheme: dark) {
    background-color: var(--boardCircularButtonBackgroundDark);
    color: var(--color-blue-primary-dark);

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        background-color: var(--boardCircularButtonBackgroundHoverDark);
      }
    }

    &:active {
      background-color: var(--boardCircularButtonBackgroundActiveDark);
    }
  }

  svg {
    width: 55.5%;
    height: 55.5%;
    min-width: 5px;
    min-height: 5px;
    overflow: visible;
  }
`;

const listeners: Array<() => void> = [];

const subscribeToBoardStyleChanges = (listener: () => void) => {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index > -1) {
      listeners.splice(index, 1);
    }
  };
};

export const updateBoardComponentForBoardStyleChange = () => {
  listeners.forEach((listener) => listener());
};

let latestBoardPlayerInfoOverlayState = createEmptyPlayerInfoOverlayState();
let setTopBoardOverlayVisibleImpl: (
  blurry: boolean,
  svgElement: SVGElement | null,
  withConfirmAndCancelButtons: boolean,
  ok?: () => void,
  cancel?: () => void,
) => void = () => {};
let showRaibowAuraImpl: (
  visible: boolean,
  url: string,
  opponent: boolean,
) => void = () => {};
let updateAuraForAvatarElementImpl: (
  opponent: boolean,
  avatarElement: SVGElement,
) => void = () => {};
let updateWagerPlayerUidsImpl: (
  playerUid: string,
  opponentUid: string,
) => void = () => {};
type BotStrengthControlOverlayState = {
  visible: boolean;
  mode: BotAutomoveMode;
  x: number;
  y: number;
  size: number;
};
let setBoardPlayerInfoOverlayStateImpl: (
  state: BoardPlayerInfoOverlayState,
) => void = () => {};

export const setTopBoardOverlayVisible = (
  blurry: boolean,
  svgElement: SVGElement | null,
  withConfirmAndCancelButtons: boolean,
  ok?: () => void,
  cancel?: () => void,
) => {
  setTopBoardOverlayVisibleImpl(
    blurry,
    svgElement,
    withConfirmAndCancelButtons,
    ok,
    cancel,
  );
};

export { showVideoReaction };

export const showRaibowAura = (
  visible: boolean,
  url: string,
  opponent: boolean,
) => {
  showRaibowAuraImpl(visible, url, opponent);
};

export const updateAuraForAvatarElement = (
  opponent: boolean,
  avatarElement: SVGElement,
) => {
  updateAuraForAvatarElementImpl(opponent, avatarElement);
};

export const updateWagerPlayerUids = (
  playerUid: string,
  opponentUid: string,
) => {
  updateWagerPlayerUidsImpl(playerUid, opponentUid);
};

export const setBoardPlayerInfoOverlayState = (
  state: BoardPlayerInfoOverlayState,
) => {
  latestBoardPlayerInfoOverlayState = state;
  setBoardPlayerInfoOverlayStateImpl(state);
};

const VIDEO_CONTAINER_HEIGHT_GRID = "12.5%";
const VIDEO_CONTAINER_HEIGHT_IMAGE = "13.5%";
const VIDEO_CONTAINER_MAX_HEIGHT = "min(20vh, 180px)";
const VIDEO_CONTAINER_ASPECT_RATIO = "1";
const VIDEO_CONTAINER_Z_INDEX = 10000;
const VIDEO_REACTION_APPEAR_MS = 400;
const VIDEO_REACTION_FADE_OUT_MS = 200;
const VIDEO_REACTION_CLEAR_FADE_OUT_MS = 120;
const VIDEO_REACTION_DEFAULT_LIFETIME_MS = 7000;
const VIDEO_REACTION_MIN_LIFETIME_MS = 1000;
const VIDEO_REACTION_MAX_LIFETIME_MS = 12000;
const VIDEO_REACTION_END_GRACE_MS = 700;
const BOARD_WIDTH_UNITS = 11;
const BOARD_HEIGHT_UNITS = 14.1;
const BOARD_MID_Y_UNITS = BOARD_HEIGHT_UNITS * 0.5;
const BOARD_VIEWBOX_WIDTH = BOARD_WIDTH_UNITS * 100;
const BOARD_VIEWBOX_HEIGHT = BOARD_HEIGHT_UNITS * 100;
const WAGER_PANEL_PADDING_X_FRAC = 0.2;
const WAGER_PANEL_PADDING_Y_FRAC = 0.2;
const WAGER_PANEL_BUTTON_HEIGHT_FRAC = 0.4;
const WAGER_PANEL_BUTTON_GAP_PX = 8;
const WAGER_PANEL_PILE_GAP_FRAC = 0.2;
const WAGER_PANEL_MIN_PADDING_PX = 12;
const WAGER_PANEL_MIN_BUTTON_HEIGHT_PX = 34;
const WAGER_PANEL_MIN_DECLINE_BUTTON_WIDTH_PX = 80;
const WAGER_PANEL_MIN_ACCEPT_BUTTON_WIDTH_PX = 110;
const WAGER_PANEL_MIN_PLAYER_BUTTON_WIDTH_PX = 150;
const WAGER_PANEL_BUTTON_PADDING_X_PX = 16;
const WAGER_PANEL_COUNT_GAP_FRAC = 0.06;
const WAGER_PANEL_COUNT_MIN_GAP_PX = 4;
const WAGER_PANEL_COUNT_MIN_WIDTH_PX = 32;
const WAGER_PANEL_COUNT_Y_OFFSET_FRAC = 0.04;
const wagerUiDebugLogsEnabled = import.meta.env.DEV;
const BOT_STRENGTH_IGNORE_MOUSE_AFTER_TOUCH_MS = 700;
const MIN_HORIZONTAL_OFFSET = 0.21;
const END_OF_GAME_ICON_BASE_URL = "https://cdn.lil.org/mons/icons";
const END_OF_GAME_ICON_URLS = {
  victory: `${END_OF_GAME_ICON_BASE_URL}/victory.webp`,
  resign: `${END_OF_GAME_ICON_BASE_URL}/resign_1.webp`,
} as const;
type EndOfGameIconName = keyof typeof END_OF_GAME_ICON_URLS;
const END_OF_GAME_ICON_OPACITY = 0.69;
const PLAYER_INFO_TEXT_OPACITY = 0.69;
const END_OF_GAME_ICON_SIZE_MULTIPLIER = 0.53;
const END_OF_GAME_ICON_GAP_MULTIPLIER = 0.06;
const END_OF_GAME_NAME_OFFSET_MULTIPLIER = 0.54;
const SCORE_TEXT_FONT_SIZE_MULTIPLIER = 50;
const INVITE_BOT_BUTTON_FONT_TO_SCORE_RATIO = 0.68;
const INVITE_BOT_BUTTON_X_GAP_MULTIPLIER = 0.18;
const INVITE_BOT_BUTTON_HEIGHT_TO_FONT_RATIO = 2.1;
const INVITE_BOT_BUTTON_MIN_FONT_SIZE_PX = 12;
const INVITE_BOT_BUTTON_PADDING_TO_FONT_RATIO = 0.9;
const INVITE_BOT_BUTTON_TEXT_WIDTH_TO_FONT_RATIO = 5.5;
const BOT_STRENGTH_BUTTON_SCALE = 1.23;
const BOT_STRENGTH_BUTTON_SIZE_TO_INVITE_HEIGHT =
  0.82 * BOT_STRENGTH_BUTTON_SCALE;
const BOT_STRENGTH_BUTTON_NAME_GAP_MULTIPLIER =
  0.12 * BOT_STRENGTH_BUTTON_SCALE;
const BOT_STRENGTH_VOICE_REACTION_EXTRA_GAP_MULTIPLIER =
  0.08 * BOT_STRENGTH_BUTTON_SCALE;
const BOT_STRENGTH_BUTTON_LEFT_SHIFT_MULTIPLIER = 0.045;
const WAGER_STACK_NAME_GAP_MULTIPLIER = 0.13;
const WAGER_STACK_REACTION_GAP_MULTIPLIER = 0.08;
const NAME_REACTION_GAP_MULTIPLIER = 0.0777;
const WAGER_STACK_WIDTH_MULTIPLIER = 1.08;
const WAGER_STACK_HEIGHT_MULTIPLIER = 0.94;

const PENDING_PULSE_KEYFRAMES_NAME = "wagerPilePendingPulse";
const PENDING_PULSE_ANIMATION = `${PENDING_PULSE_KEYFRAMES_NAME} 1.4s ease-in-out infinite`;

const injectPendingPulseKeyframes = (() => {
  let injected = false;
  return () => {
    if (injected) return;
    injected = true;
    const style = document.createElement("style");
    style.textContent = `
      @keyframes ${PENDING_PULSE_KEYFRAMES_NAME} {
        0%, 100% { opacity: 1; }
        15% { opacity: 1; }
        40% { opacity: 0.2; }
        60% { opacity: 0.2; }
        85% { opacity: 1; }
      }
    `;
    document.head.appendChild(style);
  };
})();

const getVideoReactionPlaybackLifetimeMs = (videoElement: HTMLVideoElement) => {
  const currentTimeSeconds =
    Number.isFinite(videoElement.currentTime) && videoElement.currentTime > 0
      ? videoElement.currentTime
      : 0;
  const durationMs =
    Number.isFinite(videoElement.duration) && videoElement.duration > 0
      ? Math.max(0, videoElement.duration - currentTimeSeconds) * 1000 +
        VIDEO_REACTION_END_GRACE_MS
      : VIDEO_REACTION_DEFAULT_LIFETIME_MS;
  return Math.min(
    VIDEO_REACTION_MAX_LIFETIME_MS,
    Math.max(VIDEO_REACTION_MIN_LIFETIME_MS, durationMs),
  );
};

const getErrorName = (error: unknown) =>
  error && typeof error === "object" && "name" in error
    ? String((error as { name?: unknown }).name)
    : "";

const endOfGameIconPromises: Map<
  EndOfGameIconName,
  Promise<string | null>
> = new Map();
const endOfGameIconResolvedUrls: Partial<Record<EndOfGameIconName, string>> =
  {};
type EndOfGameIconHrefs = Record<EndOfGameIconName, string>;

const getEndOfGameIconHrefs = (): EndOfGameIconHrefs => ({
  victory: endOfGameIconResolvedUrls.victory || END_OF_GAME_ICON_URLS.victory,
  resign: endOfGameIconResolvedUrls.resign || END_OF_GAME_ICON_URLS.resign,
});

const fetchCachedImageUrl = (url: string): Promise<string | null> =>
  fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error("Failed to fetch image");
      return res.blob();
    })
    .then((blob) => URL.createObjectURL(blob))
    .catch(() => null);

const getEndOfGameIconCachedUrl = (
  name: EndOfGameIconName,
): Promise<string | null> => {
  if (!endOfGameIconPromises.has(name)) {
    const promise = fetchCachedImageUrl(END_OF_GAME_ICON_URLS[name]).then(
      (resolvedUrl) => {
        if (resolvedUrl) {
          endOfGameIconResolvedUrls[name] = resolvedUrl;
        } else {
          endOfGameIconPromises.delete(name);
        }
        return resolvedUrl;
      },
    );
    endOfGameIconPromises.set(name, promise);
  }
  return endOfGameIconPromises.get(name)!;
};

const preloadEndOfGameIcons = () =>
  (Object.keys(END_OF_GAME_ICON_URLS) as EndOfGameIconName[]).map((name) =>
    getEndOfGameIconCachedUrl(name),
  );

const playVideoReactionElement = (
  videoElement: HTMLVideoElement | null,
  onCannotPlay: () => void,
) => {
  if (!videoElement || document.visibilityState !== "visible") {
    return;
  }

  const playPromise = videoElement.play() as Promise<void> | undefined;
  void playPromise?.catch((error: unknown) => {
    const errorName = getErrorName(error);
    if (
      errorName === "AbortError" ||
      document.visibilityState !== "visible" ||
      !videoElement.isConnected ||
      videoElement.ended
    ) {
      return;
    }
    onCannotPlay();
  });
};

const startVideoReactionElement = (
  videoElement: HTMLVideoElement | null,
  onCannotPlay: () => void,
) => {
  if (!videoElement) {
    return;
  }
  videoElement.muted = true;
  videoElement.playsInline = true;
  try {
    videoElement.currentTime = 0;
  } catch {}
  playVideoReactionElement(videoElement, onCannotPlay);
};

const isVideoReactionElementError = (
  event: React.SyntheticEvent<HTMLVideoElement>,
) => event.currentTarget === event.target;

const useVideoReactionSlot = (
  setTrackedTimeout: (callback: () => void, delay: number) => number,
  clearTrackedTimeout: (timeoutId: number | null) => void,
) => {
  const [id, setId] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  const [appearing, setAppearing] = useState(false);
  const [instance, setInstance] = useState(0);
  const dismissTimeoutRef = useRef<number | null>(null);
  const dismissDeadlineRef = useRef<number | null>(null);
  const appearingTimeoutRef = useRef<number | null>(null);
  const lifetimeTimeoutRef = useRef<number | null>(null);
  const lifetimeDeadlineRef = useRef<number | null>(null);
  const instanceRef = useRef(0);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);

  const clearDismissTimeout = useCallback(() => {
    clearTrackedTimeout(dismissTimeoutRef.current);
    dismissTimeoutRef.current = null;
    dismissDeadlineRef.current = null;
  }, [clearTrackedTimeout]);

  const clearAppearingTimeout = useCallback(() => {
    clearTrackedTimeout(appearingTimeoutRef.current);
    appearingTimeoutRef.current = null;
  }, [clearTrackedTimeout]);

  const clearLifetimeTimeout = useCallback(() => {
    clearTrackedTimeout(lifetimeTimeoutRef.current);
    lifetimeTimeoutRef.current = null;
    lifetimeDeadlineRef.current = null;
  }, [clearTrackedTimeout]);

  const dismiss = useCallback(
    (durationMs: number) => {
      clearDismissTimeout();
      clearLifetimeTimeout();
      setAppearing(false);
      setFading(true);
      dismissDeadlineRef.current = Date.now() + durationMs;
      dismissTimeoutRef.current = setTrackedTimeout(() => {
        setVisible(false);
        setFading(false);
        setId(null);
        dismissTimeoutRef.current = null;
        dismissDeadlineRef.current = null;
      }, durationMs);
    },
    [clearDismissTimeout, clearLifetimeTimeout, setTrackedTimeout],
  );

  const fadeOut = useCallback(() => {
    dismiss(VIDEO_REACTION_FADE_OUT_MS);
  }, [dismiss]);

  const fadeOutInstance = useCallback(
    (targetInstance: number) => {
      if (instanceRef.current !== targetInstance) {
        return;
      }
      fadeOut();
    },
    [fadeOut],
  );

  const scheduleLifetimeTimeout = useCallback(
    (durationMs: number, targetInstance: number) => {
      if (
        instanceRef.current !== targetInstance ||
        dismissTimeoutRef.current !== null
      ) {
        return;
      }
      clearLifetimeTimeout();
      lifetimeDeadlineRef.current = Date.now() + durationMs;
      lifetimeTimeoutRef.current = setTrackedTimeout(() => {
        if (instanceRef.current !== targetInstance) {
          return;
        }
        lifetimeTimeoutRef.current = null;
        lifetimeDeadlineRef.current = null;
        fadeOut();
      }, durationMs);
    },
    [clearLifetimeTimeout, fadeOut, setTrackedTimeout],
  );

  const show = useCallback(
    (stickerId: number) => {
      const nextInstance = instanceRef.current + 1;
      instanceRef.current = nextInstance;
      clearDismissTimeout();
      clearAppearingTimeout();
      setId(stickerId);
      setInstance(nextInstance);
      setVisible(true);
      setFading(false);
      setAppearing(true);
      scheduleLifetimeTimeout(VIDEO_REACTION_DEFAULT_LIFETIME_MS, nextInstance);
      appearingTimeoutRef.current = setTrackedTimeout(() => {
        setAppearing(false);
        appearingTimeoutRef.current = null;
      }, VIDEO_REACTION_APPEAR_MS);
    },
    [
      clearAppearingTimeout,
      clearDismissTimeout,
      scheduleLifetimeTimeout,
      setTrackedTimeout,
    ],
  );

  const clearNow = useCallback(() => {
    clearDismissTimeout();
    clearAppearingTimeout();
    clearLifetimeTimeout();
    setVisible(false);
    setFading(false);
    setAppearing(false);
    setId(null);
  }, [clearAppearingTimeout, clearDismissTimeout, clearLifetimeTimeout]);

  const setElementRef = useCallback(
    (videoElement: HTMLVideoElement | null) => {
      videoElementRef.current = videoElement;
      startVideoReactionElement(videoElement, () => {
        fadeOutInstance(instance);
      });
    },
    [fadeOutInstance, instance],
  );

  const syncAfterPageResume = useCallback(
    (now: number) => {
      if (!visible) {
        return;
      }

      if (fading) {
        const dismissDeadline = dismissDeadlineRef.current;
        if (dismissDeadline !== null && now >= dismissDeadline) {
          clearDismissTimeout();
          setVisible(false);
          setFading(false);
          setAppearing(false);
          setId(null);
        }
        return;
      }

      const videoElement = videoElementRef.current;
      const deadline = lifetimeDeadlineRef.current;
      if (
        (deadline !== null && now >= deadline) ||
        videoElement?.ended === true
      ) {
        dismiss(VIDEO_REACTION_CLEAR_FADE_OUT_MS);
        return;
      }

      playVideoReactionElement(videoElement, () => {
        dismiss(VIDEO_REACTION_CLEAR_FADE_OUT_MS);
      });
    },
    [clearDismissTimeout, dismiss, fading, visible],
  );

  const resetTimeoutRefs = useCallback(() => {
    dismissTimeoutRef.current = null;
    dismissDeadlineRef.current = null;
    appearingTimeoutRef.current = null;
    lifetimeTimeoutRef.current = null;
    lifetimeDeadlineRef.current = null;
  }, []);

  return {
    appearing,
    clearNow,
    dismiss,
    fadeOutInstance,
    fading,
    id,
    instance,
    resetTimeoutRefs,
    scheduleLifetimeTimeout,
    setElementRef,
    show,
    syncAfterPageResume,
    visible,
  };
};

type WagerPileElements = {
  player: HTMLDivElement;
  opponent: HTMLDivElement;
  winner: HTMLDivElement;
  playerDisappearing: HTMLDivElement;
  opponentDisappearing: HTMLDivElement;
  playerIcons: HTMLImageElement[];
  opponentIcons: HTMLImageElement[];
  winnerIcons: HTMLImageElement[];
  playerDisappearingIcons: HTMLImageElement[];
  opponentDisappearingIcons: HTMLImageElement[];
};

const toPercentX = (value: number) => (value / BOARD_WIDTH_UNITS) * 100;
const toPercentY = (value: number) => (value / BOARD_HEIGHT_UNITS) * 100;
const toOverlayFontSizePx = (
  svgFontSize: number,
  boardViewportRect: BoardViewportRect,
) => (svgFontSize / BOARD_VIEWBOX_WIDTH) * boardViewportRect.width;

const getRenderedBoardViewportRect = (svg: SVGSVGElement) => {
  const matrix = svg.getScreenCTM?.();
  if (!matrix) {
    return null;
  }
  const point = svg.createSVGPoint();
  point.x = 0;
  point.y = 0;
  const topLeft = point.matrixTransform(matrix);
  point.x = BOARD_VIEWBOX_WIDTH;
  point.y = BOARD_VIEWBOX_HEIGHT;
  const bottomRight = point.matrixTransform(matrix);
  const left = Math.min(topLeft.x, bottomRight.x);
  const top = Math.min(topLeft.y, bottomRight.y);
  const width = Math.abs(bottomRight.x - topLeft.x);
  const height = Math.abs(bottomRight.y - topLeft.y);
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { left, top, width, height };
};

type BoardTextMeasurement = {
  width: number;
  bounds: { y: number; height: number } | null;
};

type BoardViewportRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type BoardPlayerInfoMeasurements = {
  playerScore: BoardTextMeasurement;
  opponentScore: BoardTextMeasurement;
  playerTimer: BoardTextMeasurement;
  opponentTimer: BoardTextMeasurement;
  playerName: BoardTextMeasurement;
  opponentName: BoardTextMeasurement;
};

type BoardPlayerInfoSlotLayout = {
  scoreX: number;
  scoreY: number;
  timerX: number;
  timerY: number;
  nameX: number;
  nameY: number;
  scoreFontSize: number;
  nameFontSize: number;
  endOfGameIcon: {
    visible: boolean;
    href: string;
    x: number;
    y: number;
    size: number;
  };
};

type BoardPlayerInfoLayout = {
  player: BoardPlayerInfoSlotLayout;
  opponent: BoardPlayerInfoSlotLayout;
  inviteBotButtonLayout: BoardInviteBotButtonLayout | null;
  botStrengthControlOverlay: BotStrengthControlOverlayState;
};

const emptyTextMeasurement: BoardTextMeasurement = {
  width: 0,
  bounds: null,
};

const measureBoardText = (
  element: HTMLElement | null,
  boardViewportRect: BoardViewportRect | null,
): BoardTextMeasurement => {
  if (
    !element ||
    !boardViewportRect ||
    boardViewportRect.width <= 0 ||
    boardViewportRect.height <= 0 ||
    element.getClientRects().length === 0
  ) {
    return emptyTextMeasurement;
  }
  const rect = element.getBoundingClientRect();
  const width = (rect.width / boardViewportRect.width) * BOARD_WIDTH_UNITS;
  const bounds =
    Number.isFinite(rect.top) && Number.isFinite(rect.height)
      ? {
          y:
            ((rect.top - boardViewportRect.top) / boardViewportRect.height) *
            BOARD_HEIGHT_UNITS,
          height: (rect.height / boardViewportRect.height) * BOARD_HEIGHT_UNITS,
        }
      : null;
  return {
    width: Number.isFinite(width) && width > 0 ? width : 0,
    bounds,
  };
};

type BoardPlayerInfoTextProps = {
  elementRef?: { current: HTMLSpanElement | null };
  x: number;
  y: number;
  fontSizePx: number;
  color: string;
  opacity: number;
  fontWeight: React.CSSProperties["fontWeight"];
  fontStyle?: React.CSSProperties["fontStyle"];
  visible: boolean;
  interactive?: boolean;
  children: string;
  onClick?: React.MouseEventHandler<HTMLSpanElement>;
  onMouseEnter?: React.MouseEventHandler<HTMLSpanElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLSpanElement>;
  onTouchEnd?: React.TouchEventHandler<HTMLSpanElement>;
  onBaselineChange?: () => void;
};

const BoardPlayerInfoText: React.FC<BoardPlayerInfoTextProps> = ({
  elementRef,
  x,
  y,
  fontSizePx,
  color,
  opacity,
  fontWeight,
  fontStyle,
  visible,
  interactive = false,
  children,
  onClick,
  onMouseEnter,
  onMouseLeave,
  onTouchEnd,
  onBaselineChange,
}) => {
  const textRef = useRef<HTMLSpanElement | null>(null);
  const baselineMarkerRef = useRef<HTMLSpanElement | null>(null);
  const baselineOffsetRef = useRef<number | null>(null);
  const setTextElement = useCallback(
    (element: HTMLSpanElement | null) => {
      textRef.current = element;
      if (elementRef) {
        elementRef.current = element;
      }
    },
    [elementRef],
  );

  useLayoutEffect(() => {
    const textElement = textRef.current;
    const baselineMarker = baselineMarkerRef.current;
    if (!textElement || !baselineMarker || !visible) {
      return;
    }
    const textRect = textElement.getBoundingClientRect();
    const markerRect = baselineMarker.getBoundingClientRect();
    const baselineOffset = markerRect.top - textRect.top;
    if (
      Number.isFinite(baselineOffset) &&
      (baselineOffsetRef.current === null ||
        Math.abs(baselineOffsetRef.current - baselineOffset) > 0.01)
    ) {
      baselineOffsetRef.current = baselineOffset;
      textElement.style.setProperty(
        "--board-player-info-baseline-offset",
        `${baselineOffset}px`,
      );
      onBaselineChange?.();
    }
  }, [children, fontSizePx, fontStyle, fontWeight, onBaselineChange, visible]);

  return (
    <span
      ref={setTextElement}
      style={{
        position: "absolute",
        left: `${toPercentX(x)}%`,
        top: `${toPercentY(y)}%`,
        display: visible ? "inline-block" : "none",
        transform:
          "translateY(calc(-1 * var(--board-player-info-baseline-offset, 0px)))",
        transformOrigin: "left top",
        color,
        opacity,
        fontSize: `${fontSizePx}px`,
        fontWeight,
        fontStyle,
        lineHeight: 1,
        whiteSpace: "nowrap",
        overflow: "visible",
        pointerEvents: interactive ? "auto" : "none",
        cursor: interactive ? "pointer" : "inherit",
        userSelect: "none",
        WebkitUserSelect: "none",
        touchAction: "none",
      }}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onTouchEnd={onTouchEnd}
    >
      <span
        ref={baselineMarkerRef}
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: 0,
          height: 0,
          overflow: "hidden",
          verticalAlign: "baseline",
        }}
      />
      {children}
    </span>
  );
};

const textMeasurementsEqual = (
  a: BoardTextMeasurement,
  b: BoardTextMeasurement,
) =>
  a.width === b.width &&
  a.bounds?.y === b.bounds?.y &&
  a.bounds?.height === b.bounds?.height;

const playerInfoMeasurementsEqual = (
  a: BoardPlayerInfoMeasurements,
  b: BoardPlayerInfoMeasurements,
) =>
  textMeasurementsEqual(a.playerScore, b.playerScore) &&
  textMeasurementsEqual(a.opponentScore, b.opponentScore) &&
  textMeasurementsEqual(a.playerTimer, b.playerTimer) &&
  textMeasurementsEqual(a.opponentTimer, b.opponentTimer) &&
  textMeasurementsEqual(a.playerName, b.playerName) &&
  textMeasurementsEqual(a.opponentName, b.opponentName);

const mergePlayerInfoMeasurements = (
  prevMeasurements: BoardPlayerInfoMeasurements,
  measurements: Partial<BoardPlayerInfoMeasurements>,
) => {
  const nextMeasurements = { ...prevMeasurements, ...measurements };
  return playerInfoMeasurementsEqual(prevMeasurements, nextMeasurements)
    ? prevMeasurements
    : nextMeasurements;
};

const seeIfShouldOffsetFromBorders = () =>
  window.innerWidth / window.innerHeight < 0.72;

const getOuterElementsMultiplicator = (
  boardPixelSize: { width: number; height: number } | null,
) => Math.min(420 / (boardPixelSize?.width || 420), 1);

const getAvatarSize = (
  boardPixelSize: { width: number; height: number } | null,
) => 0.777 * getOuterElementsMultiplicator(boardPixelSize);

type WagerStackRightEdges = Record<WagerPileSide, number>;
type WagerSlotLayoutBySide = Record<WagerPileSide, WagerSlotLayout>;

const emptyWagerStackRightEdges: WagerStackRightEdges = {
  player: 0,
  opponent: 0,
};

const hiddenWagerRect: WagerPileRect = { x: 0, y: 0, w: 0, h: 0 };
const hiddenWagerSlotLayout: WagerSlotLayout = {
  pile: hiddenWagerRect,
  winner: hiddenWagerRect,
};

const clampBoardRect = (
  x: number,
  y: number,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } => ({
  x: Math.max(0, Math.min(BOARD_WIDTH_UNITS - w, x)),
  y: Math.max(0, Math.min(BOARD_HEIGHT_UNITS - h, y)),
  w,
  h,
});

const getWagerStackRectForName = (
  slotLayout: BoardPlayerInfoSlotLayout,
  nameMeasurement: BoardTextMeasurement,
  boardPixelSize: { width: number; height: number } | null,
  scale: number,
) => {
  const multiplicator = getOuterElementsMultiplicator(boardPixelSize);
  const avatarSize = getAvatarSize(boardPixelSize);
  const w = avatarSize * WAGER_STACK_WIDTH_MULTIPLIER * scale;
  const h = avatarSize * WAGER_STACK_HEIGHT_MULTIPLIER * scale;
  const x =
    slotLayout.nameX +
    nameMeasurement.width +
    WAGER_STACK_NAME_GAP_MULTIPLIER * multiplicator;
  const y = slotLayout.nameY - h * 0.86;
  return clampBoardRect(x, y, w, h);
};

const getWagerSlotLayoutForName = (
  slotLayout: BoardPlayerInfoSlotLayout,
  nameMeasurement: BoardTextMeasurement,
  boardPixelSize: { width: number; height: number } | null,
  hasVisibleName: boolean,
): WagerSlotLayout => {
  if (!hasVisibleName) {
    return hiddenWagerSlotLayout;
  }
  return {
    pile: getWagerStackRectForName(
      slotLayout,
      nameMeasurement,
      boardPixelSize,
      1,
    ),
    winner: getWagerStackRectForName(
      slotLayout,
      nameMeasurement,
      boardPixelSize,
      WAGER_WIN_STACK_SCALE,
    ),
  };
};

const playerInfoSlotHasVisibleName = (slot: BoardPlayerInfoSlotState) => {
  return slot.nameVisible && slot.nameText !== "";
};

const playerInfoSlotHasNameReaction = (slot: BoardPlayerInfoSlotState) =>
  slot.nameReactionText !== "";

const getWagerSideForBoardRect = (
  rect: Pick<WagerPileRect, "y">,
): WagerPileSide => (rect.y < BOARD_MID_Y_UNITS ? "opponent" : "player");

const getWagerPileVisualSlot = (pile: WagerPileRenderState): WagerPileSide => {
  if (pile.side === "player" || pile.side === "opponent") {
    return pile.side;
  }
  return getWagerSideForBoardRect(pile.rect);
};

const addWagerStackRightEdgeForPile = (
  rightEdges: WagerStackRightEdges,
  pile: WagerPileRenderState | null,
) => {
  if (!pile) {
    return;
  }
  const slot = getWagerPileVisualSlot(pile);
  rightEdges[slot] = Math.max(rightEdges[slot], pile.rect.x + pile.rect.w);
};

const wagerStackRightEdgesEqual = (
  a: WagerStackRightEdges,
  b: WagerStackRightEdges,
) => a.player === b.player && a.opponent === b.opponent;

const getWagerIconPaintDepth = (
  frame: { y: number },
  rect: Pick<WagerPileRect, "y" | "h">,
) => {
  if (rect.h <= 0) {
    return 0;
  }
  const normalizedTop = (frame.y - rect.y) / rect.h;
  const clampedTop = Math.max(0, Math.min(1, normalizedTop));
  return Math.round((1 - clampedTop) * 1000);
};

const getInviteBotButtonLayout = (
  scoreX: number,
  scoreY: number,
  scoreWidth: number,
  multiplicator: number,
  avatarSize: number,
): BoardInviteBotButtonLayout => {
  const scoreFontBoardUnits =
    (SCORE_TEXT_FONT_SIZE_MULTIPLIER * multiplicator) / 100;
  const fontSizePx = Math.max(
    INVITE_BOT_BUTTON_MIN_FONT_SIZE_PX,
    Math.round(
      SCORE_TEXT_FONT_SIZE_MULTIPLIER *
        multiplicator *
        INVITE_BOT_BUTTON_FONT_TO_SCORE_RATIO,
    ),
  );
  const fontBoardUnits = fontSizePx / 100;
  const height = Math.min(
    fontBoardUnits * INVITE_BOT_BUTTON_HEIGHT_TO_FONT_RATIO,
    avatarSize * 0.88,
  );
  const x =
    scoreX + scoreWidth + INVITE_BOT_BUTTON_X_GAP_MULTIPLIER * multiplicator;
  const horizontalPaddingPx = Math.max(
    6,
    Math.round(fontSizePx * INVITE_BOT_BUTTON_PADDING_TO_FONT_RATIO),
  );
  const width =
    (fontSizePx * INVITE_BOT_BUTTON_TEXT_WIDTH_TO_FONT_RATIO +
      2 * horizontalPaddingPx) /
    100;
  const scoreCenterY = scoreY - scoreFontBoardUnits * 0.35;
  const y = scoreCenterY - height / 2 - 0.023 * multiplicator;
  return { x, y, width, height, fontSizePx, horizontalPaddingPx };
};

const getBotStrengthControlLayout = (
  inviteLayout: BoardInviteBotButtonLayout,
  multiplicator: number,
): { x: number; y: number; size: number } => {
  const size = inviteLayout.height * BOT_STRENGTH_BUTTON_SIZE_TO_INVITE_HEIGHT;
  const x =
    inviteLayout.x - BOT_STRENGTH_BUTTON_LEFT_SHIFT_MULTIPLIER * multiplicator;
  const y = inviteLayout.y + (inviteLayout.height - size) / 2;
  return { x, y, size };
};

const getEndOfGameIconHref = (
  marker: BoardEndOfGameMarker,
  iconHrefs: EndOfGameIconHrefs,
) => {
  if (marker === "none") {
    return "";
  }
  return iconHrefs[marker];
};

const getDynamicNameDelta = ({
  initialX,
  scoreX,
  scoreWidth,
  timerX,
  timerWidth,
  showsTimer,
  endOfGameIcon,
  showsEndOfGameMarker,
  multiplicator,
  extraSpacing = 0,
}: {
  initialX: number;
  scoreX: number;
  scoreWidth: number;
  timerX: number;
  timerWidth: number;
  showsTimer: boolean;
  endOfGameIcon: BoardPlayerInfoSlotLayout["endOfGameIcon"];
  showsEndOfGameMarker: boolean;
  multiplicator: number;
  extraSpacing?: number;
}) => {
  const spacing = 0.14 * multiplicator + extraSpacing;
  const scoreRight = scoreX + scoreWidth;
  let minNameX = scoreRight + spacing;
  if (showsEndOfGameMarker && endOfGameIcon.visible) {
    minNameX = Math.max(
      minNameX,
      endOfGameIcon.x + endOfGameIcon.size + spacing,
    );
  } else if (showsEndOfGameMarker) {
    minNameX = Math.max(
      minNameX,
      scoreRight +
        END_OF_GAME_ICON_GAP_MULTIPLIER * multiplicator +
        END_OF_GAME_ICON_SIZE_MULTIPLIER * multiplicator +
        spacing,
    );
  }
  if (showsTimer) {
    minNameX = Math.max(minNameX, timerX + timerWidth + spacing);
  }
  return Math.max(0, minNameX - initialX);
};

const getBoardPlayerInfoLayout = (
  state: BoardPlayerInfoOverlayState,
  measurements: BoardPlayerInfoMeasurements,
  iconHrefs: EndOfGameIconHrefs,
  boardPixelSize: { width: number; height: number } | null,
  shouldOffsetFromBorders: boolean,
  isPangchiuBoardLayout: boolean,
): BoardPlayerInfoLayout => {
  const multiplicator = getOuterElementsMultiplicator(boardPixelSize);
  const avatarSize = getAvatarSize(boardPixelSize);
  const scoreFontSize = SCORE_TEXT_FONT_SIZE_MULTIPLIER * multiplicator;
  const nameFontSize = 32 * multiplicator;
  const offsetX = shouldOffsetFromBorders ? MIN_HORIZONTAL_OFFSET : 0;
  const iconSize = END_OF_GAME_ICON_SIZE_MULTIPLIER * multiplicator;
  const iconGap = END_OF_GAME_ICON_GAP_MULTIPLIER * multiplicator;

  const baseForSlot = (
    slot: WagerPileSide,
    scoreMeasurement: BoardTextMeasurement,
  ) => {
    const isOpponent = slot === "opponent";
    const y = isOpponent
      ? 1 - avatarSize * 1.203
      : isPangchiuBoardLayout
        ? 12.75
        : 12.16;
    const scoreX = offsetX + avatarSize * 1.21;
    const scoreY = y + avatarSize * 0.73;
    const timerX = offsetX + avatarSize * 1.85;
    const timerY = scoreY;
    const nameY = y + avatarSize * 0.65;
    const inviteLayout = getInviteBotButtonLayout(
      scoreX,
      scoreY,
      scoreMeasurement.width,
      multiplicator,
      avatarSize,
    );
    const botLayout = getBotStrengthControlLayout(inviteLayout, multiplicator);
    return {
      scoreX,
      scoreY,
      timerX,
      timerY,
      nameY,
      inviteLayout,
      botLayout,
    };
  };

  const playerBase = baseForSlot("player", measurements.playerScore);
  const opponentBase = baseForSlot("opponent", measurements.opponentScore);
  const topBase = state.topControlSlot === "player" ? playerBase : opponentBase;
  const topBotLayout = topBase.botLayout;
  const inviteBotButtonLayout = topBase.inviteLayout;

  const getIconLayout = (
    slotState: BoardPlayerInfoSlotState,
    base: ReturnType<typeof baseForSlot>,
    scoreMeasurement: BoardTextMeasurement,
    isTopControlSlot: boolean,
  ): BoardPlayerInfoSlotLayout["endOfGameIcon"] => {
    const visible =
      slotState.visible &&
      slotState.endOfGameMarker !== "none" &&
      slotState.scoreText !== "";
    if (!visible) {
      return {
        visible: false,
        href: "",
        x: 0,
        y: 0,
        size: iconSize,
      };
    }
    let iconX = base.scoreX + scoreMeasurement.width + iconGap;
    if (isTopControlSlot && state.botStrengthControlVisible) {
      iconX = Math.max(iconX, topBotLayout.x + topBotLayout.size + iconGap);
    }
    let iconY = base.scoreY - iconSize * 0.8;
    if (scoreMeasurement.bounds) {
      iconY =
        scoreMeasurement.bounds.y +
        (scoreMeasurement.bounds.height - iconSize) / 2;
    }
    return {
      visible: true,
      href: getEndOfGameIconHref(slotState.endOfGameMarker, iconHrefs),
      x: iconX,
      y: iconY,
      size: iconSize,
    };
  };

  const playerIcon = getIconLayout(
    state.player,
    playerBase,
    measurements.playerScore,
    state.topControlSlot === "player",
  );
  const opponentIcon = getIconLayout(
    state.opponent,
    opponentBase,
    measurements.opponentScore,
    state.topControlSlot === "opponent",
  );

  const initialX = offsetX + 1.45 * multiplicator + 0.1;
  const timerDelta = 0.95 * multiplicator;
  const statusDelta = END_OF_GAME_NAME_OFFSET_MULTIPLIER * multiplicator;
  const playerHasEndOfGameMarker = state.player.endOfGameMarker !== "none";
  const opponentHasEndOfGameMarker = state.opponent.endOfGameMarker !== "none";
  const topControlSlotState =
    state.topControlSlot === "player" ? state.player : state.opponent;
  const topControlSlotHasEndOfGameMarker =
    topControlSlotState.endOfGameMarker !== "none";
  const topControlHasVoiceReaction =
    playerInfoSlotHasNameReaction(topControlSlotState);
  const topVoiceReactionExtraSpacing =
    state.botStrengthControlVisible &&
    topControlSlotHasEndOfGameMarker &&
    topControlHasVoiceReaction
      ? BOT_STRENGTH_VOICE_REACTION_EXTRA_GAP_MULTIPLIER * multiplicator
      : 0;

  const playerStaticDelta =
    (playerHasEndOfGameMarker ? statusDelta : 0) +
    (state.player.timerVisible ? timerDelta : 0);
  const opponentStaticDelta =
    (opponentHasEndOfGameMarker ? statusDelta : 0) +
    (state.opponent.timerVisible ? timerDelta : 0);
  const playerDynamicDelta = getDynamicNameDelta({
    initialX,
    scoreX: playerBase.scoreX,
    scoreWidth: measurements.playerScore.width,
    timerX: playerBase.timerX,
    timerWidth: measurements.playerTimer.width,
    showsTimer: state.player.timerVisible,
    endOfGameIcon: playerIcon,
    showsEndOfGameMarker: playerHasEndOfGameMarker,
    multiplicator,
    extraSpacing:
      state.topControlSlot === "player" ? topVoiceReactionExtraSpacing : 0,
  });
  const opponentDynamicDelta = getDynamicNameDelta({
    initialX,
    scoreX: opponentBase.scoreX,
    scoreWidth: measurements.opponentScore.width,
    timerX: opponentBase.timerX,
    timerWidth: measurements.opponentTimer.width,
    showsTimer: state.opponent.timerVisible,
    endOfGameIcon: opponentIcon,
    showsEndOfGameMarker: opponentHasEndOfGameMarker,
    multiplicator,
    extraSpacing:
      state.topControlSlot === "opponent" ? topVoiceReactionExtraSpacing : 0,
  });

  let playerBotStrengthDelta = 0;
  let opponentBotStrengthDelta = 0;
  if (state.botStrengthControlVisible) {
    const minNameX =
      topBotLayout.x +
      topBotLayout.size +
      BOT_STRENGTH_BUTTON_NAME_GAP_MULTIPLIER * multiplicator;
    const delta = Math.max(0, minNameX - initialX);
    if (state.topControlSlot === "player") {
      playerBotStrengthDelta = delta;
    } else {
      opponentBotStrengthDelta = delta;
    }
  }

  return {
    player: {
      ...playerBase,
      nameX:
        initialX +
        Math.max(playerStaticDelta, playerDynamicDelta, playerBotStrengthDelta),
      scoreFontSize,
      nameFontSize,
      endOfGameIcon: playerIcon,
    },
    opponent: {
      ...opponentBase,
      nameX:
        initialX +
        Math.max(
          opponentStaticDelta,
          opponentDynamicDelta,
          opponentBotStrengthDelta,
        ),
      scoreFontSize,
      nameFontSize,
      endOfGameIcon: opponentIcon,
    },
    inviteBotButtonLayout,
    botStrengthControlOverlay: {
      visible: state.botStrengthControlVisible && topBotLayout.size > 0,
      mode: state.botStrengthControlMode,
      x: topBotLayout.x,
      y: topBotLayout.y,
      size: topBotLayout.size,
    },
  };
};

const getWagerPanelLayout = (
  rect: { x: number; y: number; w: number; h: number },
  isOpponent: boolean,
  boardPixelSize: { width: number; height: number } | null,
  hasActions: boolean,
): {
  x: number;
  y: number;
  width: number;
  height: number;
  gridRows: string;
  paddingXPx: number;
  pileRow: number;
  buttonRow: number;
  buttonGapPx: number;
  declineButtonMinWidthPx: number;
  acceptButtonMinWidthPx: number;
  playerButtonMinWidthPx: number;
  buttonPaddingXPx: number;
  countGap: number;
} => {
  const pxPerUnitX = boardPixelSize
    ? boardPixelSize.width / BOARD_WIDTH_UNITS
    : null;
  const pxPerUnitY = boardPixelSize
    ? boardPixelSize.height / BOARD_HEIGHT_UNITS
    : null;
  const minPaddingX = pxPerUnitX ? WAGER_PANEL_MIN_PADDING_PX / pxPerUnitX : 0;
  const minPaddingY = pxPerUnitY ? WAGER_PANEL_MIN_PADDING_PX / pxPerUnitY : 0;
  const paddingX = Math.max(rect.w * WAGER_PANEL_PADDING_X_FRAC, minPaddingX);
  const paddingY = Math.max(rect.h * WAGER_PANEL_PADDING_Y_FRAC, minPaddingY);
  const minButtonHeight = pxPerUnitY
    ? WAGER_PANEL_MIN_BUTTON_HEIGHT_PX / pxPerUnitY
    : 0;
  const buttonHeight = hasActions
    ? Math.max(rect.h * WAGER_PANEL_BUTTON_HEIGHT_FRAC, minButtonHeight)
    : 0;
  const minCountGap = pxPerUnitX
    ? WAGER_PANEL_COUNT_MIN_GAP_PX / pxPerUnitX
    : 0;
  const countGap = Math.max(rect.w * WAGER_PANEL_COUNT_GAP_FRAC, minCountGap);
  const minCountWidth = pxPerUnitX
    ? WAGER_PANEL_COUNT_MIN_WIDTH_PX / pxPerUnitX
    : 0;
  const pileGap = hasActions ? rect.h * WAGER_PANEL_PILE_GAP_FRAC : 0;
  const borderAndBufferPx = 4;
  const opponentButtonsMinWidthPx =
    WAGER_PANEL_MIN_DECLINE_BUTTON_WIDTH_PX +
    WAGER_PANEL_MIN_ACCEPT_BUTTON_WIDTH_PX +
    WAGER_PANEL_BUTTON_GAP_PX +
    borderAndBufferPx;
  const playerButtonMinWidthPx =
    WAGER_PANEL_MIN_PLAYER_BUTTON_WIDTH_PX + borderAndBufferPx;
  const buttonRowMinWidthPx = isOpponent
    ? opponentButtonsMinWidthPx
    : playerButtonMinWidthPx;
  const buttonRowMinWidthUnits = pxPerUnitX
    ? buttonRowMinWidthPx / pxPerUnitX
    : 0;
  const minPanelContentWidth = rect.w + countGap + minCountWidth;
  const buttonRowWidth = hasActions
    ? Math.max(rect.w, buttonRowMinWidthUnits, minPanelContentWidth)
    : minPanelContentWidth;
  const panelWidth = buttonRowWidth + paddingX * 2;
  const panelHeight = rect.h + paddingY * 2 + pileGap + buttonHeight;
  const centerX = rect.x + rect.w / 2;
  const panelX = centerX - panelWidth / 2;
  const panelY = isOpponent
    ? rect.y - paddingY
    : rect.y - (panelHeight - rect.h - paddingY);
  const rowValues = hasActions
    ? isOpponent
      ? [paddingY, rect.h, pileGap, buttonHeight, paddingY]
      : [paddingY, buttonHeight, pileGap, rect.h, paddingY]
    : [paddingY, rect.h, paddingY];
  const gridRows = rowValues
    .map((value) => `${(value / panelHeight) * 100}%`)
    .join(" ");
  const paddingXPx = pxPerUnitX
    ? paddingX * pxPerUnitX
    : WAGER_PANEL_MIN_PADDING_PX;
  const pileRow = hasActions ? (isOpponent ? 2 : 4) : 2;
  const buttonRow = hasActions ? (isOpponent ? 4 : 2) : 0;

  return {
    x: panelX,
    y: panelY,
    width: panelWidth,
    height: panelHeight,
    gridRows,
    paddingXPx,
    pileRow,
    buttonRow,
    buttonGapPx: WAGER_PANEL_BUTTON_GAP_PX,
    declineButtonMinWidthPx: WAGER_PANEL_MIN_DECLINE_BUTTON_WIDTH_PX,
    acceptButtonMinWidthPx: WAGER_PANEL_MIN_ACCEPT_BUTTON_WIDTH_PX,
    playerButtonMinWidthPx: WAGER_PANEL_MIN_PLAYER_BUTTON_WIDTH_PX,
    buttonPaddingXPx: WAGER_PANEL_BUTTON_PADDING_X_PX,
    countGap,
  };
};

const BoardComponent: React.FC = () => {
  injectPendingPulseKeyframes();

  const transitionTimeoutIdsRef = useRef<Set<number>>(new Set());
  const [currentColorSet, setCurrentColorSet] =
    useState<ColorSet>(getCurrentColorSet());
  const [playerInfoOverlayState, setPlayerInfoOverlayState] =
    useState<BoardPlayerInfoOverlayState>(
      () => latestBoardPlayerInfoOverlayState,
    );
  const [endOfGameIconHrefs, setEndOfGameIconHrefs] =
    useState<EndOfGameIconHrefs>(getEndOfGameIconHrefs);
  const [prefersDarkMode, setPrefersDarkMode] = useState(
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [isGridVisible, setIsGridVisible] = useState(
    !isCustomPictureBoardEnabled(),
  );
  const [isPangchiuBoardLayout, setIsPangchiuBoardLayout] =
    useState(isPangchiuBoard());
  const [shouldIncludePictureBoardImage, setShouldIncludePictureBoardImage] =
    useState(isCustomPictureBoardEnabled());
  const [loadedPictureBoardUrls, setLoadedPictureBoardUrls] = useState<
    Record<string, true>
  >({});
  const [displayedBoardSquareTypes, setDisplayedBoardSquareTypes] =
    useState<BoardSquareTypeGrid | null>(() =>
      getCurrentDisplayedBoardSquareTypes(),
    );
  const [overlayState, setOverlayState] = useState<{
    blurry: boolean;
    svgElement: SVGElement | null;
    withConfirmAndCancelButtons: boolean;
    ok?: () => void;
    cancel?: () => void;
  }>({ blurry: true, svgElement: null, withConfirmAndCancelButtons: false });
  const [wagerState, setWagerState] = useState<MatchWagerState | null>(null);
  const [miningMaterials, setMiningMaterials] = useState(
    rocksMiningService.getSnapshot().materials,
  );
  const [frozenMaterials, setFrozenMaterialsState] =
    useState(getFrozenMaterials());
  const [frozenMaterialsStatus, setFrozenMaterialsStatus] = useState(
    getFrozenMaterialsStatus,
  );
  const [watchOnlySnapshot, setWatchOnlySnapshot] = useState(isWatchOnly);
  const [playerUidSnapshot, setPlayerUidSnapshot] = useState(
    playerSideMetadata.uid,
  );
  const [opponentUidSnapshot, setOpponentUidSnapshot] = useState(
    opponentSideMetadata.uid,
  );
  const [activeWagerPanelSide, setActiveWagerPanelSide] = useState<
    WagerPileSide | "winner" | null
  >(null);
  const [activeWagerPanelRect, setActiveWagerPanelRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const [activeWagerPanelCount, setActiveWagerPanelCount] = useState<
    number | null
  >(null);
  const [botStrengthHovered, setBotStrengthHovered] = useState(false);
  const [botStrengthPressed, setBotStrengthPressed] = useState(false);
  const [boardPixelSize, setBoardPixelSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [boardViewportRect, setBoardViewportRect] =
    useState<BoardViewportRect | null>(null);
  const [isNarrowBoardViewport, setIsNarrowBoardViewport] = useState(
    seeIfShouldOffsetFromBorders(),
  );
  const boardSvgRef = useRef<SVGSVGElement | null>(null);
  const wagerPilesLayerRef = useRef<HTMLDivElement | null>(null);
  const wagerPileElementsRef = useRef<WagerPileElements | null>(null);
  const wagerRenderStateRef = useRef<WagerRenderState | null>(null);
  const activeWagerPanelSideRef = useRef<WagerPileSide | "winner" | null>(null);
  const activeWagerPanelRectRef = useRef<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const activeWagerPanelCountRef = useRef<number | null>(null);
  const disappearingAnimationStartedRef = useRef<{
    player: boolean;
    opponent: boolean;
  }>({ player: false, opponent: false });
  const pendingBlinkDelayTimersRef = useRef<{
    player: number | null;
    opponent: number | null;
  }>({ player: null, opponent: null });
  const pendingBlinkEnabledRef = useRef<{ player: boolean; opponent: boolean }>(
    { player: false, opponent: false },
  );
  const previousMaterialUrlRef = useRef<{
    player: string | null;
    opponent: string | null;
  }>({ player: null, opponent: null });
  const materialChangeOldIconsRef = useRef<{
    player: HTMLImageElement[];
    opponent: HTMLImageElement[];
  }>({ player: [], opponent: [] });
  const lastWagerUiRenderSignatureRef = useRef<string>("");
  const wagerPanelStateRef = useRef<{
    actionsLocked: boolean;
    playerHasProposal: boolean;
    opponentHasProposal: boolean;
  }>({
    actionsLocked: true,
    playerHasProposal: false,
    opponentHasProposal: false,
  });
  const opponentAuraContainerRef = useRef<HTMLDivElement | null>(null);
  const playerAuraContainerRef = useRef<HTMLDivElement | null>(null);
  const opponentAuraRefs = useRef<{
    background: HTMLDivElement;
    inner: HTMLDivElement;
  } | null>(null);
  const playerAuraRefs = useRef<{
    background: HTMLDivElement;
    inner: HTMLDivElement;
  } | null>(null);
  const auraLayerRef = useRef<HTMLDivElement | null>(null);
  const opponentWrapperRef = useRef<HTMLDivElement | null>(null);
  const playerWrapperRef = useRef<HTMLDivElement | null>(null);
  const botStrengthIgnoreMouseUntilRef = useRef(0);
  const playerScoreTextRef = useRef<HTMLSpanElement | null>(null);
  const opponentScoreTextRef = useRef<HTMLSpanElement | null>(null);
  const playerTimerTextRef = useRef<HTMLSpanElement | null>(null);
  const opponentTimerTextRef = useRef<HTMLSpanElement | null>(null);
  const playerNameTextRef = useRef<HTMLSpanElement | null>(null);
  const opponentNameTextRef = useRef<HTMLSpanElement | null>(null);
  const [playerInfoMeasurements, setPlayerInfoMeasurements] =
    useState<BoardPlayerInfoMeasurements>({
      playerScore: emptyTextMeasurement,
      opponentScore: emptyTextMeasurement,
      playerTimer: emptyTextMeasurement,
      opponentTimer: emptyTextMeasurement,
      playerName: emptyTextMeasurement,
      opponentName: emptyTextMeasurement,
    });
  const [wagerStackRightEdges, setWagerStackRightEdges] =
    useState<WagerStackRightEdges>(emptyWagerStackRightEdges);
  const wagerStackRightEdgesRef = useRef<WagerStackRightEdges>(
    emptyWagerStackRightEdges,
  );
  const [hoveredPlayerInfoSlot, setHoveredPlayerInfoSlot] =
    useState<WagerPileSide | null>(null);
  const [playerInfoTextLayoutVersion, setPlayerInfoTextLayoutVersion] =
    useState(0);

  setBoardPlayerInfoOverlayStateImpl = (
    nextState: BoardPlayerInfoOverlayState,
  ) => {
    setPlayerInfoOverlayState((prevState) =>
      playerInfoOverlayStatesEqual(prevState, nextState)
        ? prevState
        : nextState,
    );
  };

  updateWagerPlayerUidsImpl = (
    nextPlayerUid: string,
    nextOpponentUid: string,
  ) => {
    setPlayerUidSnapshot((prev) =>
      prev === nextPlayerUid ? prev : nextPlayerUid,
    );
    setOpponentUidSnapshot((prev) =>
      prev === nextOpponentUid ? prev : nextOpponentUid,
    );
  };

  updateAuraForAvatarElementImpl = (
    opponent: boolean,
    avatarElement: SVGElement,
  ) => {
    const rect = avatarElement.getBoundingClientRect();
    const wrapper = opponent
      ? opponentWrapperRef.current
      : playerWrapperRef.current;
    const targets = opponent ? opponentAuraRefs : playerAuraRefs;
    const container = opponent
      ? opponentAuraContainerRef.current
      : playerAuraContainerRef.current;
    if (wrapper) {
      wrapper.style.position = "absolute";
      wrapper.style.left = `${rect.left}px`;
      wrapper.style.top = `${rect.top}px`;
      wrapper.style.width = `${rect.width}px`;
      wrapper.style.height = `${rect.height}px`;
      wrapper.style.pointerEvents = "none";
      wrapper.style.touchAction = "none";
      wrapper.style.zIndex = "10";
    }
    if (!targets.current && container) {
      targets.current = attachRainbowAura(container);
    }
    if (targets.current) {
      const isHidden =
        avatarElement.style.display === "none" ||
        avatarElement.style.visibility === "hidden";
      if (isHidden) {
        hideAuraDom(targets.current.background);
      }
    }
  };

  const handleConfirmClick = () => {
    if (overlayState.ok) {
      overlayState.ok();
    }
  };

  const handleCancelClick = () => {
    if (overlayState.cancel) {
      overlayState.cancel();
    }
  };

  const setTrackedTimeout = useCallback(
    (callback: () => void, delay: number): number => {
      const timeoutId = window.setTimeout(() => {
        transitionTimeoutIdsRef.current.delete(timeoutId);
        callback();
      }, delay);
      transitionTimeoutIdsRef.current.add(timeoutId);
      return timeoutId;
    },
    [],
  );

  const clearTrackedTimeout = useCallback((timeoutId: number | null) => {
    if (timeoutId === null) {
      return;
    }
    transitionTimeoutIdsRef.current.delete(timeoutId);
    window.clearTimeout(timeoutId);
  }, []);

  const clearAllTrackedTimeouts = useCallback(() => {
    transitionTimeoutIdsRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    transitionTimeoutIdsRef.current.clear();
  }, []);

  const {
    appearing: opponentVideoAppearing,
    clearNow: clearOpponentVideoNow,
    dismiss: dismissOpponentVideo,
    fadeOutInstance: fadeOutOpponentVideoInstance,
    fading: opponentVideoFading,
    id: opponentVideoId,
    instance: opponentVideoInstance,
    resetTimeoutRefs: resetOpponentVideoTimeoutRefs,
    scheduleLifetimeTimeout: scheduleOpponentVideoLifetimeTimeout,
    setElementRef: setOpponentVideoElementRef,
    show: showOpponentVideoReaction,
    syncAfterPageResume: syncOpponentVideoAfterPageResume,
    visible: opponentVideoVisible,
  } = useVideoReactionSlot(setTrackedTimeout, clearTrackedTimeout);

  const {
    appearing: playerVideoAppearing,
    clearNow: clearPlayerVideoNow,
    dismiss: dismissPlayerVideo,
    fadeOutInstance: fadeOutPlayerVideoInstance,
    fading: playerVideoFading,
    id: playerVideoId,
    instance: playerVideoInstance,
    resetTimeoutRefs: resetPlayerVideoTimeoutRefs,
    scheduleLifetimeTimeout: schedulePlayerVideoLifetimeTimeout,
    setElementRef: setPlayerVideoElementRef,
    show: showPlayerVideoReaction,
    syncAfterPageResume: syncPlayerVideoAfterPageResume,
    visible: playerVideoVisible,
  } = useVideoReactionSlot(setTrackedTimeout, clearTrackedTimeout);

  const clearVideoReactionsNow = useCallback(() => {
    clearOpponentVideoNow();
    clearPlayerVideoNow();
  }, [clearOpponentVideoNow, clearPlayerVideoNow]);

  bindBoardVideoReactionHandler((opponent: boolean, stickerId: number) => {
    if (opponent) {
      showOpponentVideoReaction(stickerId);
    } else {
      showPlayerVideoReaction(stickerId);
    }
  });

  const syncVideoReactionsAfterPageResume = useCallback(() => {
    if (document.visibilityState === "hidden") {
      return;
    }

    const now = Date.now();
    syncOpponentVideoAfterPageResume(now);
    syncPlayerVideoAfterPageResume(now);
  }, [syncOpponentVideoAfterPageResume, syncPlayerVideoAfterPageResume]);

  useEffect(() => {
    document.addEventListener(
      "visibilitychange",
      syncVideoReactionsAfterPageResume,
    );
    window.addEventListener("focus", syncVideoReactionsAfterPageResume);
    window.addEventListener("pageshow", syncVideoReactionsAfterPageResume);
    return () => {
      document.removeEventListener(
        "visibilitychange",
        syncVideoReactionsAfterPageResume,
      );
      window.removeEventListener("focus", syncVideoReactionsAfterPageResume);
      window.removeEventListener("pageshow", syncVideoReactionsAfterPageResume);
    };
  }, [syncVideoReactionsAfterPageResume]);

  setTopBoardOverlayVisibleImpl = (
    blurry: boolean,
    svgElement: SVGElement | null,
    withConfirmAndCancelButtons: boolean,
    ok?: () => void,
    cancel?: () => void,
  ) => {
    setOverlayState({
      blurry,
      svgElement,
      withConfirmAndCancelButtons,
      ok,
      cancel,
    });
  };

  showRaibowAuraImpl = (visible: boolean, url: string, opponent: boolean) => {
    const targets = opponent ? opponentAuraRefs : playerAuraRefs;
    const container = opponent
      ? opponentAuraContainerRef.current
      : playerAuraContainerRef.current;
    if (!targets.current && container) {
      targets.current = attachRainbowAura(container);
    }
    if (!targets.current) return;
    setRainbowAuraMask(targets.current.inner, url);
    if (visible) {
      showAuraDom(targets.current.background);
    } else {
      hideAuraDom(targets.current.background);
    }
  };

  const proposals = wagerState?.proposals || {};
  const playerUid = playerUidSnapshot;
  const opponentUid = opponentUidSnapshot;
  const playerProposal =
    playerUid && proposals[playerUid] ? proposals[playerUid] : null;
  const opponentProposal =
    opponentUid && proposals[opponentUid] ? proposals[opponentUid] : null;
  const wagerAgreement = wagerState?.agreed ?? null;
  const wagerResolved = wagerState?.resolved ?? null;
  const wagerActionsLocked =
    watchOnlySnapshot || !!wagerAgreement || !!wagerResolved;
  const availableMaterials = computeAvailableMaterials(
    miningMaterials,
    frozenMaterials,
  );
  const opponentMaterial = opponentProposal?.material ?? null;
  const opponentCount = opponentProposal?.count ?? 0;
  const extraAvailable =
    playerProposal &&
    opponentMaterial &&
    playerProposal.material === opponentMaterial
      ? playerProposal.count
      : 0;
  const acceptCount = opponentMaterial
    ? Math.min(
        opponentCount,
        (availableMaterials[opponentMaterial] ?? 0) + extraAvailable,
      )
    : 0;
  const acceptLabel =
    frozenMaterialsStatus !== "ready"
      ? frozenMaterialsStatus === "unavailable"
        ? "Balance unavailable"
        : "Checking balance"
      : acceptCount > 0 && acceptCount < opponentCount
        ? `Accept (${acceptCount})`
        : "Accept";
  const canAccept = frozenMaterialsStatus === "ready" && acceptCount > 0;
  const showOpponentActions =
    !wagerActionsLocked &&
    activeWagerPanelSide === "opponent" &&
    !!opponentProposal;
  const showPlayerActions =
    !wagerActionsLocked &&
    activeWagerPanelSide === "player" &&
    !!playerProposal;
  const wagerPanelHasActions = showOpponentActions || showPlayerActions;

  useEffect(() => {
    const unsubscribe = subscribeToWagerState((state) => {
      setWagerState(state);
      setWatchOnlySnapshot(isWatchOnly);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToWatchOnly((value) => {
      setWatchOnlySnapshot(value);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToDisplayedBoardSquareTypes(
      setDisplayedBoardSquareTypes,
    );
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = rocksMiningService.subscribe((snapshot) => {
      setMiningMaterials(snapshot.materials);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToFrozenMaterials((materials, status) => {
      setFrozenMaterialsState(materials);
      setFrozenMaterialsStatus(status);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const updateColorSetAndGrid = () => {
      setCurrentColorSet(getCurrentColorSet());
      const newIsGridVisible = !isCustomPictureBoardEnabled();
      setIsGridVisible(newIsGridVisible);
      setIsPangchiuBoardLayout(isPangchiuBoard());
      if (!newIsGridVisible) {
        setShouldIncludePictureBoardImage(true);
      }
    };

    const unsubscribeBoardStyle = subscribeToBoardStyleChanges(
      updateColorSetAndGrid,
    );
    const unsubscribeBoardColorSet = subscribeToBoardColorSetChanges(
      updateColorSetAndGrid,
    );
    return () => {
      unsubscribeBoardStyle();
      unsubscribeBoardColorSet();
    };
  }, []);

  useEffect(() => {
    activeWagerPanelSideRef.current = activeWagerPanelSide;
  }, [activeWagerPanelSide]);

  useEffect(() => {
    activeWagerPanelRectRef.current = activeWagerPanelRect;
  }, [activeWagerPanelRect]);

  useEffect(() => {
    activeWagerPanelCountRef.current = activeWagerPanelCount;
  }, [activeWagerPanelCount]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (matches: boolean) => {
      setPrefersDarkMode((prev) => (prev === matches ? prev : matches));
    };
    const handleChange = (event: MediaQueryListEvent) => {
      update(event.matches);
    };
    update(mediaQuery.matches);
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => {
        mediaQuery.removeEventListener("change", handleChange);
      };
    }
    mediaQuery.addListener(handleChange);
    return () => {
      mediaQuery.removeListener(handleChange);
    };
  }, []);

  useEffect(() => {
    if (!botStrengthPressed) {
      return;
    }
    const clearPressed = () => {
      setBotStrengthPressed(false);
    };
    window.addEventListener("touchend", clearPressed, { passive: true });
    window.addEventListener("touchcancel", clearPressed, { passive: true });
    window.addEventListener("mouseup", clearPressed);
    window.addEventListener("blur", clearPressed);
    return () => {
      window.removeEventListener("touchend", clearPressed);
      window.removeEventListener("touchcancel", clearPressed);
      window.removeEventListener("mouseup", clearPressed);
      window.removeEventListener("blur", clearPressed);
    };
  }, [botStrengthPressed]);

  useEffect(() => {
    wagerPanelStateRef.current = {
      actionsLocked: wagerActionsLocked,
      playerHasProposal: !!playerProposal,
      opponentHasProposal: !!opponentProposal,
    };
  }, [opponentProposal, playerProposal, wagerActionsLocked]);

  useLayoutEffect(() => {
    const updateSize = () => {
      const svg = boardSvgRef.current;
      if (!svg) {
        return;
      }
      const rect =
        getRenderedBoardViewportRect(svg) ?? svg.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        return;
      }
      const nextIsNarrowBoardViewport = seeIfShouldOffsetFromBorders();
      setIsNarrowBoardViewport((prev) =>
        prev === nextIsNarrowBoardViewport ? prev : nextIsNarrowBoardViewport,
      );
      setBoardPixelSize((prev) => {
        if (prev && prev.width === rect.width && prev.height === rect.height) {
          return prev;
        }
        return { width: rect.width, height: rect.height };
      });
      setBoardViewportRect((prev) => {
        if (
          prev &&
          prev.left === rect.left &&
          prev.top === rect.top &&
          prev.width === rect.width &&
          prev.height === rect.height
        ) {
          return prev;
        }
        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
      });
    };
    const svg = boardSvgRef.current;
    const resizeObserver =
      svg && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(updateSize)
        : null;
    const visualViewport = window.visualViewport;
    updateSize();
    if (resizeObserver && svg) {
      resizeObserver.observe(svg);
    }
    window.addEventListener("resize", updateSize);
    visualViewport?.addEventListener("resize", updateSize);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateSize);
      visualViewport?.removeEventListener("resize", updateSize);
    };
  }, [isGridVisible]);

  useEffect(() => {
    let cancelled = false;
    preloadEndOfGameIcons().forEach((promise) => {
      void promise.then((resolvedUrl) => {
        if (!cancelled && resolvedUrl) {
          setEndOfGameIconHrefs(getEndOfGameIconHrefs());
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useLayoutEffect(() => {
    const scoreAndTimerMeasurements = {
      playerScore: measureBoardText(
        playerScoreTextRef.current,
        boardViewportRect,
      ),
      opponentScore: measureBoardText(
        opponentScoreTextRef.current,
        boardViewportRect,
      ),
      playerTimer: measureBoardText(
        playerTimerTextRef.current,
        boardViewportRect,
      ),
      opponentTimer: measureBoardText(
        opponentTimerTextRef.current,
        boardViewportRect,
      ),
    };
    setPlayerInfoMeasurements((prevMeasurements) =>
      mergePlayerInfoMeasurements(prevMeasurements, scoreAndTimerMeasurements),
    );
  }, [
    boardPixelSize,
    boardViewportRect,
    isGridVisible,
    playerInfoOverlayState.opponent.scoreText,
    playerInfoOverlayState.opponent.timerText,
    playerInfoOverlayState.opponent.timerVisible,
    playerInfoOverlayState.opponent.visible,
    playerInfoTextLayoutVersion,
    playerInfoOverlayState.player.scoreText,
    playerInfoOverlayState.player.timerText,
    playerInfoOverlayState.player.timerVisible,
    playerInfoOverlayState.player.visible,
  ]);

  useLayoutEffect(() => {
    const nameMeasurements = {
      playerName: measureBoardText(
        playerNameTextRef.current,
        boardViewportRect,
      ),
      opponentName: measureBoardText(
        opponentNameTextRef.current,
        boardViewportRect,
      ),
    };
    setPlayerInfoMeasurements((prevMeasurements) =>
      mergePlayerInfoMeasurements(prevMeasurements, nameMeasurements),
    );
  }, [
    boardPixelSize,
    boardViewportRect,
    isGridVisible,
    playerInfoOverlayState.opponent.nameText,
    playerInfoOverlayState.opponent.nameVisible,
    playerInfoTextLayoutVersion,
    playerInfoOverlayState.player.nameText,
    playerInfoOverlayState.player.nameVisible,
  ]);

  const clearWagerPanel = useCallback(() => {
    activeWagerPanelSideRef.current = null;
    activeWagerPanelRectRef.current = null;
    activeWagerPanelCountRef.current = null;
    setActiveWagerPanelSide(null);
    setActiveWagerPanelRect(null);
    setActiveWagerPanelCount(null);
  }, []);

  const clearPendingWagerTransitionState = useCallback(() => {
    clearAllTrackedTimeouts();
    (["player", "opponent"] as const).forEach((sideKey) => {
      pendingBlinkDelayTimersRef.current[sideKey] = null;
      pendingBlinkEnabledRef.current[sideKey] = false;
      previousMaterialUrlRef.current[sideKey] = null;
      materialChangeOldIconsRef.current[sideKey].forEach((icon) =>
        icon.remove(),
      );
      materialChangeOldIconsRef.current[sideKey] = [];
    });
    resetOpponentVideoTimeoutRefs();
    resetPlayerVideoTimeoutRefs();
  }, [
    clearAllTrackedTimeouts,
    resetOpponentVideoTimeoutRefs,
    resetPlayerVideoTimeoutRefs,
  ]);

  useEffect(() => {
    return () => {
      clearPendingWagerTransitionState();
      setTopBoardOverlayVisibleImpl = () => {};
      resetBoardVideoReactionHandler();
      showRaibowAuraImpl = () => {};
      updateAuraForAvatarElementImpl = () => {};
      updateWagerPlayerUidsImpl = () => {};
      setBoardPlayerInfoOverlayStateImpl = () => {};
      applyInviteBotButtonLayout(null);
    };
  }, [clearPendingWagerTransitionState]);

  const clearBoardTransientUiHandler = useCallback(
    (fadeOutVideos: boolean = true) => {
      clearWagerPanel();
      clearPendingWagerTransitionState();
      setOverlayState({
        blurry: true,
        svgElement: null,
        withConfirmAndCancelButtons: false,
      });
      if (opponentAuraRefs.current) {
        hideAuraDom(opponentAuraRefs.current.background);
      }
      if (playerAuraRefs.current) {
        hideAuraDom(playerAuraRefs.current.background);
      }
      if (!fadeOutVideos) {
        clearVideoReactionsNow();
        return;
      }
      if (opponentVideoVisible) {
        dismissOpponentVideo(VIDEO_REACTION_CLEAR_FADE_OUT_MS);
      } else {
        clearOpponentVideoNow();
      }
      if (playerVideoVisible) {
        dismissPlayerVideo(VIDEO_REACTION_CLEAR_FADE_OUT_MS);
      } else {
        clearPlayerVideoNow();
      }
    },
    [
      clearPendingWagerTransitionState,
      clearOpponentVideoNow,
      clearPlayerVideoNow,
      clearVideoReactionsNow,
      clearWagerPanel,
      dismissOpponentVideo,
      dismissPlayerVideo,
      opponentVideoVisible,
      playerVideoVisible,
    ],
  );

  useEffect(() => {
    return registerBoardTransientUiHandler(clearBoardTransientUiHandler);
  }, [clearBoardTransientUiHandler]);

  const openWagerPanelForSide = useCallback(
    (side: WagerPileSide | "winner") => {
      const state = wagerRenderStateRef.current;
      if (!state || state.winAnimationActive) {
        clearWagerPanel();
        return;
      }
      const pileState =
        side === "winner"
          ? state.winner
          : side === "opponent"
            ? state.opponent
            : state.player;
      if (!pileState) {
        clearWagerPanel();
        return;
      }
      activeWagerPanelSideRef.current = side;
      activeWagerPanelRectRef.current = pileState.rect;
      activeWagerPanelCountRef.current =
        pileState.actualCount ?? pileState.count;
      setActiveWagerPanelSide(side);
      setActiveWagerPanelRect(pileState.rect);
      setActiveWagerPanelCount(pileState.actualCount ?? pileState.count);
    },
    [clearWagerPanel],
  );

  const handleWagerCancel = useCallback(
    (event?: React.SyntheticEvent) => {
      if (event) {
        event.stopPropagation();
        if (event.cancelable) {
          event.preventDefault();
        }
      }
      if (wagerActionsLocked || !playerProposal) {
        clearWagerPanel();
        return;
      }
      clearWagerPanel();
      connection.cancelWagerProposal().catch(() => {});
    },
    [clearWagerPanel, playerProposal, wagerActionsLocked],
  );

  const handleWagerDecline = useCallback(
    (event?: React.SyntheticEvent) => {
      if (event) {
        event.stopPropagation();
        if (event.cancelable) {
          event.preventDefault();
        }
      }
      if (wagerActionsLocked || !opponentProposal) {
        clearWagerPanel();
        return;
      }
      clearWagerPanel();
      connection.declineWagerProposal().catch(() => {});
    },
    [clearWagerPanel, opponentProposal, wagerActionsLocked],
  );

  const handleWagerAccept = useCallback(
    (event?: React.SyntheticEvent) => {
      if (event) {
        event.stopPropagation();
        if (event.cancelable) {
          event.preventDefault();
        }
      }
      if (wagerActionsLocked || !opponentProposal || !canAccept) {
        clearWagerPanel();
        return;
      }
      clearWagerPanel();
      connection.acceptWagerProposal().catch(() => {});
    },
    [canAccept, clearWagerPanel, opponentProposal, wagerActionsLocked],
  );

  useEffect(() => {
    if (activeWagerPanelSideRef.current === "opponent" && !opponentProposal) {
      clearWagerPanel();
      return;
    }
    if (activeWagerPanelSideRef.current === "player" && !playerProposal) {
      clearWagerPanel();
    }
  }, [clearWagerPanel, opponentProposal, playerProposal]);

  const ensureWagerPileElements = useCallback((): WagerPileElements | null => {
    const layer = wagerPilesLayerRef.current;
    if (!layer) {
      return null;
    }
    const existing = wagerPileElementsRef.current;
    if (
      existing &&
      layer.contains(existing.player) &&
      layer.contains(existing.opponent) &&
      layer.contains(existing.winner) &&
      layer.contains(existing.playerDisappearing) &&
      layer.contains(existing.opponentDisappearing)
    ) {
      return existing;
    }
    layer.innerHTML = "";

    const createPileContainer = (
      side: WagerPileSide | "winner",
      isInteractive: boolean,
    ) => {
      const container = document.createElement("div");
      container.dataset.wagerPile = side;
      container.style.position = "absolute";
      container.style.left = "0";
      container.style.top = "0";
      container.style.width = "0";
      container.style.height = "0";
      container.style.display = "block";
      container.style.opacity = "0";
      container.style.pointerEvents = isInteractive ? "auto" : "none";
      container.style.touchAction = "none";
      container.style.userSelect = "none";
      container.style.zIndex = isInteractive ? "3" : "2";
      container.style.overflow = "visible";
      container.style.cursor = isInteractive ? "pointer" : "default";
      if (isInteractive) {
        container.addEventListener(defaultInputEventName, (event) => {
          event.stopPropagation();
          if (event.cancelable) {
            event.preventDefault();
          }
          const config = wagerPanelStateRef.current;
          if (!config.actionsLocked) {
            if (side === "player" && !config.playerHasProposal) {
              clearWagerPanel();
              return;
            }
            if (side === "opponent" && !config.opponentHasProposal) {
              clearWagerPanel();
              return;
            }
          }
          if (activeWagerPanelSideRef.current === side) {
            clearWagerPanel();
            return;
          }
          openWagerPanelForSide(side);
        });
      }
      return container;
    };

    const playerDisappearing = createPileContainer("player", false);
    const opponentDisappearing = createPileContainer("opponent", false);
    const player = createPileContainer("player", true);
    const opponent = createPileContainer("opponent", true);
    const winner = createPileContainer("winner", true);
    layer.append(
      playerDisappearing,
      opponentDisappearing,
      player,
      opponent,
      winner,
    );
    const elements: WagerPileElements = {
      player,
      opponent,
      winner,
      playerDisappearing,
      opponentDisappearing,
      playerIcons: [],
      opponentIcons: [],
      winnerIcons: [],
      playerDisappearingIcons: [],
      opponentDisappearingIcons: [],
    };
    wagerPileElementsRef.current = elements;
    return elements;
  }, [clearWagerPanel, openWagerPanelForSide]);

  const applyWagerRenderState = useCallback(
    (state: WagerRenderState) => {
      wagerRenderStateRef.current = state;
      const nextStackRightEdges: WagerStackRightEdges = {
        ...emptyWagerStackRightEdges,
      };
      addWagerStackRightEdgeForPile(nextStackRightEdges, state.player);
      addWagerStackRightEdgeForPile(nextStackRightEdges, state.opponent);
      addWagerStackRightEdgeForPile(
        nextStackRightEdges,
        state.playerDisappearing,
      );
      addWagerStackRightEdgeForPile(
        nextStackRightEdges,
        state.opponentDisappearing,
      );
      addWagerStackRightEdgeForPile(nextStackRightEdges, state.winner);
      if (
        !wagerStackRightEdgesEqual(
          wagerStackRightEdgesRef.current,
          nextStackRightEdges,
        )
      ) {
        wagerStackRightEdgesRef.current = nextStackRightEdges;
        setWagerStackRightEdges(nextStackRightEdges);
      }
      const signature = [
        state.player
          ? `${state.player.count}:${state.player.isPending ? 1 : 0}:${state.player.animation}`
          : "none",
        state.opponent
          ? `${state.opponent.count}:${state.opponent.isPending ? 1 : 0}:${state.opponent.animation}`
          : "none",
        state.winner ? `${state.winner.count}` : "none",
        state.playerDisappearing ? `${state.playerDisappearing.count}` : "none",
        state.opponentDisappearing
          ? `${state.opponentDisappearing.count}`
          : "none",
        state.winAnimationActive ? "1" : "0",
      ].join("|");
      if (
        wagerUiDebugLogsEnabled &&
        lastWagerUiRenderSignatureRef.current !== signature
      ) {
        lastWagerUiRenderSignatureRef.current = signature;
        console.log("wager-debug", {
          source: "board-ui",
          event: "apply-render-state",
          signature,
          playerRect: state.player?.rect ?? null,
          opponentRect: state.opponent?.rect ?? null,
          winnerRect: state.winner?.rect ?? null,
        });
      }
      const elements = ensureWagerPileElements();
      if (!elements) {
        if (wagerUiDebugLogsEnabled) {
          console.log("wager-debug", {
            source: "board-ui",
            event: "apply-render-state:missing-elements",
          });
        }
        return;
      }

      const APPEAR_ANIMATION_DURATION_MS = 320;
      const APPEAR_ANIMATION_OFFSET_PCT = 35;

      const PENDING_BLINK_DELAY_MS = 1300;

      const MATERIAL_CHANGE_FADE_MS = 280;

      const updatePile = (
        container: HTMLDivElement,
        icons: HTMLImageElement[],
        pileState: WagerPileRenderState | null,
        isOpponentSide: boolean,
        side: WagerPileSide | "winner",
      ) => {
        const sideKey = side === "player" || side === "opponent" ? side : null;

        if (
          !pileState ||
          pileState.count <= 0 ||
          pileState.frames.length === 0
        ) {
          container.style.opacity = "0";
          container.style.pointerEvents = "none";
          container.style.animation = "none";
          if (sideKey) {
            if (pendingBlinkDelayTimersRef.current[sideKey] !== null) {
              clearTrackedTimeout(pendingBlinkDelayTimersRef.current[sideKey]);
              pendingBlinkDelayTimersRef.current[sideKey] = null;
            }
            pendingBlinkEnabledRef.current[sideKey] = false;
            previousMaterialUrlRef.current[sideKey] = null;
            materialChangeOldIconsRef.current[sideKey].forEach((icon) =>
              icon.remove(),
            );
            materialChangeOldIconsRef.current[sideKey] = [];
          }
          while (icons.length > 0) {
            const icon = icons.pop();
            if (icon) {
              icon.remove();
            }
          }
          return;
        }
        const rect = pileState.rect;
        if (rect.w === 0 || rect.h === 0) {
          container.style.opacity = "0";
          container.style.pointerEvents = "none";
          container.style.animation = "none";
          if (sideKey) {
            if (pendingBlinkDelayTimersRef.current[sideKey] !== null) {
              clearTrackedTimeout(pendingBlinkDelayTimersRef.current[sideKey]);
              pendingBlinkDelayTimersRef.current[sideKey] = null;
            }
            pendingBlinkEnabledRef.current[sideKey] = false;
            previousMaterialUrlRef.current[sideKey] = null;
            materialChangeOldIconsRef.current[sideKey].forEach((icon) =>
              icon.remove(),
            );
            materialChangeOldIconsRef.current[sideKey] = [];
          }
          while (icons.length > 0) {
            const icon = icons.pop();
            if (icon) {
              icon.remove();
            }
          }
          return;
        }
        container.style.opacity = "1";
        container.style.pointerEvents = "auto";

        if (sideKey && pileState.isPending) {
          if (pileState.animation === "appear") {
            pendingBlinkEnabledRef.current[sideKey] = false;
            if (pendingBlinkDelayTimersRef.current[sideKey] !== null) {
              clearTrackedTimeout(pendingBlinkDelayTimersRef.current[sideKey]);
            }
            pendingBlinkDelayTimersRef.current[sideKey] = setTrackedTimeout(
              () => {
                pendingBlinkDelayTimersRef.current[sideKey] = null;
                pendingBlinkEnabledRef.current[sideKey] = true;
                container.style.animation = PENDING_PULSE_ANIMATION;
              },
              PENDING_BLINK_DELAY_MS,
            );
            container.style.animation = "none";
          } else {
            if (
              !pendingBlinkEnabledRef.current[sideKey] &&
              pendingBlinkDelayTimersRef.current[sideKey] === null
            ) {
              pendingBlinkEnabledRef.current[sideKey] = true;
            }
            container.style.animation = pendingBlinkEnabledRef.current[sideKey]
              ? PENDING_PULSE_ANIMATION
              : "none";
          }
        } else if (sideKey) {
          if (pendingBlinkDelayTimersRef.current[sideKey] !== null) {
            clearTrackedTimeout(pendingBlinkDelayTimersRef.current[sideKey]);
            pendingBlinkDelayTimersRef.current[sideKey] = null;
          }
          pendingBlinkEnabledRef.current[sideKey] = false;
          container.style.animation = "none";
        } else {
          container.style.animation = "none";
        }
        container.style.left = `${toPercentX(rect.x)}%`;
        container.style.top = `${toPercentY(rect.y)}%`;
        container.style.width = `${toPercentX(rect.w)}%`;
        container.style.height = `${toPercentY(rect.h)}%`;

        const materialUrl = pileState.materialUrl;
        const iconSize = pileState.iconSize;
        const sizePctW = (iconSize / rect.w) * 100;
        const sizePctH = (iconSize / rect.h) * 100;
        const visibleCount = Math.min(pileState.count, pileState.frames.length);
        const animationOffsetY = isOpponentSide
          ? -APPEAR_ANIMATION_OFFSET_PCT
          : APPEAR_ANIMATION_OFFSET_PCT;

        const prevMaterial = sideKey
          ? previousMaterialUrlRef.current[sideKey]
          : null;
        const materialChanged =
          sideKey &&
          prevMaterial !== null &&
          prevMaterial !== materialUrl &&
          icons.length > 0;
        const shouldAnimate =
          pileState.animation === "appear" || materialChanged;

        if (materialChanged && sideKey) {
          const oldIcons = [...icons];
          oldIcons.forEach((icon) => {
            icon.style.transition = `opacity ${MATERIAL_CHANGE_FADE_MS}ms ease-out`;
            icon.style.opacity = "0";
          });
          materialChangeOldIconsRef.current[sideKey].forEach((icon) =>
            icon.remove(),
          );
          materialChangeOldIconsRef.current[sideKey] = oldIcons;
          setTrackedTimeout(() => {
            oldIcons.forEach((icon) => icon.remove());
            if (materialChangeOldIconsRef.current[sideKey] === oldIcons) {
              materialChangeOldIconsRef.current[sideKey] = [];
            }
          }, MATERIAL_CHANGE_FADE_MS);
          icons.length = 0;
        }

        if (sideKey) {
          previousMaterialUrlRef.current[sideKey] = materialUrl;
        }

        while (icons.length > visibleCount) {
          const icon = icons.pop();
          if (icon) {
            icon.remove();
          }
        }

        const newIconsStartIndex = icons.length;

        while (icons.length < visibleCount) {
          const icon = document.createElement("img");
          icon.alt = "";
          icon.draggable = false;
          icon.style.position = "absolute";
          icon.style.left = "0";
          icon.style.top = "0";
          icon.style.width = "0";
          icon.style.height = "0";
          icon.style.pointerEvents = "none";
          icon.style.userSelect = "none";
          icon.style.objectFit = "contain";
          if (shouldAnimate) {
            icon.style.opacity = "0";
            icon.style.transform = `translateY(${animationOffsetY}%)`;
          }
          container.appendChild(icon);
          icons.push(icon);
        }

        for (let i = 0; i < visibleCount; i += 1) {
          const frame = pileState.frames[i];
          if (!frame) {
            continue;
          }
          const icon = icons[i];
          if (icon.dataset.src !== materialUrl) {
            icon.dataset.src = materialUrl;
            icon.src = materialUrl;
          }
          const leftPct = ((frame.x - rect.x) / rect.w) * 100;
          const topPct = ((frame.y - rect.y) / rect.h) * 100;
          icon.style.left = `${leftPct}%`;
          icon.style.top = `${topPct}%`;
          icon.style.width = `${sizePctW}%`;
          icon.style.height = `${sizePctH}%`;
          icon.style.zIndex = String(getWagerIconPaintDepth(frame, rect));
        }

        if (shouldAnimate && newIconsStartIndex < visibleCount) {
          const triggerAnimation = () => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                for (let i = newIconsStartIndex; i < visibleCount; i += 1) {
                  const icon = icons[i];
                  if (icon) {
                    const delay = (i - newIconsStartIndex) * 25;
                    icon.style.transition = `opacity ${APPEAR_ANIMATION_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) ${delay}ms, transform ${APPEAR_ANIMATION_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) ${delay}ms`;
                    icon.style.opacity = "1";
                    icon.style.transform = "translateY(0)";
                  }
                }
              });
            });
          };

          const firstNewIcon = icons[newIconsStartIndex];
          if (
            firstNewIcon &&
            firstNewIcon.complete &&
            firstNewIcon.naturalWidth > 0
          ) {
            triggerAnimation();
          } else if (firstNewIcon) {
            const onLoad = () => {
              firstNewIcon.removeEventListener("load", onLoad);
              firstNewIcon.removeEventListener("error", onLoad);
              triggerAnimation();
            };
            firstNewIcon.addEventListener("load", onLoad);
            firstNewIcon.addEventListener("error", onLoad);
          }
        }
      };

      const DISAPPEAR_ANIMATION_DURATION_MS = 280;

      const updateDisappearingPile = (
        container: HTMLDivElement,
        icons: HTMLImageElement[],
        disappearingState: WagerPileRenderState | null,
        side: "player" | "opponent",
        startingOpacity: string,
      ) => {
        if (
          !disappearingState ||
          disappearingState.count <= 0 ||
          disappearingState.frames.length === 0
        ) {
          container.style.transition = "none";
          container.style.opacity = "0";
          container.style.pointerEvents = "none";
          disappearingAnimationStartedRef.current[side] = false;
          while (icons.length > 0) {
            const icon = icons.pop();
            if (icon) icon.remove();
          }
          return;
        }

        if (disappearingAnimationStartedRef.current[side]) {
          return;
        }

        const rect = disappearingState.rect;
        if (rect.w === 0 || rect.h === 0) {
          container.style.transition = "none";
          container.style.opacity = "0";
          container.style.pointerEvents = "none";
          return;
        }

        container.style.left = `${toPercentX(rect.x)}%`;
        container.style.top = `${toPercentY(rect.y)}%`;
        container.style.width = `${toPercentX(rect.w)}%`;
        container.style.height = `${toPercentY(rect.h)}%`;
        container.style.pointerEvents = "none";
        container.style.transition = "none";
        container.style.animation = "none";
        container.style.opacity = startingOpacity;

        const materialUrl = disappearingState.materialUrl;
        const iconSize = disappearingState.iconSize;
        const sizePctW = (iconSize / rect.w) * 100;
        const sizePctH = (iconSize / rect.h) * 100;
        const visibleCount = Math.min(
          disappearingState.count,
          disappearingState.frames.length,
        );

        while (icons.length > visibleCount) {
          const icon = icons.pop();
          if (icon) icon.remove();
        }
        while (icons.length < visibleCount) {
          const icon = document.createElement("img");
          icon.alt = "";
          icon.draggable = false;
          icon.style.position = "absolute";
          icon.style.pointerEvents = "none";
          icon.style.userSelect = "none";
          icon.style.objectFit = "contain";
          container.appendChild(icon);
          icons.push(icon);
        }

        for (let i = 0; i < visibleCount; i += 1) {
          const frame = disappearingState.frames[i];
          if (!frame) continue;
          const icon = icons[i];
          if (icon.dataset.src !== materialUrl) {
            icon.dataset.src = materialUrl;
            icon.src = materialUrl;
          }
          const leftPct = ((frame.x - rect.x) / rect.w) * 100;
          const topPct = ((frame.y - rect.y) / rect.h) * 100;
          icon.style.left = `${leftPct}%`;
          icon.style.top = `${topPct}%`;
          icon.style.width = `${sizePctW}%`;
          icon.style.height = `${sizePctH}%`;
          icon.style.zIndex = String(getWagerIconPaintDepth(frame, rect));
        }

        disappearingAnimationStartedRef.current[side] = true;

        const triggerFade = () => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              container.style.transition = `opacity ${DISAPPEAR_ANIMATION_DURATION_MS}ms ease-out`;
              container.style.opacity = "0";
            });
          });
        };

        const firstIcon = icons[0];
        if (firstIcon && firstIcon.complete && firstIcon.naturalWidth > 0) {
          triggerFade();
        } else if (firstIcon) {
          const onLoad = () => {
            firstIcon.removeEventListener("load", onLoad);
            firstIcon.removeEventListener("error", onLoad);
            triggerFade();
          };
          firstIcon.addEventListener("load", onLoad);
          firstIcon.addEventListener("error", onLoad);
        } else {
          triggerFade();
        }
      };

      const opponentCurrentOpacity = state.opponentDisappearing
        ? window.getComputedStyle(elements.opponent).opacity
        : "1";
      const playerCurrentOpacity = state.playerDisappearing
        ? window.getComputedStyle(elements.player).opacity
        : "1";

      updatePile(
        elements.opponent,
        elements.opponentIcons,
        state.opponent,
        true,
        "opponent",
      );
      updatePile(
        elements.player,
        elements.playerIcons,
        state.player,
        false,
        "player",
      );
      updatePile(
        elements.winner,
        elements.winnerIcons,
        state.winner,
        false,
        "winner",
      );

      updateDisappearingPile(
        elements.opponentDisappearing,
        elements.opponentDisappearingIcons,
        state.opponentDisappearing,
        "opponent",
        opponentCurrentOpacity,
      );
      updateDisappearingPile(
        elements.playerDisappearing,
        elements.playerDisappearingIcons,
        state.playerDisappearing,
        "player",
        playerCurrentOpacity,
      );

      const activeSide = activeWagerPanelSideRef.current;
      if (activeSide) {
        if (state.winAnimationActive) {
          clearWagerPanel();
        } else if (state.winner && activeSide !== "winner") {
          clearWagerPanel();
        } else {
          const pileState =
            activeSide === "winner"
              ? state.winner
              : activeSide === "opponent"
                ? state.opponent
                : state.player;
          if (!pileState) {
            clearWagerPanel();
          } else {
            const prevRect = activeWagerPanelRectRef.current;
            const nextRect = pileState.rect;
            const rectChanged =
              !prevRect ||
              prevRect.x !== nextRect.x ||
              prevRect.y !== nextRect.y ||
              prevRect.w !== nextRect.w ||
              prevRect.h !== nextRect.h;
            if (rectChanged) {
              activeWagerPanelRectRef.current = nextRect;
              setActiveWagerPanelRect(nextRect);
            }
            const nextCount = pileState.actualCount ?? pileState.count;
            if (activeWagerPanelCountRef.current !== nextCount) {
              activeWagerPanelCountRef.current = nextCount;
              setActiveWagerPanelCount(nextCount);
            }
          }
        }
      }
    },
    [
      clearTrackedTimeout,
      clearWagerPanel,
      ensureWagerPileElements,
      setTrackedTimeout,
    ],
  );
  const applyWagerRenderStateRef = useRef(applyWagerRenderState);

  useEffect(() => {
    setWagerPanelVisibilityChecker(
      () => activeWagerPanelSideRef.current !== null,
    );
    setWagerPanelOutsideTapHandler((event) => {
      if (!activeWagerPanelSideRef.current) {
        return false;
      }
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-wager-panel="true"], [data-wager-pile]')
      ) {
        return false;
      }
      clearWagerPanel();
      return true;
    });
    return () => {
      setWagerPanelOutsideTapHandler(null);
      setWagerPanelVisibilityChecker(() => false);
    };
  }, [clearWagerPanel]);

  const playerInfoLayout = useMemo(() => {
    return getBoardPlayerInfoLayout(
      playerInfoOverlayState,
      playerInfoMeasurements,
      endOfGameIconHrefs,
      boardPixelSize,
      isNarrowBoardViewport,
      isPangchiuBoardLayout,
    );
  }, [
    boardPixelSize,
    endOfGameIconHrefs,
    isPangchiuBoardLayout,
    isNarrowBoardViewport,
    playerInfoMeasurements,
    playerInfoOverlayState,
  ]);
  const computedWagerSlotLayouts: WagerSlotLayoutBySide = useMemo(
    () => ({
      player: getWagerSlotLayoutForName(
        playerInfoLayout.player,
        playerInfoMeasurements.playerName,
        boardPixelSize,
        playerInfoSlotHasVisibleName(playerInfoOverlayState.player),
      ),
      opponent: getWagerSlotLayoutForName(
        playerInfoLayout.opponent,
        playerInfoMeasurements.opponentName,
        boardPixelSize,
        playerInfoSlotHasVisibleName(playerInfoOverlayState.opponent),
      ),
    }),
    [
      boardPixelSize,
      playerInfoLayout.opponent,
      playerInfoLayout.player,
      playerInfoMeasurements.opponentName,
      playerInfoMeasurements.playerName,
      playerInfoOverlayState.opponent,
      playerInfoOverlayState.player,
    ],
  );
  const botStrengthControlOverlay = playerInfoLayout.botStrengthControlOverlay;

  useLayoutEffect(() => {
    applyInviteBotButtonLayout(playerInfoLayout.inviteBotButtonLayout);
  }, [playerInfoLayout.inviteBotButtonLayout]);

  useLayoutEffect(() => {
    applyWagerRenderStateRef.current = applyWagerRenderState;
  }, [applyWagerRenderState]);

  useLayoutEffect(() => {
    setWagerSlotLayouts(
      computedWagerSlotLayouts,
      playerInfoOverlayState.wagerLayoutRevision,
    );
  }, [computedWagerSlotLayouts, playerInfoOverlayState.wagerLayoutRevision]);

  useLayoutEffect(() => {
    setWagerRenderHandler((state) => {
      applyWagerRenderStateRef.current(state);
    });
    return () => {
      setWagerRenderHandler(null);
      setWagerSlotLayouts(null);
    };
  }, []);

  useEffect(() => {
    if (!botStrengthControlOverlay.visible) {
      setBotStrengthHovered(false);
      setBotStrengthPressed(false);
    }
  }, [botStrengthControlOverlay.visible]);

  const standardBoardTransform = "translate(0,100)";
  const pangchiuBoardTransform = "translate(83,184) scale(0.85892388)";
  const activeBoardTransform = isPangchiuBoardLayout
    ? pangchiuBoardTransform
    : standardBoardTransform;
  const pictureBoardBackgroundUrl = PANGCHIU_BOARD_BACKGROUND_URL;
  const isPictureBoardImageLoaded =
    !!loadedPictureBoardUrls[pictureBoardBackgroundUrl];
  const boardClassName = `board-svg ${
    isPangchiuBoardLayout ? "grid-hidden" : "grid-visible"
  }`;
  const topVideoReactionStyle = {
    top: isPangchiuBoardLayout ? "7.05%" : "7.02%",
    height: isPangchiuBoardLayout
      ? VIDEO_CONTAINER_HEIGHT_IMAGE
      : VIDEO_CONTAINER_HEIGHT_GRID,
  };
  const bottomVideoReactionStyle = {
    top: isPangchiuBoardLayout ? "89.65%" : "85.22%",
    height: isPangchiuBoardLayout
      ? VIDEO_CONTAINER_HEIGHT_IMAGE
      : VIDEO_CONTAINER_HEIGHT_GRID,
  };
  const boardOverlayStyle = {
    top: isPangchiuBoardLayout ? "7.05%" : "7.02%",
    height: isPangchiuBoardLayout ? "82.6%" : "78.2%",
    aspectRatio: isPangchiuBoardLayout ? "1524/1612" : "1",
  };
  const activeWagerPileRect = activeWagerPanelSide
    ? activeWagerPanelRect
    : null;
  const isOpponentPanel =
    activeWagerPanelSide === "opponent"
      ? true
      : activeWagerPanelSide === "player"
        ? false
        : activeWagerPileRect
          ? getWagerSideForBoardRect(activeWagerPileRect) === "opponent"
          : false;
  const wagerPanelLayout =
    activeWagerPanelSide && activeWagerPileRect
      ? getWagerPanelLayout(
          activeWagerPileRect,
          isOpponentPanel,
          boardPixelSize,
          wagerPanelHasActions,
        )
      : null;
  const wagerCountLayout =
    wagerPanelLayout && activeWagerPileRect && activeWagerPanelCount !== null
      ? (() => {
          const pxPerUnitX = boardPixelSize
            ? boardPixelSize.width / BOARD_WIDTH_UNITS
            : null;
          const minGap = pxPerUnitX
            ? WAGER_PANEL_COUNT_MIN_GAP_PX / pxPerUnitX
            : 0;
          const gap = Math.max(wagerPanelLayout.countGap, minGap);
          const centerY =
            activeWagerPileRect.y +
            activeWagerPileRect.h / 2 -
            activeWagerPileRect.h * WAGER_PANEL_COUNT_Y_OFFSET_FRAC;
          const left = activeWagerPileRect.x + activeWagerPileRect.w + gap;
          const leftPct =
            ((left - wagerPanelLayout.x) / wagerPanelLayout.width) * 100;
          const topPct =
            ((centerY - wagerPanelLayout.y) / wagerPanelLayout.height) * 100;
          return { leftPct, topPct };
        })()
      : null;
  const wagerPanelTheme = prefersDarkMode
    ? {
        background: "rgba(28, 28, 28, 0.72)",
        border: "rgba(255, 255, 255, 0.12)",
        shadow: "0 10px 22px rgba(0, 0, 0, 0.35)",
        buttonBackground: "rgba(255, 255, 255, 0.1)",
        buttonBorder: "rgba(255, 255, 255, 0.18)",
        buttonText: "var(--color-gray-f0)",
      }
    : {
        background: "rgba(250, 250, 250, 0.78)",
        border: "rgba(0, 0, 0, 0.08)",
        shadow: "0 10px 22px rgba(0, 0, 0, 0.18)",
        buttonBackground: "rgba(0, 0, 0, 0.06)",
        buttonBorder: "rgba(0, 0, 0, 0.08)",
        buttonText: "var(--color-gray-33)",
      };
  const wagerPanelButtonStyle: React.CSSProperties = {
    height: "100%",
    alignSelf: "center",
    justifySelf: "center",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: wagerPanelTheme.buttonBackground,
    border: `1px solid ${wagerPanelTheme.buttonBorder}`,
    color: wagerPanelTheme.buttonText,
    borderRadius: "999px",
    fontWeight: 600,
    fontSize: "0.9em",
    letterSpacing: "0.01em",
    cursor: "pointer",
    whiteSpace: "nowrap",
    minWidth: 0,
    padding: 0,
    margin: 0,
    outline: "none",
    boxSizing: "border-box" as const,
  };
  const botStrengthModeLabel =
    botStrengthControlOverlay.mode === "fast"
      ? "Fast"
      : botStrengthControlOverlay.mode === "pro"
        ? "Pro"
        : "Normal";
  const botStrengthVisibleGyrusCount =
    botStrengthControlOverlay.mode === "fast"
      ? 1
      : botStrengthControlOverlay.mode === "normal"
        ? 2
        : 3;
  const botStrengthSizePx = botStrengthControlOverlay.size * 100;
  const botStrengthXpx = botStrengthControlOverlay.x * 100;
  const botStrengthYpx = botStrengthControlOverlay.y * 100;
  const botStrengthIconSizePx = botStrengthSizePx * 0.75;
  const botStrengthIconOffsetPx =
    (botStrengthSizePx - botStrengthIconSizePx) / 2;
  const botStrengthIconScale = botStrengthIconSizePx / 24;
  const botStrengthStroke = Math.max(
    0.8,
    Math.min(1.5, botStrengthSizePx * 0.042),
  );
  const isBotStrengthDark = prefersDarkMode;
  const canUseFinePointerHover = window.matchMedia(
    "(hover: hover) and (pointer: fine)",
  ).matches;
  const shouldShowBotStrengthInteractionFill = !isMobile;
  const showBotStrengthHover =
    shouldShowBotStrengthInteractionFill &&
    canUseFinePointerHover &&
    botStrengthHovered;
  const showBotStrengthPressed =
    shouldShowBotStrengthInteractionFill && botStrengthPressed;
  const botStrengthFill = isBotStrengthDark
    ? showBotStrengthPressed
      ? "var(--color-gray-55)"
      : showBotStrengthHover
        ? "var(--color-gray-44)"
        : "var(--color-gray-33)"
    : showBotStrengthPressed
      ? "var(--color-gray-d0)"
      : showBotStrengthHover
        ? "var(--color-gray-e0)"
        : "var(--color-gray-f0)";
  const botStrengthColor = isBotStrengthDark
    ? "var(--color-blue-primary-dark)"
    : "var(--color-blue-primary)";
  const markBotStrengthTouchInteraction = () => {
    botStrengthIgnoreMouseUntilRef.current =
      Date.now() + BOT_STRENGTH_IGNORE_MOUSE_AFTER_TOUCH_MS;
  };
  const shouldIgnoreBotStrengthMouseEvent = () =>
    Date.now() < botStrengthIgnoreMouseUntilRef.current;
  const handleBotStrengthMouseEnter = () => {
    if (!canUseFinePointerHover) {
      return;
    }
    if (shouldIgnoreBotStrengthMouseEvent()) {
      return;
    }
    setBotStrengthHovered(true);
  };
  const handleBotStrengthPointerDown = (event: React.SyntheticEvent) => {
    event.stopPropagation();
    if (event.type === "touchstart") {
      markBotStrengthTouchInteraction();
      setBotStrengthHovered(false);
      setBotStrengthPressed(false);
      return;
    } else if (event.type === "mousedown" && !canUseFinePointerHover) {
      return;
    } else if (
      event.type === "mousedown" &&
      shouldIgnoreBotStrengthMouseEvent()
    ) {
      return;
    }
    setBotStrengthPressed(true);
  };
  const handleBotStrengthPointerUp = (event: React.SyntheticEvent) => {
    event.stopPropagation();
    if (event.type === "touchend") {
      markBotStrengthTouchInteraction();
      setBotStrengthHovered(false);
      setBotStrengthPressed(false);
      return;
    } else if (event.type === "mouseup" && !canUseFinePointerHover) {
      return;
    } else if (
      event.type === "mouseup" &&
      shouldIgnoreBotStrengthMouseEvent()
    ) {
      return;
    }
    setBotStrengthPressed(false);
  };
  const handleBotStrengthPointerLeave = () => {
    setBotStrengthHovered(false);
    setBotStrengthPressed(false);
  };
  const handleBotStrengthTouchCancel = () => {
    markBotStrengthTouchInteraction();
    handleBotStrengthPointerLeave();
  };
  const handleBotStrengthControlClick = (event: React.SyntheticEvent) => {
    event.stopPropagation();
    if (event.cancelable) {
      event.preventDefault();
    }
    didClickBotStrengthControlButton();
  };
  const handlePlayerInfoNameClick = (
    event: React.SyntheticEvent,
    slot: BoardPlayerInfoSlotState,
  ) => {
    event.stopPropagation();
    if (slot.profileMetadataIsOpponent !== null) {
      openBoardPlayerInfoProfile(slot.profileMetadataIsOpponent);
    }
  };
  const handlePlayerInfoNameMouseEnter = (
    side: WagerPileSide,
    slot: BoardPlayerInfoSlotState,
  ) => {
    if (slot.profileMetadataIsOpponent !== null) {
      setHoveredPlayerInfoSlot(side);
    }
  };
  const handlePlayerInfoNameMouseLeave = (side: WagerPileSide) => {
    setHoveredPlayerInfoSlot((currentSide) =>
      currentSide === side ? null : currentSide,
    );
  };
  const handlePlayerInfoNameTouchEnd = (side: WagerPileSide) => {
    setTrackedTimeout(() => {
      handlePlayerInfoNameMouseLeave(side);
    }, 100);
  };
  const handlePlayerInfoTextBaselineChange = useCallback(() => {
    setPlayerInfoTextLayoutVersion((version) => version + 1);
  }, []);
  const renderPlayerInfoSlotIcon = (layout: BoardPlayerInfoSlotLayout) =>
    layout.endOfGameIcon.visible ? (
      <g>
        <image
          href={layout.endOfGameIcon.href}
          x={layout.endOfGameIcon.x * 100}
          y={layout.endOfGameIcon.y * 100}
          width={layout.endOfGameIcon.size * 100}
          height={layout.endOfGameIcon.size * 100}
          opacity={END_OF_GAME_ICON_OPACITY}
          overflow="visible"
          pointerEvents="none"
        />
      </g>
    ) : null;
  const renderPlayerInfoSlotText = (
    side: WagerPileSide,
    slot: BoardPlayerInfoSlotState,
    layout: BoardPlayerInfoSlotLayout,
    viewportRect: BoardViewportRect,
  ) => {
    const scoreRef =
      side === "player" ? playerScoreTextRef : opponentScoreTextRef;
    const timerRef =
      side === "player" ? playerTimerTextRef : opponentTimerTextRef;
    const nameRef = side === "player" ? playerNameTextRef : opponentNameTextRef;
    const nameMeasurement =
      side === "player"
        ? playerInfoMeasurements.playerName
        : playerInfoMeasurements.opponentName;
    const hasVisibleName = playerInfoSlotHasVisibleName(slot);
    const hasNameReaction = playerInfoSlotHasNameReaction(slot);
    const wagerStackRightEdge = wagerStackRightEdges[side];
    const multiplicator = getOuterElementsMultiplicator(boardPixelSize);
    const reactionX =
      wagerStackRightEdge > 0
        ? wagerStackRightEdge +
          WAGER_STACK_REACTION_GAP_MULTIPLIER * multiplicator
        : layout.nameX +
          nameMeasurement.width +
          NAME_REACTION_GAP_MULTIPLIER * multiplicator;
    const canOpenProfile = slot.profileMetadataIsOpponent !== null;
    const isNameHovered = hoveredPlayerInfoSlot === side && canOpenProfile;
    const nameColor = isNameHovered ? "#0071F9" : colors.scoreText;
    const scoreFontSizePx = toOverlayFontSizePx(
      layout.scoreFontSize,
      viewportRect,
    );
    const nameFontSizePx = toOverlayFontSizePx(
      layout.nameFontSize,
      viewportRect,
    );
    const nameTextProps = {
      color: nameColor,
      opacity: PLAYER_INFO_TEXT_OPACITY,
      fontWeight: 270,
      fontStyle: "italic" as const,
      fontSizePx: nameFontSizePx,
      interactive: true,
      onBaselineChange: handlePlayerInfoTextBaselineChange,
      onClick: (event: React.MouseEvent<HTMLSpanElement>) =>
        handlePlayerInfoNameClick(event, slot),
      onMouseEnter: () => handlePlayerInfoNameMouseEnter(side, slot),
      onMouseLeave: () => handlePlayerInfoNameMouseLeave(side),
      onTouchEnd: () => handlePlayerInfoNameTouchEnd(side),
    };
    return (
      <React.Fragment key={side}>
        <BoardPlayerInfoText
          elementRef={scoreRef}
          x={layout.scoreX}
          y={layout.scoreY}
          color={colors.scoreText}
          opacity={PLAYER_INFO_TEXT_OPACITY}
          fontWeight={600}
          fontSizePx={scoreFontSizePx}
          visible={slot.visible}
          onBaselineChange={handlePlayerInfoTextBaselineChange}
        >
          {slot.scoreText}
        </BoardPlayerInfoText>
        <BoardPlayerInfoText
          elementRef={timerRef}
          x={layout.timerX}
          y={layout.timerY}
          color={slot.timerColor}
          opacity={PLAYER_INFO_TEXT_OPACITY}
          fontWeight={600}
          fontSizePx={scoreFontSizePx}
          visible={slot.visible && slot.timerVisible}
          onBaselineChange={handlePlayerInfoTextBaselineChange}
        >
          {slot.timerText}
        </BoardPlayerInfoText>
        <BoardPlayerInfoText
          {...nameTextProps}
          elementRef={nameRef}
          x={layout.nameX}
          y={layout.nameY}
          visible={hasVisibleName}
        >
          {slot.nameText}
        </BoardPlayerInfoText>
        {hasNameReaction && (
          <BoardPlayerInfoText
            {...nameTextProps}
            x={reactionX}
            y={layout.nameY}
            visible={slot.nameVisible}
          >
            {slot.nameReactionText}
          </BoardPlayerInfoText>
        )}
      </React.Fragment>
    );
  };
  return (
    <>
      <div
        ref={auraLayerRef}
        style={{
          position: "fixed",
          inset: 0,
          pointerEvents: "none",
          zIndex: 0,
          overflow: "visible",
        }}
      >
        <div
          ref={opponentWrapperRef}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 0,
            height: 0,
            pointerEvents: "none",
            zIndex: 10,
            overflow: "visible",
          }}
        >
          <div
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
            ref={(div) => {
              opponentAuraContainerRef.current = div;
              if (div && !opponentAuraRefs.current) {
                opponentAuraRefs.current = attachRainbowAura(div);
              }
            }}
          />
        </div>
        <div
          ref={playerWrapperRef}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 0,
            height: 0,
            pointerEvents: "none",
            zIndex: 10,
            overflow: "visible",
          }}
        >
          <div
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
            ref={(div) => {
              playerAuraContainerRef.current = div;
              if (div && !playerAuraRefs.current) {
                playerAuraRefs.current = attachRainbowAura(div);
              }
            }}
          />
        </div>
      </div>

      <svg
        ref={boardSvgRef}
        xmlns="http://www.w3.org/2000/svg"
        className={boardClassName}
        viewBox={`0 0 ${BOARD_VIEWBOX_WIDTH} ${BOARD_VIEWBOX_HEIGHT}`}
        shapeRendering="crispEdges"
        overflow="visible"
      >
        {isGridVisible ? (
          <g id="boardBackgroundLayer">
            {generateBoardPattern({
              colorSet: currentColorSet,
              size: 1100,
              cellSize: 100,
              offsetY: 100,
              keyPrefix: "board",
              squareTypes: displayedBoardSquareTypes,
              useLightTileManaBaseShade: true,
            })}
          </g>
        ) : (
          <g id="boardBackgroundLayer">
            <rect
              x="1"
              y="101"
              height="1161"
              width="1098"
              fill={
                isPictureBoardImageLoaded
                  ? "transparent"
                  : prefersDarkMode
                    ? "var(--color-gray-23)"
                    : "var(--boardBackgroundLight)"
              }
            />
            {shouldIncludePictureBoardImage && (
              <image
                href={pictureBoardBackgroundUrl}
                x="0"
                y="100"
                width="1100"
                onLoad={() => {
                  setLoadedPictureBoardUrls((prevUrls) =>
                    prevUrls[pictureBoardBackgroundUrl]
                      ? prevUrls
                      : { ...prevUrls, [pictureBoardBackgroundUrl]: true },
                  );
                }}
                style={{
                  backgroundColor: prefersDarkMode
                    ? "var(--color-gray-23)"
                    : "var(--boardBackgroundLight)",
                  display: isGridVisible ? "none" : "block",
                }}
              />
            )}
          </g>
        )}
        <g id="monsboard" transform={activeBoardTransform}></g>
        <g id="highlightsLayer" transform={activeBoardTransform}></g>
        <g id="itemsLayer" transform={activeBoardTransform}></g>
        <g id="playerInfoLayer">
          {renderPlayerInfoSlotIcon(playerInfoLayout.opponent)}
          {renderPlayerInfoSlotIcon(playerInfoLayout.player)}
        </g>
        <g id="controlsLayer"></g>
      </svg>

      {boardViewportRect && (
        <div
          style={{
            position: "fixed",
            left: `${boardViewportRect.left}px`,
            top: `${boardViewportRect.top}px`,
            width: `${boardViewportRect.width}px`,
            height: `${boardViewportRect.height}px`,
            pointerEvents: "none",
            overflow: "visible",
          }}
        >
          {renderPlayerInfoSlotText(
            "opponent",
            playerInfoOverlayState.opponent,
            playerInfoLayout.opponent,
            boardViewportRect,
          )}
          {renderPlayerInfoSlotText(
            "player",
            playerInfoOverlayState.player,
            playerInfoLayout.player,
            boardViewportRect,
          )}
        </div>
      )}

      <svg
        xmlns="http://www.w3.org/2000/svg"
        className={boardClassName}
        viewBox={`0 0 ${BOARD_VIEWBOX_WIDTH} ${BOARD_VIEWBOX_HEIGHT}`}
        shapeRendering="crispEdges"
        overflow="visible"
        style={{
          pointerEvents: "none",
        }}
      >
        <g id="avatarLayer"></g>
        <g id="effectsLayer" transform={activeBoardTransform}></g>
        {botStrengthControlOverlay.visible &&
          botStrengthControlOverlay.size > 0 && (
            <g
              transform={`translate(${botStrengthXpx} ${botStrengthYpx})`}
              style={{ pointerEvents: "all", cursor: "pointer" }}
              role="button"
              aria-label={`Bot strength: ${botStrengthModeLabel}`}
              onMouseEnter={handleBotStrengthMouseEnter}
              onMouseLeave={handleBotStrengthPointerLeave}
              onMouseDown={handleBotStrengthPointerDown}
              onMouseUp={handleBotStrengthPointerUp}
              onTouchStart={handleBotStrengthPointerDown}
              onTouchEnd={handleBotStrengthPointerUp}
              onTouchCancel={handleBotStrengthTouchCancel}
              onClick={!isMobile ? handleBotStrengthControlClick : undefined}
              onTouchEndCapture={
                isMobile ? handleBotStrengthControlClick : undefined
              }
            >
              <rect
                x={0}
                y={0}
                width={botStrengthSizePx}
                height={botStrengthSizePx}
                rx={botStrengthSizePx / 2}
                ry={botStrengthSizePx / 2}
                fill={botStrengthFill}
                stroke="none"
              />
              <g
                transform={`translate(${botStrengthIconOffsetPx} ${botStrengthIconOffsetPx}) scale(${botStrengthIconScale})`}
                fill="none"
                stroke={botStrengthColor}
                strokeWidth={botStrengthStroke}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5v13" />
                <path d="M17.6 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.6 1.5" />
                <path d="M18 5.1a4 4 0 0 1 2.5 5.8" />
                <path d="M18 18a4 4 0 0 0 2-7.5" />
                <path d="M6 5.1a4 4 0 0 0-2.5 5.8" />
                <path d="M6 18a4 4 0 0 1-2-7.5" />
                <path d="M20 17.5A4 4 0 1 1 12 18a4 4 0 1 1-8-.5" />
                {botStrengthVisibleGyrusCount >= 1 && (
                  <path d="M12 8c1.5-1 3.5-1 5 0 M12 12.5c-1.5.8-3.5.8-5 0" />
                )}
                {botStrengthVisibleGyrusCount >= 2 && (
                  <path d="M12 9.5c-1.5-.8-3.5-.8-5 0 M12 14c2 .8 4 .8 5.5 0" />
                )}
                {botStrengthVisibleGyrusCount >= 3 && (
                  <path d="M12 11c2-.7 4-.7 5.5 0 M12 15.5c-1.5.7-3 .7-4.5 0" />
                )}
              </g>
            </g>
          )}
      </svg>

      {boardViewportRect && (
        <div
          style={{
            position: "fixed",
            left: `${boardViewportRect.left}px`,
            top: `${boardViewportRect.top}px`,
            width: `${boardViewportRect.width}px`,
            height: `${boardViewportRect.height}px`,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              zIndex: 0,
            }}
          >
            {wagerPanelLayout && (
              <div
                data-wager-panel="true"
                style={{
                  position: "absolute",
                  left: `${toPercentX(wagerPanelLayout.x)}%`,
                  top: `${toPercentY(wagerPanelLayout.y)}%`,
                  width: `${toPercentX(wagerPanelLayout.width)}%`,
                  height: `${toPercentY(wagerPanelLayout.height)}%`,
                  display: "grid",
                  gridTemplateRows: wagerPanelLayout.gridRows,
                  paddingLeft: `${wagerPanelLayout.paddingXPx}px`,
                  paddingRight: `${wagerPanelLayout.paddingXPx}px`,
                  boxSizing: "border-box",
                  background: wagerPanelTheme.background,
                  border: `1px solid ${wagerPanelTheme.border}`,
                  boxShadow: wagerPanelTheme.shadow,
                  borderRadius: "16px",
                  backdropFilter: "blur(6px)",
                  WebkitBackdropFilter: "blur(6px)",
                  overflow: "visible",
                  pointerEvents: "auto",
                  userSelect: "none",
                  zIndex: 2,
                }}
              >
                {wagerCountLayout && (
                  <div
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      left: `${wagerCountLayout.leftPct}%`,
                      top: `${wagerCountLayout.topPct}%`,
                      transform: "translate(0, -50%)",
                      fontSize: "0.72em",
                      fontWeight: 500,
                      letterSpacing: "0.02em",
                      color: prefersDarkMode
                        ? "rgba(240, 240, 240, 0.6)"
                        : "rgba(40, 40, 40, 0.52)",
                      pointerEvents: "none",
                      userSelect: "none",
                      whiteSpace: "nowrap",
                    }}
                  >
                    ({activeWagerPanelCount})
                  </div>
                )}
                <div
                  aria-hidden="true"
                  style={{ gridRow: wagerPanelLayout.pileRow }}
                />
                {wagerPanelHasActions && (
                  <div
                    data-wager-panel="true"
                    style={{
                      gridRow: wagerPanelLayout.buttonRow,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: `${wagerPanelLayout.buttonGapPx}px`,
                      height: "100%",
                      width: "100%",
                      overflow: "visible",
                    }}
                  >
                    {showOpponentActions && (
                      <>
                        <button
                          data-wager-panel="true"
                          type="button"
                          onClick={!isMobile ? handleWagerDecline : undefined}
                          onTouchStart={
                            isMobile ? handleWagerDecline : undefined
                          }
                          style={{
                            ...wagerPanelButtonStyle,
                            flex: "1 0 auto",
                            minWidth: `${wagerPanelLayout.declineButtonMinWidthPx}px`,
                            paddingLeft: `${wagerPanelLayout.buttonPaddingXPx}px`,
                            paddingRight: `${wagerPanelLayout.buttonPaddingXPx}px`,
                          }}
                        >
                          Decline
                        </button>
                        <button
                          data-wager-panel="true"
                          type="button"
                          disabled={!canAccept}
                          onClick={!isMobile ? handleWagerAccept : undefined}
                          onTouchStart={
                            isMobile ? handleWagerAccept : undefined
                          }
                          style={{
                            ...wagerPanelButtonStyle,
                            flex: "1 0 auto",
                            minWidth: `${wagerPanelLayout.acceptButtonMinWidthPx}px`,
                            paddingLeft: `${wagerPanelLayout.buttonPaddingXPx}px`,
                            paddingRight: `${wagerPanelLayout.buttonPaddingXPx}px`,
                            opacity: canAccept ? 1 : 0.5,
                            cursor: "pointer",
                          }}
                        >
                          {acceptLabel}
                        </button>
                      </>
                    )}
                    {showPlayerActions && (
                      <button
                        data-wager-panel="true"
                        type="button"
                        onClick={!isMobile ? handleWagerCancel : undefined}
                        onTouchStart={isMobile ? handleWagerCancel : undefined}
                        style={{
                          ...wagerPanelButtonStyle,
                          flexShrink: 0,
                          minWidth: `${wagerPanelLayout.playerButtonMinWidthPx}px`,
                          paddingLeft: `${wagerPanelLayout.buttonPaddingXPx}px`,
                          paddingRight: `${wagerPanelLayout.buttonPaddingXPx}px`,
                        }}
                      >
                        Cancel Proposal
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            <div
              ref={wagerPilesLayerRef}
              style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "none",
                zIndex: 3,
              }}
            />
          </div>
          <div
            style={{
              position: "absolute",
              left: "50%",
              transform: "translate(-50%, -100%)",
              ...topVideoReactionStyle,
              maxHeight: VIDEO_CONTAINER_MAX_HEIGHT,
              aspectRatio: VIDEO_CONTAINER_ASPECT_RATIO,
              zIndex: VIDEO_CONTAINER_Z_INDEX,
              pointerEvents: "none",
              touchAction: "none",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                transform: "translate(-50%, -50%)",
                width: "100%",
                height: "100%",
                pointerEvents: "none",
              }}
            />
            {opponentVideoVisible && opponentVideoId !== null && (
              <video
                key={`${opponentVideoId}-${opponentVideoInstance}`}
                ref={setOpponentVideoElementRef}
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  transform: opponentVideoAppearing
                    ? "translate(-50%, -50%) scale(0.3) rotate(-10deg)"
                    : opponentVideoFading
                      ? "translate(-50%, -50%) scale(0.8) rotate(0deg)"
                      : "translate(-50%, -50%) scale(1) rotate(0deg)",
                  width: "100%",
                  height: "100%",
                  opacity: opponentVideoAppearing
                    ? 0
                    : opponentVideoFading
                      ? 0
                      : 1,
                  transition: opponentVideoAppearing
                    ? "opacity 0.3s ease-out, transform 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55)"
                    : opponentVideoFading
                      ? "opacity 0.2s ease-in, transform 0.2s ease-in"
                      : "opacity 0.3s ease-out, transform 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55)",
                }}
                autoPlay
                muted
                preload="auto"
                playsInline
                onEnded={() => {
                  fadeOutOpponentVideoInstance(opponentVideoInstance);
                }}
                onError={(event) => {
                  if (isVideoReactionElementError(event)) {
                    fadeOutOpponentVideoInstance(opponentVideoInstance);
                  }
                }}
                onPlaying={(event) => {
                  scheduleOpponentVideoLifetimeTimeout(
                    getVideoReactionPlaybackLifetimeMs(event.currentTarget),
                    opponentVideoInstance,
                  );
                }}
              >
                <source
                  src={`https://cdn.lil.org/mons/emojipack/swagpack/video/${opponentVideoId}.mov`}
                  type='video/quicktime; codecs="hvc1"'
                />
                <source
                  src={`https://cdn.lil.org/mons/emojipack/swagpack/video/${opponentVideoId}.webm`}
                  type="video/webm"
                />
              </video>
            )}
          </div>
          <div
            style={{
              position: "absolute",
              left: "50%",
              transform: "translateX(-50%)",
              ...bottomVideoReactionStyle,
              maxHeight: VIDEO_CONTAINER_MAX_HEIGHT,
              aspectRatio: VIDEO_CONTAINER_ASPECT_RATIO,
              zIndex: VIDEO_CONTAINER_Z_INDEX,
              pointerEvents: "none",
              touchAction: "none",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                transform: "translate(-50%, -50%)",
                width: "100%",
                height: "100%",
                pointerEvents: "none",
              }}
            />
            {playerVideoVisible && playerVideoId !== null && (
              <video
                key={`${playerVideoId}-${playerVideoInstance}`}
                ref={setPlayerVideoElementRef}
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  transform: playerVideoAppearing
                    ? "translate(-50%, -50%) scale(0.3) rotate(-10deg)"
                    : playerVideoFading
                      ? "translate(-50%, -50%) scale(0.8) rotate(0deg)"
                      : "translate(-50%, -50%) scale(1) rotate(0deg)",
                  width: "100%",
                  height: "100%",
                  opacity: playerVideoAppearing ? 0 : playerVideoFading ? 0 : 1,
                  transition: playerVideoAppearing
                    ? "opacity 0.3s ease-out, transform 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55)"
                    : playerVideoFading
                      ? "opacity 0.2s ease-in, transform 0.2s ease-in"
                      : "opacity 0.3s ease-out, transform 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55)",
                }}
                autoPlay
                muted
                preload="auto"
                playsInline
                onEnded={() => {
                  fadeOutPlayerVideoInstance(playerVideoInstance);
                }}
                onError={(event) => {
                  if (isVideoReactionElementError(event)) {
                    fadeOutPlayerVideoInstance(playerVideoInstance);
                  }
                }}
                onPlaying={(event) => {
                  schedulePlayerVideoLifetimeTimeout(
                    getVideoReactionPlaybackLifetimeMs(event.currentTarget),
                    playerVideoInstance,
                  );
                }}
              >
                <source
                  src={`https://cdn.lil.org/mons/emojipack/swagpack/video/${playerVideoId}.mov`}
                  type='video/quicktime; codecs="hvc1"'
                />
                <source
                  src={`https://cdn.lil.org/mons/emojipack/swagpack/video/${playerVideoId}.webm`}
                  type="video/webm"
                />
              </video>
            )}
          </div>
          {overlayState.svgElement && (
            <div
              style={{
                position: "absolute",
                left: "50%",
                transform: "translateX(-50%)",
                top: boardOverlayStyle.top,
                pointerEvents: "all",
                height: boardOverlayStyle.height,
                aspectRatio: boardOverlayStyle.aspectRatio,
                ...(overlayState.blurry
                  ? {
                      backdropFilter: "blur(3px)",
                      WebkitBackdropFilter: "blur(3px)",
                    }
                  : {}),
                overflow: "hidden",
                border: "none",
              }}
              ref={(div) => {
                if (div && overlayState.svgElement) {
                  div.innerHTML = "";
                  const wrapperSvg = document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "svg",
                  );
                  wrapperSvg.style.position = "absolute";
                  wrapperSvg.style.top = "0";
                  wrapperSvg.style.left = "0";
                  wrapperSvg.style.width = "100%";
                  wrapperSvg.style.height = "100%";
                  wrapperSvg.setAttribute("viewBox", "0 0 1100 1100");
                  wrapperSvg.setAttribute(
                    "preserveAspectRatio",
                    "xMidYMid meet",
                  );
                  wrapperSvg.appendChild(overlayState.svgElement);
                  div.appendChild(wrapperSvg);
                }
              }}
            />
          )}
          {overlayState.withConfirmAndCancelButtons && (
            <div
              style={{
                position: "absolute",
                bottom: "30.5%",
                left: "50%",
                transform: "translateX(-50%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "27%",
                height: "10.8%",
                aspectRatio: "3.75",
                pointerEvents: "all",
              }}
            >
              <CircularButton
                onClick={!isMobile ? handleCancelClick : undefined}
                onTouchStart={isMobile ? handleCancelClick : undefined}
              >
                <FaTimes />
              </CircularButton>
              <CircularButton
                onClick={!isMobile ? handleConfirmClick : undefined}
                onTouchStart={isMobile ? handleConfirmClick : undefined}
              >
                <FaCheck />
              </CircularButton>
            </div>
          )}
        </div>
      )}
    </>
  );
};

bindBoardUiHandlers({
  updateBoardComponentForBoardStyleChange,
  setTopBoardOverlayVisible,
  showRaibowAura,
  updateAuraForAvatarElement,
  updateWagerPlayerUids,
  setBoardPlayerInfoOverlayState,
});

export default BoardComponent;
