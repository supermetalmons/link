import type { MaterialName } from "../services/rocksMiningService";
import {
  MAX_WAGER_WIN_PILE_ITEMS,
  WAGER_WIN_PILE_SCALE,
  buildWagerFrames,
  buildWagerRenderState,
  clampWagerUnit,
  createWagerPile,
  generateWagerPositions,
  getWagerIconFrame,
  getWagerIconLayout as getWagerIconLayoutForAvatar,
  remapWagerFrame as remapWagerFrameForAvatar,
  syncWagerPileIcons,
  updateWagerPileLayout as updateWagerPileLayoutForAvatar,
  wagerPileHiddenByLayout,
  wagerRectIsVisible,
  wagerSlotLayoutsEqual,
} from "./boardWagerModels";
import type {
  WagerPile,
  WagerPileAnimation,
  WagerPileRect,
  WagerPileRenderState,
  WagerPileSide,
  WagerRenderState,
  WagerSlotLayout,
  WagerSlotLayoutMap,
} from "./boardWagerModels";

export type BoardWagerRuntimeDependencies = {
  canLayout(): boolean;
  getAvatarSize(): number;
  getDisplaySlot(metadataIsOpponent: boolean): WagerPileSide;
  getFallbackRect(metadataIsOpponent: boolean, scale: number): WagerPileRect;
  setTimeout(callback: () => void, delay: number): number;
  cancelTimeout(id: number | null): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(id: number | null): void;
  now(): number;
  random(): number;
  log(event: string, payload?: Record<string, unknown>): void;
};

const WAGER_PILE_SCALE = 1;
const WAGER_WIN_ANIM_DURATION_MS = 800;

type WagerWinAnimationStartSpace =
  "winnerSource" | "winnerTarget" | "loserSource";
type WagerWinAnimationState = {
  startTime: number;
  duration: number;
  iconSize: number;
  starts: Array<{ x: number; y: number }>;
  targets: Array<{ x: number; y: number }>;
  drifts: Array<{ x: number; y: number }>;
  delays: number[];
  startSpaces: WagerWinAnimationStartSpace[];
  winnerIsOpponent: boolean;
  winnerSourceRect: WagerPileRect;
  loserSourceRect: WagerPileRect;
  winnerRect: WagerPileRect;
};
type DeferredResolvedWager = {
  winnerIsOpponent: boolean;
  material: MaterialName;
  countPerSide: number;
  animate: boolean;
  requiredLayoutRevision: number;
};

export function createBoardWagerRuntime(
  dependencies: BoardWagerRuntimeDependencies,
) {
  let playerWagerPile: WagerPile | null = null;
  let opponentWagerPile: WagerPile | null = null;
  let winnerWagerPile: WagerPile | null = null;
  let wagerWinAnimRaf: number | null = null;
  let wagerWinAnimActive = false;
  let winnerPileActive = false;
  let wagerWinAnimState: WagerWinAnimationState | null = null;
  let lastWagerWinnerIsOpponent = false;
  let handleWagerRenderState: ((state: WagerRenderState) => void) | null = null;
  let wagerAnimationsReady = false;
  let suppressNextWagerPileTransition = false;
  let previousPlayerPileVisible = false;
  let previousOpponentPileVisible = false;
  let lastVisiblePlayerPileState: WagerPileRenderState | null = null;
  let lastVisibleOpponentPileState: WagerPileRenderState | null = null;
  let disappearingPlayerPile: WagerPileRenderState | null = null;
  let disappearingOpponentPile: WagerPileRenderState | null = null;
  let disappearingPileTimers: {
    player: number | null;
    opponent: number | null;
  } = { player: null, opponent: null };
  const WAGER_DISAPPEAR_ANIMATION_MS = 280;
  let playerPilePending = false;
  let opponentPilePending = false;
  let wagerSlotLayouts: WagerSlotLayoutMap | null = null;
  let wagerSlotLayoutRevision = 0;
  let committedWagerSlotLayoutRevision = -1;
  let deferredResolvedWager: DeferredResolvedWager | null = null;
  let lastWagerEmitSignature = "";

  function setWagerRenderHandler(
    handler: ((state: WagerRenderState) => void) | null,
  ) {
    handleWagerRenderState = handler;
    if (handler) {
      emitWagerRenderState();
    }
  }

  function invalidateWagerSlotLayout() {
    wagerSlotLayoutRevision += 1;
  }

  function setWagerSlotLayouts(
    layouts: WagerSlotLayoutMap,
    layoutRevision: number,
  ): void;
  function setWagerSlotLayouts(layouts: null): void;
  function setWagerSlotLayouts(
    layouts: WagerSlotLayoutMap | null,
    layoutRevision?: number,
  ) {
    if (!layouts) {
      committedWagerSlotLayoutRevision = -1;
    }
    if (
      layouts &&
      layoutRevision !== undefined &&
      layoutRevision !== wagerSlotLayoutRevision
    ) {
      return;
    }
    const layoutChanged = !wagerSlotLayoutsEqual(wagerSlotLayouts, layouts);
    if (layouts && layoutRevision !== undefined) {
      committedWagerSlotLayoutRevision = layoutRevision;
    }
    if (!layoutChanged) {
      if (layouts && layoutRevision !== undefined) {
        showDeferredResolvedWagerIfReady();
      }
      return;
    }
    wagerSlotLayouts = layouts;
    if (wagerWinAnimActive && layouts) {
      retargetActiveWagerWinAnimation();
    }
    updateWagerLayout({ emitWithoutHandler: false });
    if (layouts && layoutRevision !== undefined) {
      showDeferredResolvedWagerIfReady();
    }
  }

  function ensureWagerPile(isOpponent: boolean): WagerPile | null {
    if (isOpponent) {
      if (!opponentWagerPile) {
        opponentWagerPile = createWagerPile();
      }
      return opponentWagerPile;
    }
    if (!playerWagerPile) {
      playerWagerPile = createWagerPile();
    }
    return playerWagerPile;
  }

  function ensureWinnerWagerPile(): WagerPile | null {
    if (!winnerWagerPile) {
      winnerWagerPile = createWagerPile();
    }
    return winnerWagerPile;
  }

  function getWagerPileRect(isOpponent: boolean): {
    x: number;
    y: number;
    w: number;
    h: number;
  } {
    return getWagerSlotRect(isOpponent, "pile", WAGER_PILE_SCALE);
  }

  function getWagerWinnerRect(isOpponent: boolean): {
    x: number;
    y: number;
    w: number;
    h: number;
  } {
    return getWagerSlotRect(isOpponent, "winner", WAGER_WIN_PILE_SCALE);
  }

  function getWagerSlotRect(
    isOpponent: boolean,
    layoutKey: keyof WagerSlotLayout,
    fallbackScale: number,
  ): WagerPileRect {
    const slot = dependencies.getDisplaySlot(isOpponent);
    const layout = wagerSlotLayouts?.[slot]?.[layoutKey];
    if (layout) {
      return { ...layout };
    }
    return dependencies.getFallbackRect(isOpponent, fallbackScale);
  }

  function getWagerIconLayout(
    rect: WagerPileRect,
    iconSizeOverride?: number,
  ): ReturnType<typeof getWagerIconLayoutForAvatar> {
    return getWagerIconLayoutForAvatar(
      rect,
      dependencies.getAvatarSize(),
      iconSizeOverride,
    );
  }

  function updateWagerPileLayout(pile: WagerPile, rect: WagerPileRect) {
    updateWagerPileLayoutForAvatar(pile, rect, dependencies.getAvatarSize());
  }

  function updateWagerLayout({
    emitWithoutHandler = true,
  }: { emitWithoutHandler?: boolean } = {}) {
    if (!playerWagerPile && !opponentWagerPile && !winnerWagerPile) {
      return;
    }
    if (!dependencies.canLayout()) {
      return;
    }
    if (playerWagerPile) {
      updateWagerPileLayout(playerWagerPile, getWagerPileRect(false));
    }
    if (opponentWagerPile) {
      updateWagerPileLayout(opponentWagerPile, getWagerPileRect(true));
    }
    if (winnerWagerPile && winnerPileActive && !wagerWinAnimActive) {
      updateWagerPileLayout(
        winnerWagerPile,
        getWagerWinnerRect(lastWagerWinnerIsOpponent),
      );
    }
    if (handleWagerRenderState || emitWithoutHandler) {
      emitWagerRenderState();
    }
  }

  function clearDisappearingPile(side: "player" | "opponent") {
    if (side === "player") {
      dependencies.cancelTimeout(disappearingPileTimers.player);
      disappearingPileTimers.player = null;
      disappearingPlayerPile = null;
    } else {
      dependencies.cancelTimeout(disappearingPileTimers.opponent);
      disappearingPileTimers.opponent = null;
      disappearingOpponentPile = null;
    }
  }

  function emitWagerRenderState() {
    const winnerModeActive = Boolean(
      winnerPileActive && winnerWagerPile && winnerWagerPile.count > 0,
    );

    const currentPlayerState = winnerModeActive
      ? null
      : buildWagerRenderState(
          playerWagerPile,
          "player",
          "none",
          playerPilePending,
        );
    const currentOpponentState = winnerModeActive
      ? null
      : buildWagerRenderState(
          opponentWagerPile,
          "opponent",
          "none",
          opponentPilePending,
        );
    const currentPlayerVisible = !!currentPlayerState;
    const currentOpponentVisible = !!currentOpponentState;
    const playerHiddenByLayout = wagerPileHiddenByLayout(playerWagerPile);
    const opponentHiddenByLayout = wagerPileHiddenByLayout(opponentWagerPile);

    let playerAnimation: WagerPileAnimation = "none";
    let opponentAnimation: WagerPileAnimation = "none";

    if (
      wagerAnimationsReady &&
      !wagerWinAnimActive &&
      !winnerModeActive &&
      !suppressNextWagerPileTransition
    ) {
      if (currentPlayerVisible && !previousPlayerPileVisible) {
        playerAnimation = "appear";
        clearDisappearingPile("player");
      } else if (playerHiddenByLayout) {
        clearDisappearingPile("player");
      } else if (
        !currentPlayerVisible &&
        previousPlayerPileVisible &&
        lastVisiblePlayerPileState
      ) {
        clearDisappearingPile("player");
        disappearingPlayerPile = {
          ...lastVisiblePlayerPileState,
          animation: "disappear",
          isPending: false,
        };
        disappearingPileTimers.player = dependencies.setTimeout(() => {
          disappearingPlayerPile = null;
          disappearingPileTimers.player = null;
          emitWagerRenderState();
        }, WAGER_DISAPPEAR_ANIMATION_MS);
      }

      if (currentOpponentVisible && !previousOpponentPileVisible) {
        opponentAnimation = "appear";
        clearDisappearingPile("opponent");
      } else if (opponentHiddenByLayout) {
        clearDisappearingPile("opponent");
      } else if (
        !currentOpponentVisible &&
        previousOpponentPileVisible &&
        lastVisibleOpponentPileState
      ) {
        clearDisappearingPile("opponent");
        disappearingOpponentPile = {
          ...lastVisibleOpponentPileState,
          animation: "disappear",
          isPending: false,
        };
        disappearingPileTimers.opponent = dependencies.setTimeout(() => {
          disappearingOpponentPile = null;
          disappearingPileTimers.opponent = null;
          emitWagerRenderState();
        }, WAGER_DISAPPEAR_ANIMATION_MS);
      }
    }

    previousPlayerPileVisible = currentPlayerVisible;
    previousOpponentPileVisible = currentOpponentVisible;
    suppressNextWagerPileTransition = false;

    if (currentPlayerState) {
      lastVisiblePlayerPileState = currentPlayerState;
    }
    if (currentOpponentState) {
      lastVisibleOpponentPileState = currentOpponentState;
    }

    if (!handleWagerRenderState) {
      return;
    }

    const playerRenderState = currentPlayerState
      ? { ...currentPlayerState, animation: playerAnimation }
      : null;
    const opponentRenderState = currentOpponentState
      ? { ...currentOpponentState, animation: opponentAnimation }
      : null;
    const winnerRenderState = winnerModeActive
      ? buildWagerRenderState(winnerWagerPile, "winner", "none", false)
      : null;

    const state: WagerRenderState = {
      player: playerRenderState,
      opponent: opponentRenderState,
      winner: winnerRenderState,
      winAnimationActive: wagerWinAnimActive,
      playerDisappearing: disappearingPlayerPile,
      opponentDisappearing: disappearingOpponentPile,
    };
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
    if (signature !== lastWagerEmitSignature) {
      lastWagerEmitSignature = signature;
      dependencies.log("emit-render-state", {
        showWinner: winnerModeActive,
        signature,
        playerRect: state.player?.rect ?? null,
        opponentRect: state.opponent?.rect ?? null,
        winnerRect: state.winner?.rect ?? null,
      });
    }
    handleWagerRenderState(state);
  }

  function cancelWagerWinAnimation() {
    if (wagerWinAnimRaf !== null) {
      dependencies.cancelAnimationFrame(wagerWinAnimRaf);
      wagerWinAnimRaf = null;
    }
    wagerWinAnimActive = false;
    wagerWinAnimState = null;
  }

  function remapWagerFrame(
    frame: { x: number; y: number },
    previousRect: WagerPileRect,
    nextRect: WagerPileRect,
    previousIconSize: number,
    nextIconSize: number,
  ) {
    return remapWagerFrameForAvatar(
      frame,
      previousRect,
      nextRect,
      previousIconSize,
      nextIconSize,
      dependencies.getAvatarSize(),
    );
  }

  function applyWagerWinAnimationFrame(time: number): number | null {
    if (!wagerWinAnimState || !winnerWagerPile) {
      return null;
    }
    const { startTime, duration, iconSize, starts, targets, drifts, delays } =
      wagerWinAnimState;
    const progress =
      duration > 0 ? clampWagerUnit((time - startTime) / duration) : 1;
    for (let i = 0; i < winnerWagerPile.count; i += 1) {
      const delay = delays[i] || 0;
      const denom = 1 - delay;
      const local =
        denom > 0 ? clampWagerUnit((progress - delay) / denom) : progress;
      const eased = 1 - Math.pow(1 - local, 3);
      const driftScale = Math.sin(local * Math.PI);
      const start = starts[i] || targets[i];
      const target = targets[i] || start;
      if (!start || !target) {
        continue;
      }
      const drift = drifts[i] || { x: 0, y: 0 };
      const x = start.x + (target.x - start.x) * eased + drift.x * driftScale;
      const y = start.y + (target.y - start.y) * eased + drift.y * driftScale;
      const frame = winnerWagerPile.frames[i];
      if (!frame) {
        winnerWagerPile.frames[i] = { x, y };
      } else {
        frame.x = x;
        frame.y = y;
      }
    }
    winnerWagerPile.iconSize = iconSize;
    return progress;
  }

  function retargetActiveWagerWinAnimation() {
    const state = wagerWinAnimState;
    const winnerPile = winnerWagerPile;
    if (!state || !winnerPile) {
      cancelWagerWinAnimation();
      return;
    }

    const nextWinnerSourceRect = getWagerPileRect(state.winnerIsOpponent);
    const nextLoserSourceRect = getWagerPileRect(!state.winnerIsOpponent);
    const nextWinnerRect = getWagerWinnerRect(state.winnerIsOpponent);
    if (
      !wagerRectIsVisible(nextWinnerSourceRect) ||
      !wagerRectIsVisible(nextLoserSourceRect) ||
      !wagerRectIsVisible(nextWinnerRect)
    ) {
      cancelWagerWinAnimation();
      return;
    }

    const previousIconSize = state.iconSize;
    const nextIconSize = getWagerIconLayout(nextWinnerSourceRect).iconSize;
    state.starts = state.starts.map((start, index) => {
      const space = state.startSpaces[index];
      if (space === "winnerSource") {
        return remapWagerFrame(
          start,
          state.winnerSourceRect,
          nextWinnerSourceRect,
          previousIconSize,
          nextIconSize,
        );
      }
      if (space === "loserSource") {
        return remapWagerFrame(
          start,
          state.loserSourceRect,
          nextLoserSourceRect,
          previousIconSize,
          nextIconSize,
        );
      }
      return remapWagerFrame(
        start,
        state.winnerRect,
        nextWinnerRect,
        previousIconSize,
        nextIconSize,
      );
    });

    const nextWinnerLayout = getWagerIconLayout(nextWinnerRect, nextIconSize);
    state.targets = winnerPile.positions.map((position) =>
      getWagerIconFrame(nextWinnerRect, nextWinnerLayout, position),
    );
    const driftScaleX =
      state.winnerRect.w > 0 ? nextWinnerRect.w / state.winnerRect.w : 1;
    const driftScaleY =
      state.winnerRect.h > 0 ? nextWinnerRect.h / state.winnerRect.h : 1;
    state.drifts = state.drifts.map((drift) => ({
      x: drift.x * driftScaleX,
      y: drift.y * driftScaleY,
    }));
    state.iconSize = nextIconSize;
    state.winnerSourceRect = nextWinnerSourceRect;
    state.loserSourceRect = nextLoserSourceRect;
    state.winnerRect = nextWinnerRect;
    winnerPile.rect = nextWinnerRect;
    winnerPile.iconSize = nextIconSize;
    applyWagerWinAnimationFrame(dependencies.now());
  }

  function startWagerWinAnimation(winnerIsOpponent: boolean): boolean {
    if (!playerWagerPile || !opponentWagerPile) {
      return false;
    }
    const winnerSource = winnerIsOpponent ? opponentWagerPile : playerWagerPile;
    const loserSource = winnerIsOpponent ? playerWagerPile : opponentWagerPile;
    const material = winnerSource.material || loserSource.material;
    if (!material) {
      return false;
    }
    const winnerCount = Math.max(
      0,
      winnerSource.actualCount || winnerSource.count,
    );
    const loserCount = Math.max(
      0,
      loserSource.actualCount || loserSource.count,
    );
    const totalCount = winnerCount + loserCount;
    if (totalCount <= 0) {
      return false;
    }
    const winnerPile = ensureWinnerWagerPile();
    if (!winnerPile) {
      return false;
    }

    cancelWagerWinAnimation();

    const materialUrl =
      winnerSource.materialUrl || loserSource.materialUrl || null;
    const displayWinnerCount = Math.min(
      winnerSource.count,
      MAX_WAGER_WIN_PILE_ITEMS,
    );
    const displayTotal = Math.min(
      MAX_WAGER_WIN_PILE_ITEMS,
      displayWinnerCount + loserCount,
    );
    syncWagerPileIcons(
      winnerPile,
      material,
      displayTotal,
      materialUrl,
      MAX_WAGER_WIN_PILE_ITEMS,
    );

    const visibleCount = winnerPile.count;
    if (visibleCount === 0) {
      return false;
    }

    const winnerVisible = Math.min(visibleCount, displayWinnerCount);
    const loserVisible = visibleCount - winnerVisible;

    const winnerSourceRect = getWagerPileRect(winnerIsOpponent);
    const loserRect = getWagerPileRect(!winnerIsOpponent);
    const winnerRect = getWagerWinnerRect(winnerIsOpponent);
    if (
      !wagerRectIsVisible(winnerSourceRect) ||
      !wagerRectIsVisible(loserRect) ||
      !wagerRectIsVisible(winnerRect)
    ) {
      return false;
    }
    winnerPileActive = true;

    const iconSize = getWagerIconLayout(winnerSourceRect).iconSize;
    const winnerLayout = getWagerIconLayout(winnerRect, iconSize);
    const winnerSourceLayout = getWagerIconLayout(winnerSourceRect, iconSize);
    const loserLayout = getWagerIconLayout(loserRect, iconSize);

    const winnerAnchoredCount = Math.min(
      winnerVisible,
      winnerSource.positions.length,
    );
    const winnerAnchoredStarts = buildWagerFrames(
      winnerSourceRect,
      winnerSourceLayout,
      winnerSource.positions,
      winnerAnchoredCount,
    );
    const targetPositions = generateWagerPositions(visibleCount);
    const winnerExtraPositions = targetPositions.slice(
      winnerAnchoredCount,
      winnerVisible,
    );
    const loserPositions = targetPositions.slice(
      winnerVisible,
      winnerVisible + loserVisible,
    );

    const winnerAnchoredPositions = winnerAnchoredStarts.map((frame) => {
      const u =
        winnerLayout.maxX > 0
          ? (frame.x - winnerRect.x + winnerLayout.padding) / winnerLayout.maxX
          : 0.5;
      const v =
        winnerLayout.maxY > 0
          ? (frame.y - winnerRect.y + winnerLayout.padding) / winnerLayout.maxY
          : 0.5;
      return { u: clampWagerUnit(u), v: clampWagerUnit(v) };
    });

    const winnerPositions =
      winnerAnchoredPositions.concat(winnerExtraPositions);
    winnerPile.positions = winnerPositions.concat(loserPositions);

    const targets = winnerPile.positions.map((pos) =>
      getWagerIconFrame(winnerRect, winnerLayout, pos),
    );
    const winnerExtraStarts = winnerExtraPositions.map((pos) =>
      getWagerIconFrame(winnerRect, winnerLayout, pos),
    );
    const loserStarts = buildWagerFrames(
      loserRect,
      loserLayout,
      loserSource.positions,
      loserVisible,
    );
    const starts = winnerAnchoredStarts.concat(winnerExtraStarts, loserStarts);
    const startSpaces: WagerWinAnimationStartSpace[] = [
      ...winnerAnchoredStarts.map(() => "winnerSource" as const),
      ...winnerExtraStarts.map(() => "winnerTarget" as const),
      ...loserStarts.map(() => "loserSource" as const),
    ];

    winnerPile.rect = winnerRect;
    winnerPile.iconSize = iconSize;
    winnerPile.frames = starts.map((frame) => ({ x: frame.x, y: frame.y }));

    const drifts = starts.map((start, index) => {
      if (index < winnerVisible) {
        return { x: 0, y: 0 };
      }
      const target = targets[index] || start;
      const dx = target.x - start.x;
      const dy = target.y - start.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const amp = 0.12 + dependencies.random() * 0.28;
      const dir = dependencies.random() < 0.5 ? -1 : 1;
      return { x: nx * amp * dir, y: ny * amp * dir };
    });

    const delays = starts.map((_, index) =>
      index < winnerVisible ? 0 : dependencies.random() * 0.1,
    );

    clearDisappearingPile("player");
    clearDisappearingPile("opponent");
    const startTime = dependencies.now();
    const animationState: WagerWinAnimationState = {
      startTime,
      duration: WAGER_WIN_ANIM_DURATION_MS,
      iconSize,
      starts,
      targets,
      drifts,
      delays,
      startSpaces,
      winnerIsOpponent,
      winnerSourceRect,
      loserSourceRect: loserRect,
      winnerRect,
    };
    wagerWinAnimState = animationState;
    wagerWinAnimActive = true;
    lastWagerWinnerIsOpponent = winnerIsOpponent;
    emitWagerRenderState();

    const animate = (time: number) => {
      const activeState = wagerWinAnimState;
      const progress = applyWagerWinAnimationFrame(time);
      if (progress === null || !activeState || !winnerWagerPile) {
        wagerWinAnimActive = false;
        wagerWinAnimState = null;
        wagerWinAnimRaf = null;
        return;
      }
      emitWagerRenderState();

      if (
        !wagerWinAnimActive ||
        wagerWinAnimState !== activeState ||
        !winnerWagerPile
      ) {
        return;
      }
      if (progress < 1) {
        wagerWinAnimRaf = dependencies.requestAnimationFrame(animate);
      } else {
        const { targets: finalTargets } = activeState;
        for (let i = 0; i < winnerWagerPile.count; i += 1) {
          const target = finalTargets[i];
          if (!target) continue;
          const frame = winnerWagerPile.frames[i];
          if (!frame) {
            winnerWagerPile.frames[i] = { x: target.x, y: target.y };
          } else {
            frame.x = target.x;
            frame.y = target.y;
          }
        }
        wagerWinAnimActive = false;
        wagerWinAnimState = null;
        wagerWinAnimRaf = null;
        emitWagerRenderState();
      }
    };

    if (!wagerWinAnimActive || wagerWinAnimState !== animationState) {
      return true;
    }
    wagerWinAnimRaf = dependencies.requestAnimationFrame(animate);
    return true;
  }

  function resetWagerPile(pile: WagerPile | null) {
    if (!pile) {
      return;
    }
    pile.positions = [];
    pile.frames = [];
    pile.material = null;
    pile.materialUrl = null;
    pile.count = 0;
    pile.actualCount = 0;
    pile.rect = null;
    pile.iconSize = 0;
  }

  function resetWagerAnimationState() {
    wagerAnimationsReady = false;
    previousPlayerPileVisible = false;
    previousOpponentPileVisible = false;
    lastVisiblePlayerPileState = null;
    lastVisibleOpponentPileState = null;
    clearDisappearingPile("player");
    clearDisappearingPile("opponent");
  }

  function markWagerInitialStateReceived() {
    wagerAnimationsReady = true;
  }

  function suppressWagerPileTransition() {
    suppressNextWagerPileTransition = true;
  }

  function isWagerWinAnimationPendingOrActive() {
    return wagerWinAnimActive || deferredResolvedWager?.animate === true;
  }

  function clearWagerPiles() {
    deferredResolvedWager = null;
    cancelWagerWinAnimation();
    winnerPileActive = false;
    playerPilePending = false;
    opponentPilePending = false;
    resetWagerPile(playerWagerPile);
    resetWagerPile(opponentWagerPile);
    resetWagerPile(winnerWagerPile);
    emitWagerRenderState();
  }

  function clearWagerPilesForNewMatch() {
    resetWagerAnimationState();
    clearWagerPiles();
  }

  function setWagerPiles(state: {
    player?: {
      material: MaterialName;
      count: number;
      pending?: boolean;
    } | null;
    opponent?: {
      material: MaterialName;
      count: number;
      pending?: boolean;
    } | null;
  }) {
    deferredResolvedWager = null;
    cancelWagerWinAnimation();
    winnerPileActive = false;
    if (state.player) {
      const playerPile = ensureWagerPile(false);
      if (playerPile) {
        syncWagerPileIcons(
          playerPile,
          state.player.material,
          state.player.count,
        );
      }
      playerPilePending = state.player.pending ?? false;
    } else {
      resetWagerPile(playerWagerPile);
      playerPilePending = false;
    }
    if (state.opponent) {
      const opponentPile = ensureWagerPile(true);
      if (opponentPile) {
        syncWagerPileIcons(
          opponentPile,
          state.opponent.material,
          state.opponent.count,
        );
      }
      opponentPilePending = state.opponent.pending ?? false;
    } else {
      resetWagerPile(opponentWagerPile);
      opponentPilePending = false;
    }
    resetWagerPile(winnerWagerPile);
    updateWagerLayout();
  }

  function showDeferredResolvedWagerIfReady() {
    if (
      !deferredResolvedWager ||
      committedWagerSlotLayoutRevision <
        deferredResolvedWager.requiredLayoutRevision ||
      committedWagerSlotLayoutRevision < wagerSlotLayoutRevision
    ) {
      return;
    }
    const request = deferredResolvedWager;
    deferredResolvedWager = null;
    showResolvedWagerNow(
      request.winnerIsOpponent,
      request.material,
      request.countPerSide,
      request.animate,
    );
  }

  function showResolvedWager(
    winnerIsOpponent: boolean,
    material: MaterialName,
    countPerSide: number,
    animate: boolean,
  ) {
    if (committedWagerSlotLayoutRevision < wagerSlotLayoutRevision) {
      deferredResolvedWager = {
        winnerIsOpponent,
        material,
        countPerSide,
        animate,
        requiredLayoutRevision: wagerSlotLayoutRevision,
      };
      dependencies.log("show-resolved:deferred-for-layout", {
        committedLayoutRevision: committedWagerSlotLayoutRevision,
        requiredLayoutRevision: wagerSlotLayoutRevision,
      });
      return;
    }
    deferredResolvedWager = null;
    showResolvedWagerNow(winnerIsOpponent, material, countPerSide, animate);
  }

  function showResolvedWagerNow(
    winnerIsOpponent: boolean,
    material: MaterialName,
    countPerSide: number,
    animate: boolean,
  ) {
    dependencies.log("show-resolved:start", {
      winnerIsOpponent,
      material,
      countPerSide,
      animate,
    });
    const playerPile = ensureWagerPile(false);
    const opponentPile = ensureWagerPile(true);
    if (!playerPile || !opponentPile) {
      dependencies.log("show-resolved:skip-no-piles");
      return;
    }
    cancelWagerWinAnimation();
    winnerPileActive = false;
    syncWagerPileIcons(playerPile, material, countPerSide);
    syncWagerPileIcons(opponentPile, material, countPerSide);
    updateWagerLayout();
    lastWagerWinnerIsOpponent = winnerIsOpponent;
    if (animate && startWagerWinAnimation(winnerIsOpponent)) {
      dependencies.log("show-resolved:started-win-animation");
      return;
    }
    const winnerPile = ensureWinnerWagerPile();
    if (!winnerPile) {
      dependencies.log("show-resolved:skip-no-winner-pile");
      return;
    }
    const total = Math.max(0, countPerSide * 2);
    syncWagerPileIcons(
      winnerPile,
      material,
      total,
      null,
      MAX_WAGER_WIN_PILE_ITEMS,
    );
    winnerPileActive = true;
    dependencies.log("show-resolved:show-winner-pile", {
      winnerCount: winnerPile.count,
      total,
    });
    updateWagerLayout();
  }

  return {
    setWagerRenderHandler,
    setWagerSlotLayouts,
    markWagerInitialStateReceived,
    suppressWagerPileTransition,
    isWagerWinAnimationPendingOrActive,
    clearWagerPiles,
    clearWagerPilesForNewMatch,
    setWagerPiles,
    showResolvedWager,
    invalidateLayout: invalidateWagerSlotLayout,
    getLayoutRevision: () => wagerSlotLayoutRevision,
    updateLayout: updateWagerLayout,
    cancelWinAnimation: cancelWagerWinAnimation,
    dispose: clearWagerPilesForNewMatch,
  };
}
