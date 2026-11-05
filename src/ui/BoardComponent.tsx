import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import styled from "styled-components";
import { FaTimes, FaCheck } from "react-icons/fa";
import {
  didClickBotStrengthControlButton,
  subscribeToDisplayedBoardSquareTypes,
} from "../game/gameController";
import {
  BOARD_GRID_SIZE,
  getBoardPatternSquareColorKey,
} from "../game/boardSquareTypes";
import {
  colors,
  isPangchiuBoard,
  subscribeToBoardStyleSetChanges,
} from "../content/boardStyles";
import { isMobile } from "../utils/misc";
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
  applyInviteBotButtonLayout,
} from "../game/board";
import {
  BoardReactionsLayer,
  type BoardReactionsLayerHandle,
} from "./BoardReactionsLayer";
import { getImageResource } from "../resources/imageResources";
import { registerBoardTransientUiHandler } from "./uiSession";
import {
  bindBoardUiHandlers,
  getBoardPlayerInfoOverlayState,
  playerInfoOverlayStatesEqual,
  unbindBoardUiHandlers,
} from "../game/boardUiPort";
import type {
  BoardPlayerInfoOverlayState,
  BoardPlayerInfoSlotState,
} from "../game/boardUiPort";
import { onMainGameLoaded } from "../game/mainGameLoadState";

import { BotStrengthControl } from "./BotStrengthControl";
import { BoardWagerLayer } from "./wagers/BoardWagerLayer";
import { useBoardWagers } from "./wagers/useBoardWagers";
import {
  BOARD_WIDTH_UNITS,
  BOARD_HEIGHT_UNITS,
  toPercentX,
  toPercentY,
} from "./boardOverlayGeometry";
import type { WagerPileSide } from "../game/boardWagerModels";
import {
  emptyTextMeasurement,
  getBoardPlayerInfoLayout,
  getOuterElementsMultiplicator,
  getWagerSlotLayoutForName,
  mergePlayerInfoMeasurements,
  playerInfoSlotHasNameReaction,
  playerInfoSlotHasVisibleName,
} from "./boardPlayerInfoLayout";
import type {
  BoardPlayerInfoMeasurements,
  BoardPlayerInfoSlotLayout,
  BoardTextMeasurement,
  EndOfGameIconHrefs,
  WagerSlotLayoutBySide,
} from "./boardPlayerInfoLayout";

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

const BOARD_VIEWBOX_WIDTH = BOARD_WIDTH_UNITS * 100;
const BOARD_VIEWBOX_HEIGHT = BOARD_HEIGHT_UNITS * 100;
const END_OF_GAME_ICON_BASE_URL = "https://cdn.lil.org/mons/icons";
const END_OF_GAME_ICON_URLS = {
  victory: `${END_OF_GAME_ICON_BASE_URL}/victory.webp`,
  resign: `${END_OF_GAME_ICON_BASE_URL}/resign_1.webp`,
} as const;
type EndOfGameIconName = keyof typeof END_OF_GAME_ICON_URLS;
const END_OF_GAME_ICON_OPACITY = 0.69;
const PLAYER_INFO_TEXT_OPACITY = 0.69;
const WAGER_STACK_REACTION_GAP_MULTIPLIER = 0.08;
const NAME_REACTION_GAP_MULTIPLIER = 0.0777;

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

type BoardViewportRect = {
  left: number;
  top: number;
  width: number;
  height: number;
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

const seeIfShouldOffsetFromBorders = () =>
  window.innerWidth / window.innerHeight < 0.72;

const BoardComponent: React.FC = () => {
  const reactionsLayerRef = useRef<BoardReactionsLayerHandle>(null);
  const transitionTimeoutIdsRef = useRef<Set<number>>(new Set());
  const [playerInfoOverlayState, setPlayerInfoOverlayState] =
    useState<BoardPlayerInfoOverlayState>(getBoardPlayerInfoOverlayState);
  const [endOfGameIconHrefs, setEndOfGameIconHrefs] =
    useState<EndOfGameIconHrefs>(getEndOfGameIconHrefs);
  const [prefersDarkMode, setPrefersDarkMode] = useState(
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [isPangchiuBoardLayout, setIsPangchiuBoardLayout] =
    useState(isPangchiuBoard());
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
  const pictureBoardImageRef = useRef<SVGImageElement | null>(null);
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
      ...(ok ? { ok } : {}),
      ...(cancel ? { cancel } : {}),
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

  useLayoutEffect(() => {
    const tiles = document.querySelectorAll("#board-grid > rect");
    return subscribeToDisplayedBoardSquareTypes((squareTypes) => {
      tiles.forEach((tile, index) => {
        const colorKey = getBoardPatternSquareColorKey(
          Math.floor(index / BOARD_GRID_SIZE),
          index % BOARD_GRID_SIZE,
          squareTypes,
          true,
        );
        const fill = `var(--board-${colorKey})`;
        if (tile.getAttribute("fill") !== fill) tile.setAttribute("fill", fill);
      });
    });
  }, []);

  useLayoutEffect(() => {
    const image = pictureBoardImageRef.current!;
    const clearFailedImage = () => {
      image.removeAttribute("data-loaded");
      image.removeAttribute("href");
    };
    image.addEventListener("error", clearFailedImage);
    return () => image.removeEventListener("error", clearFailedImage);
  }, []);

  useLayoutEffect(() => {
    const image = pictureBoardImageRef.current!;
    if (isPangchiuBoardLayout && !image.hasAttribute("href")) {
      image.setAttribute("href", PANGCHIU_BOARD_BACKGROUND_URL);
    }
  }, [isPangchiuBoardLayout]);

  const updateBoardLayoutStyle = useCallback(() => {
    setIsPangchiuBoardLayout(isPangchiuBoard());
  }, []);

  useLayoutEffect(() => {
    const boundHandlers = bindBoardUiHandlers({
      updateBoardComponentForBoardStyleChange: updateBoardLayoutStyle,
      setTopBoardOverlayVisible: setTopBoardOverlayVisibleHandler,
      showRaibowAura: showRaibowAuraHandler,
      updateAuraForAvatarElement: updateAuraForAvatarElementHandler,
      updateWagerPlayerUids: updateWagerPlayerUidsHandler,
      setBoardPlayerInfoOverlayState: setBoardPlayerInfoOverlayStateHandler,
    });
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
    };
  });

  useEffect(() => {
    return subscribeToBoardStyleSetChanges(updateBoardLayoutStyle);
  }, [updateBoardLayoutStyle]);

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
  }, [isPangchiuBoardLayout]);

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
    isPangchiuBoardLayout,
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
    isPangchiuBoardLayout,
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
    reactionsLayerRef.current?.resetTimeoutRefs();
  }, [clearAllTrackedTimeouts, resetWagerTransitionState]);

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
      reactionsLayerRef.current?.clear(fadeOutVideos);
    },
    [clearPendingBoardTransitionState, clearWagerPanel],
  );

  useEffect(() => {
    return registerBoardTransientUiHandler(clearBoardTransientUiHandler);
  }, [clearBoardTransientUiHandler]);

  const standardBoardTransform = "translate(0,100)";
  const pangchiuBoardTransform = "translate(83,184) scale(0.85892388)";
  const activeBoardTransform = isPangchiuBoardLayout
    ? pangchiuBoardTransform
    : standardBoardTransform;
  const boardOverlayStyle = {
    top: isPangchiuBoardLayout ? "7.05%" : "7.02%",
    height: isPangchiuBoardLayout ? "82.6%" : "78.2%",
    aspectRatio: isPangchiuBoardLayout ? "1524/1612" : "1",
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
      {createPortal(
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
        </div>,
        document.getElementById("board-aura-host")!,
      )}
      {createPortal(
        <image
          ref={pictureBoardImageRef}
          x="0"
          y="100"
          width="1100"
          onLoad={(event) => {
            if (event.currentTarget.hasAttribute("href")) {
              event.currentTarget.setAttribute("data-loaded", "");
            }
          }}
        />,
        document.getElementById("board-picture")!,
      )}

      {createPortal(
        <>
          <g id="monsboard" transform={activeBoardTransform}></g>
          <g id="highlightsLayer" transform={activeBoardTransform}></g>
        </>,
        document.getElementById("board-backdrop")!,
      )}

      <svg
        ref={boardSvgRef}
        xmlns="http://www.w3.org/2000/svg"
        className="board-svg"
        viewBox={`0 0 ${BOARD_VIEWBOX_WIDTH} ${BOARD_VIEWBOX_HEIGHT}`}
        shapeRendering="crispEdges"
        overflow="visible"
      >
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
        className="board-svg"
        viewBox={`0 0 ${BOARD_VIEWBOX_WIDTH} ${BOARD_VIEWBOX_HEIGHT}`}
        shapeRendering="crispEdges"
        overflow="visible"
        style={{
          pointerEvents: "none",
        }}
      >
        <g id="avatarLayer"></g>
        <g id="effectsLayer" transform={activeBoardTransform}></g>
        <BotStrengthControl
          overlay={botStrengthControlOverlay}
          prefersDarkMode={prefersDarkMode}
          onActivate={didClickBotStrengthControlButton}
        />
      </svg>

      <BoardReactionsLayer
        ref={reactionsLayerRef}
        viewportRect={boardViewportRect}
        isPangchiuBoardLayout={isPangchiuBoardLayout}
        setTrackedTimeout={setTrackedTimeout}
        clearTrackedTimeout={clearTrackedTimeout}
        wagerLayer={
          <BoardWagerLayer
            {...wagerLayerProps}
            boardPixelSize={boardPixelSize}
            prefersDarkMode={prefersDarkMode}
          />
        }
      >
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
                wrapperSvg.setAttribute("preserveAspectRatio", "xMidYMid meet");
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
      </BoardReactionsLayer>
    </>
  );
};

export default BoardComponent;
