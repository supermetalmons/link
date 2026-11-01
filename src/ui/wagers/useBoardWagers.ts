import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type React from "react";
import { isWatchOnly, subscribeToWatchOnly } from "../../game/gameController";
import { setWagerRenderHandler, setWagerSlotLayouts } from "../../game/board";
import type {
  WagerPileSide,
  WagerPileRect,
  WagerSlotLayout,
  WagerRenderState,
  WagerPileRenderState,
} from "../../game/boardWagerModels";
import {
  setWagerPanelOutsideTapHandler,
  setWagerPanelVisibilityChecker,
} from "../controls/bottomControlsPort";
import { connection } from "../../connection/connection";
import type { MatchWagerState } from "../../connection/connectionModels";
import {
  hasConfirmedWagerSnapshot,
  subscribeToWagerState,
} from "../../game/wagerState";
import { useAvailableMaterials } from "../../hooks/useAvailableMaterials";
import { defaultInputEventName } from "../../utils/misc";
import {
  toPercentX,
  toPercentY,
  getWagerSideForBoardRect,
} from "../boardOverlayGeometry";
import type { BoardWagerLayerProps } from "./BoardWagerLayer";

const wagerUiDebugLogsEnabled = import.meta.env.DEV;

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

type WagerStackRightEdges = Record<WagerPileSide, number>;

const emptyWagerStackRightEdges: WagerStackRightEdges = {
  player: 0,
  opponent: 0,
};

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

type BoardWagersOptions = {
  playerUid: string;
  opponentUid: string;
  slotLayouts: Record<WagerPileSide, WagerSlotLayout>;
  layoutRevision: number;
  setTrackedTimeout: (callback: () => void, delay: number) => number;
  clearTrackedTimeout: (timeoutId: number | null) => void;
};

export const useBoardWagers = ({
  playerUid,
  opponentUid,
  slotLayouts,
  layoutRevision,
  setTrackedTimeout,
  clearTrackedTimeout,
}: BoardWagersOptions) => {
  injectPendingPulseKeyframes();

  const [wagerState, setWagerState] = useState<MatchWagerState | null>(null);
  const wagerSnapshotConfirmed = useSyncExternalStore(
    subscribeToWagerState,
    hasConfirmedWagerSnapshot,
    hasConfirmedWagerSnapshot,
  );
  const { availableMaterials, frozenMaterialsStatus } = useAvailableMaterials();
  const [watchOnlySnapshot, setWatchOnlySnapshot] = useState(isWatchOnly);
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
  const [wagerStackRightEdges, setWagerStackRightEdges] =
    useState<WagerStackRightEdges>(emptyWagerStackRightEdges);
  const wagerStackRightEdgesRef = useRef<WagerStackRightEdges>(
    emptyWagerStackRightEdges,
  );
  const proposals = wagerState?.proposals || {};
  const playerProposal =
    playerUid && proposals[playerUid] ? proposals[playerUid] : null;
  const opponentProposal =
    opponentUid && proposals[opponentUid] ? proposals[opponentUid] : null;
  const wagerAgreement = wagerState?.agreed ?? null;
  const wagerResolved = wagerState?.resolved ?? null;
  const wagerActionsLocked =
    !wagerSnapshotConfirmed ||
    watchOnlySnapshot ||
    !!wagerAgreement ||
    !!wagerResolved;
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
    activeWagerPanelSideRef.current = activeWagerPanelSide;
  }, [activeWagerPanelSide]);

  useEffect(() => {
    activeWagerPanelRectRef.current = activeWagerPanelRect;
  }, [activeWagerPanelRect]);

  useEffect(() => {
    activeWagerPanelCountRef.current = activeWagerPanelCount;
  }, [activeWagerPanelCount]);

  useEffect(() => {
    wagerPanelStateRef.current = {
      actionsLocked: wagerActionsLocked,
      playerHasProposal: !!playerProposal,
      opponentHasProposal: !!opponentProposal,
    };
  }, [opponentProposal, playerProposal, wagerActionsLocked]);

  const clearWagerPanel = useCallback(() => {
    activeWagerPanelSideRef.current = null;
    activeWagerPanelRectRef.current = null;
    activeWagerPanelCountRef.current = null;
    setActiveWagerPanelSide(null);
    setActiveWagerPanelRect(null);
    setActiveWagerPanelCount(null);
  }, []);

  const resetTransitionState = useCallback(() => {
    (["player", "opponent"] as const).forEach((sideKey) => {
      pendingBlinkDelayTimersRef.current[sideKey] = null;
      pendingBlinkEnabledRef.current[sideKey] = false;
      previousMaterialUrlRef.current[sideKey] = null;
      materialChangeOldIconsRef.current[sideKey].forEach((icon) =>
        icon.remove(),
      );
      materialChangeOldIconsRef.current[sideKey] = [];
    });
  }, []);

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
          const icon = icons[i]!;
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
                  const icon = icons[i]!;
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
          const icon = icons[i]!;
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

  useLayoutEffect(() => {
    applyWagerRenderStateRef.current = applyWagerRenderState;
  }, [applyWagerRenderState]);

  useLayoutEffect(() => {
    setWagerSlotLayouts(slotLayouts, layoutRevision);
  }, [slotLayouts, layoutRevision]);

  useLayoutEffect(() => {
    setWagerRenderHandler((state) => {
      applyWagerRenderStateRef.current(state);
    });
    return () => {
      setWagerRenderHandler(null);
      setWagerSlotLayouts(null);
    };
  }, []);

  const layerProps: Omit<
    BoardWagerLayerProps,
    "boardPixelSize" | "prefersDarkMode"
  > = {
    pilesLayerRef: wagerPilesLayerRef,
    activePanelSide: activeWagerPanelSide,
    activePanelRect: activeWagerPanelRect,
    activePanelCount: activeWagerPanelCount,
    showOpponentActions,
    showPlayerActions,
    canAccept,
    acceptLabel,
    onCancel: handleWagerCancel,
    onDecline: handleWagerDecline,
    onAccept: handleWagerAccept,
  };

  return {
    stackRightEdges: wagerStackRightEdges,
    clearPanel: clearWagerPanel,
    resetTransitionState,
    layerProps,
  };
};
