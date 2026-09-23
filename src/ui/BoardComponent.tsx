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
import { isMobile } from "../utils/misc";
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
  WAGER_WIN_PILE_SCALE as WAGER_WIN_STACK_SCALE,
  WagerPileSide,
  WagerPileRect,
  WagerSlotLayout,
  applyInviteBotButtonLayout,
} from "../game/board";
import {
  bindBoardVideoReactionHandler,
  unbindBoardVideoReactionHandler,
} from "./controls/boardReactionPort";
import { getImageResource } from "../resources/imageResources";
import { registerBoardTransientUiHandler } from "./uiSession";
import {
  bindBoardUiHandlers,
  getBoardPlayerInfoOverlayState,
  playerInfoOverlayStatesEqual,
  unbindBoardUiHandlers,
} from "../game/boardUiPort";
import type {
  BoardInviteBotButtonLayout,
  BoardEndOfGameMarker,
  BoardPlayerInfoOverlayState,
  BoardPlayerInfoSlotState,
} from "../game/boardUiPort";
import type { BotAutomoveMode } from "../game/botAutomoveMode";
import { onMainGameLoaded } from "../game/mainGameLoadState";

import { BoardWagerLayer } from "./wagers/BoardWagerLayer";
import { useBoardWagers } from "./wagers/useBoardWagers";
import {
  BOARD_WIDTH_UNITS,
  BOARD_HEIGHT_UNITS,
  toPercentX,
  toPercentY,
} from "./boardOverlayGeometry";

export type {
  BoardInviteBotButtonLayout,
  BoardPlayerInfoOverlayState,
  BoardPlayerInfoSlotState,
  BoardTimerColor,
} from "../game/boardUiPort";

export {
  updateBoardComponentForBoardStyleChange,
  setTopBoardOverlayVisible,
  showRaibowAura,
  updateAuraForAvatarElement,
  updateWagerPlayerUids,
  setBoardPlayerInfoOverlayState,
} from "../game/boardUiPort";
export { showVideoReaction } from "./controls/boardReactionPort";

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

type BotStrengthControlOverlayState = {
  visible: boolean;
  mode: BotAutomoveMode;
  x: number;
  y: number;
  size: number;
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
const BOARD_VIEWBOX_WIDTH = BOARD_WIDTH_UNITS * 100;
const BOARD_VIEWBOX_HEIGHT = BOARD_HEIGHT_UNITS * 100;
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

type EndOfGameIconHrefs = Record<EndOfGameIconName, string>;

const getEndOfGameIconHrefs = (): EndOfGameIconHrefs => ({
  victory:
    getImageResource(END_OF_GAME_ICON_URLS.victory).getCachedValue() ||
    END_OF_GAME_ICON_URLS.victory,
  resign:
    getImageResource(END_OF_GAME_ICON_URLS.resign).getCachedValue() ||
    END_OF_GAME_ICON_URLS.resign,
});

const getEndOfGameIconCachedUrl = (
  name: EndOfGameIconName,
): Promise<string | null> =>
  getImageResource(END_OF_GAME_ICON_URLS[name]).load();

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

type BoardVideoReactionProps = Pick<
  ReturnType<typeof useVideoReactionSlot>,
  | "appearing"
  | "fadeOutInstance"
  | "fading"
  | "id"
  | "instance"
  | "scheduleLifetimeTimeout"
  | "setElementRef"
  | "visible"
>;

const BoardVideoReaction: React.FC<BoardVideoReactionProps> = ({
  appearing,
  fadeOutInstance,
  fading,
  id,
  instance,
  scheduleLifetimeTimeout,
  setElementRef,
  visible,
}) => {
  if (!visible || id === null) {
    return null;
  }

  return (
    <video
      key={`${id}-${instance}`}
      ref={setElementRef}
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        transform: appearing
          ? "translate(-50%, -50%) scale(0.3) rotate(-10deg)"
          : fading
            ? "translate(-50%, -50%) scale(0.8) rotate(0deg)"
            : "translate(-50%, -50%) scale(1) rotate(0deg)",
        width: "100%",
        height: "100%",
        opacity: appearing ? 0 : fading ? 0 : 1,
        transition: appearing
          ? "opacity 0.3s ease-out, transform 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55)"
          : fading
            ? "opacity 0.2s ease-in, transform 0.2s ease-in"
            : "opacity 0.3s ease-out, transform 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55)",
      }}
      autoPlay
      muted
      preload="auto"
      playsInline
      onEnded={() => {
        fadeOutInstance(instance);
      }}
      onError={(event) => {
        if (isVideoReactionElementError(event)) {
          fadeOutInstance(instance);
        }
      }}
      onPlaying={(event) => {
        scheduleLifetimeTimeout(
          getVideoReactionPlaybackLifetimeMs(event.currentTarget),
          instance,
        );
      }}
    >
      <source
        src={`https://cdn.lil.org/mons/emojipack/swagpack/video/${id}.mov`}
        type='video/quicktime; codecs="hvc1"'
      />
      <source
        src={`https://cdn.lil.org/mons/emojipack/swagpack/video/${id}.webm`}
        type="video/webm"
      />
    </video>
  );
};

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

type WagerSlotLayoutBySide = Record<WagerPileSide, WagerSlotLayout>;

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

const BoardComponent: React.FC = () => {
  const transitionTimeoutIdsRef = useRef<Set<number>>(new Set());
  const [currentColorSet, setCurrentColorSet] =
    useState<ColorSet>(getCurrentColorSet());
  const [playerInfoOverlayState, setPlayerInfoOverlayState] =
    useState<BoardPlayerInfoOverlayState>(getBoardPlayerInfoOverlayState);
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
  const [playerUidSnapshot, setPlayerUidSnapshot] = useState(
    playerSideMetadata.uid,
  );
  const [opponentUidSnapshot, setOpponentUidSnapshot] = useState(
    opponentSideMetadata.uid,
  );
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
  const [hoveredPlayerInfoSlot, setHoveredPlayerInfoSlot] =
    useState<WagerPileSide | null>(null);
  const [playerInfoTextLayoutVersion, setPlayerInfoTextLayoutVersion] =
    useState(0);

  const setBoardPlayerInfoOverlayStateHandler = (
    nextState: BoardPlayerInfoOverlayState,
  ) => {
    setPlayerInfoOverlayState((prevState) =>
      playerInfoOverlayStatesEqual(prevState, nextState)
        ? prevState
        : nextState,
    );
  };

  const updateWagerPlayerUidsHandler = (
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

  const updateAuraForAvatarElementHandler = (
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

  const showVideoReactionHandler = (opponent: boolean, stickerId: number) => {
    if (opponent) {
      showOpponentVideoReaction(stickerId);
    } else {
      showPlayerVideoReaction(stickerId);
    }
  };

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

  const setTopBoardOverlayVisibleHandler = (
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

  const showRaibowAuraHandler = (
    visible: boolean,
    url: string,
    opponent: boolean,
  ) => {
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

  useEffect(() => {
    const unsubscribe = subscribeToDisplayedBoardSquareTypes(
      setDisplayedBoardSquareTypes,
    );
    return () => {
      unsubscribe();
    };
  }, []);

  const updateColorSetAndGrid = useCallback(() => {
    setCurrentColorSet(getCurrentColorSet());
    const newIsGridVisible = !isCustomPictureBoardEnabled();
    setIsGridVisible(newIsGridVisible);
    setIsPangchiuBoardLayout(isPangchiuBoard());
    if (!newIsGridVisible) {
      setShouldIncludePictureBoardImage(true);
    }
  }, []);

  useLayoutEffect(() => {
    const boundHandlers = bindBoardUiHandlers({
      updateBoardComponentForBoardStyleChange: updateColorSetAndGrid,
      setTopBoardOverlayVisible: setTopBoardOverlayVisibleHandler,
      showRaibowAura: showRaibowAuraHandler,
      updateAuraForAvatarElement: updateAuraForAvatarElementHandler,
      updateWagerPlayerUids: updateWagerPlayerUidsHandler,
      setBoardPlayerInfoOverlayState: setBoardPlayerInfoOverlayStateHandler,
    });
    const boundVideoHandler = bindBoardVideoReactionHandler(
      showVideoReactionHandler,
    );
    const latestPlayerInfoOverlayState = getBoardPlayerInfoOverlayState();
    if (
      !playerInfoOverlayStatesEqual(
        playerInfoOverlayState,
        latestPlayerInfoOverlayState,
      )
    ) {
      setBoardPlayerInfoOverlayStateHandler(latestPlayerInfoOverlayState);
    }
    return () => {
      unbindBoardUiHandlers(boundHandlers);
      unbindBoardVideoReactionHandler(boundVideoHandler);
    };
  });

  useEffect(() => {
    return subscribeToBoardColorSetChanges(updateColorSetAndGrid);
  }, [updateColorSetAndGrid]);

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
    const unsubscribe = onMainGameLoaded(() => {
      preloadEndOfGameIcons().forEach((promise) => {
        void promise.then((resolvedUrl) => {
          if (!cancelled && resolvedUrl) {
            setEndOfGameIconHrefs(getEndOfGameIconHrefs());
          }
        });
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
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

  const {
    stackRightEdges: wagerStackRightEdges,
    clearPanel: clearWagerPanel,
    resetTransitionState: resetWagerTransitionState,
    layerProps: wagerLayerProps,
  } = useBoardWagers({
    playerUid: playerUidSnapshot,
    opponentUid: opponentUidSnapshot,
    slotLayouts: computedWagerSlotLayouts,
    layoutRevision: playerInfoOverlayState.wagerLayoutRevision,
    setTrackedTimeout,
    clearTrackedTimeout,
  });

  const clearPendingBoardTransitionState = useCallback(() => {
    clearAllTrackedTimeouts();
    resetWagerTransitionState();
    resetOpponentVideoTimeoutRefs();
    resetPlayerVideoTimeoutRefs();
  }, [
    clearAllTrackedTimeouts,
    resetWagerTransitionState,
    resetOpponentVideoTimeoutRefs,
    resetPlayerVideoTimeoutRefs,
  ]);

  useEffect(() => {
    return () => {
      clearPendingBoardTransitionState();
      applyInviteBotButtonLayout(null);
    };
  }, [clearPendingBoardTransitionState]);

  const clearBoardTransientUiHandler = useCallback(
    (fadeOutVideos: boolean = true) => {
      clearWagerPanel();
      clearPendingBoardTransitionState();
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
      clearPendingBoardTransitionState,
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
          <BoardWagerLayer
            {...wagerLayerProps}
            boardPixelSize={boardPixelSize}
            prefersDarkMode={prefersDarkMode}
          />
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
            <BoardVideoReaction
              appearing={opponentVideoAppearing}
              fadeOutInstance={fadeOutOpponentVideoInstance}
              fading={opponentVideoFading}
              id={opponentVideoId}
              instance={opponentVideoInstance}
              scheduleLifetimeTimeout={scheduleOpponentVideoLifetimeTimeout}
              setElementRef={setOpponentVideoElementRef}
              visible={opponentVideoVisible}
            />
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
            <BoardVideoReaction
              appearing={playerVideoAppearing}
              fadeOutInstance={fadeOutPlayerVideoInstance}
              fading={playerVideoFading}
              id={playerVideoId}
              instance={playerVideoInstance}
              scheduleLifetimeTimeout={schedulePlayerVideoLifetimeTimeout}
              setElementRef={setPlayerVideoElementRef}
              visible={playerVideoVisible}
            />
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

export default BoardComponent;
