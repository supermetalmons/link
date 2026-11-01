import {
  MATCH_TIMER_DURATION_SECONDS,
  type MatchTimer,
  parseMatchTimer,
} from "@mons/shared/timers";
import type { BoardViewMode } from "./boardViewPolicy";

type TimerColor = "white" | "black";

export interface MatchTimerContext {
  isOnlineGame: boolean;
  isReconnect: boolean;
  didConnect: boolean;
  isWatchOnly: boolean;
  isGameOver: boolean;
  hasWinner: boolean;
  hasTimerWinner: boolean;
  isPlayerSideTurn: boolean;
  boardViewMode: BoardViewMode;
  turnNumber: number;
  activeColor: TimerColor | null;
  activeMatchId: string | null;
  fallbackMatchId: string | null;
}

interface MatchTimerRecord {
  color: TimerColor;
  timer: MatchTimer;
}

interface MatchTimerDependencies {
  getContext: () => MatchTimerContext;
  matchBelongsToCurrentInvite: (matchId: string) => boolean;
  now: () => number;
  createSessionGuard: () => () => boolean;
  setTimeout: (
    callback: () => void,
    delay: number,
    guard?: () => boolean,
  ) => number;
  clearTimeout: (id: number) => void;
  showCountdown: (color: TimerColor, seconds: number) => void;
  hideCountdown: () => void;
  hideButtons: () => void;
  showProgress: (
    progress: number,
    duration: number,
    isActivationCooldown: boolean,
  ) => void;
  enableVictoryClaim: () => void;
  onTerminal: (onConnect: boolean, winnerColor: TimerColor) => void;
}

export const createMatchTimerController = (deps: MatchTimerDependencies) => {
  let matchId: string | null = null;
  let whiteStash: MatchTimer | null = null;
  let blackStash: MatchTimer | null = null;
  let pendingResolutionOnRestore: boolean | null = null;
  let cooldown: {
    matchId: string;
    turnNumber: number;
    startedAtMs: number;
  } | null = null;
  let victoryClaimTimeoutId: number | null = null;
  let claimGeneration = 0;

  const cancelVictoryClaim = () => {
    claimGeneration += 1;
    if (victoryClaimTimeoutId !== null) {
      deps.clearTimeout(victoryClaimTimeoutId);
      victoryClaimTimeoutId = null;
    }
  };

  const clearCooldown = () => {
    cooldown = null;
    cancelVictoryClaim();
  };

  const reset = (nextMatchId: string | null) => {
    matchId = nextMatchId;
    whiteStash = null;
    blackStash = null;
    pendingResolutionOnRestore = null;
    clearCooldown();
  };

  const getMatchId = (preferredMatchId?: string | null): string | null => {
    if (preferredMatchId) {
      return preferredMatchId;
    }
    const context = deps.getContext();
    if (context.activeMatchId) {
      return context.activeMatchId;
    }
    if (matchId) {
      if (context.isOnlineGame && !deps.matchBelongsToCurrentInvite(matchId)) {
        return null;
      }
      return matchId;
    }
    return context.isOnlineGame ? null : context.fallbackMatchId;
  };

  const setStash = (
    nextMatchId: string | null,
    color: TimerColor,
    timer: MatchTimer,
  ) => {
    if (matchId !== nextMatchId) {
      reset(nextMatchId);
    }
    if (color === "white") {
      whiteStash = timer;
    } else {
      blackStash = timer;
    }
  };

  const seed = (
    nextMatchId: string,
    records: readonly (MatchTimerRecord | null | undefined)[],
  ) => {
    if (matchId !== nextMatchId) {
      reset(nextMatchId);
    }
    for (const record of records) {
      if (record?.color === "white" && whiteStash === null) {
        setStash(nextMatchId, "white", record.timer);
      } else if (record?.color === "black" && blackStash === null) {
        setStash(nextMatchId, "black", record.timer);
      }
    }
  };

  const startCooldown = (nextMatchId: string) => {
    cooldown = {
      matchId: nextMatchId,
      turnNumber: deps.getContext().turnNumber,
      startedAtMs: deps.now(),
    };
  };

  const restoreCooldown = (nextMatchId: string) => {
    if (
      cooldown?.matchId !== nextMatchId ||
      cooldown.turnNumber !== deps.getContext().turnNumber
    ) {
      startCooldown(nextMatchId);
      deps.showProgress(0, MATCH_TIMER_DURATION_SECONDS, true);
      return;
    }
    const elapsedSeconds = Math.max(
      0,
      (deps.now() - cooldown.startedAtMs) / 1000,
    );
    deps.showProgress(
      Math.min(MATCH_TIMER_DURATION_SECONDS, elapsedSeconds),
      MATCH_TIMER_DURATION_SECONDS,
      true,
    );
  };

  const waitsForStashes = () => {
    const context = deps.getContext();
    return (
      (context.isWatchOnly || context.isReconnect) &&
      (blackStash === null || whiteStash === null)
    );
  };

  const getStateFromStashes = (expectedMatchId: string | null) => {
    const context = deps.getContext();
    if (
      (context.isOnlineGame && !expectedMatchId) ||
      (expectedMatchId && matchId !== expectedMatchId) ||
      waitsForStashes()
    ) {
      return null;
    }
    if (context.activeColor === "black") {
      return { timer: whiteStash, color: "white" as const };
    }
    if (context.activeColor === "white") {
      return { timer: blackStash, color: "black" as const };
    }
    return null;
  };

  const showCountdown = (
    onConnect: boolean,
    timer: MatchTimer | null,
    color: TimerColor,
    duration?: number,
  ): boolean => {
    if (timer?.state === "finished") {
      clearCooldown();
      deps.onTerminal(onConnect, color);
      return true;
    }
    const context = deps.getContext();
    if (timer?.state !== "running" || context.isGameOver) {
      return false;
    }
    const parsedTimer = parseMatchTimer(timer);
    if (!parsedTimer || parsedTimer.turnNumber !== context.turnNumber) {
      return false;
    }
    clearCooldown();
    const { turnNumber, deadlineAtMs } = parsedTimer;
    let delta = Math.max(0, Math.floor((deadlineAtMs - deps.now()) / 1000));
    if (duration !== undefined && duration !== null) {
      delta = Math.min(Math.floor(duration / 1000), delta);
    }
    deps.showCountdown(color, delta);
    const displayedContext = deps.getContext();
    if (!displayedContext.isWatchOnly && !displayedContext.isPlayerSideTurn) {
      deps.showProgress(
        MATCH_TIMER_DURATION_SECONDS - delta,
        MATCH_TIMER_DURATION_SECONDS,
        false,
      );
      const claimMatchId = getMatchId();
      if (claimMatchId !== null) {
        const generation = claimGeneration;
        victoryClaimTimeoutId = deps.setTimeout(
          () => {
            if (generation !== claimGeneration) {
              return;
            }
            victoryClaimTimeoutId = null;
            const current = deps.getContext();
            if (
              current.activeMatchId !== claimMatchId ||
              (current.isReconnect && !current.didConnect) ||
              current.boardViewMode !== "activeLive" ||
              current.isGameOver ||
              current.isWatchOnly ||
              current.isPlayerSideTurn ||
              current.turnNumber !== turnNumber
            ) {
              return;
            }
            deps.enableVictoryClaim();
          },
          delta * 1000,
          deps.createSessionGuard(),
        );
      }
    }
    return true;
  };

  const restore = (): boolean => {
    const context = deps.getContext();
    if (context.boardViewMode !== "activeLive") {
      return false;
    }
    const state = getStateFromStashes(getMatchId());
    const restored = state
      ? showCountdown(
          pendingResolutionOnRestore ?? context.isReconnect,
          state.timer,
          state.color,
        )
      : false;
    pendingResolutionOnRestore = null;
    return restored;
  };

  const hide = () => {
    clearCooldown();
    deps.hideButtons();
    deps.hideCountdown();
  };

  const fallback = (nextMatchId: string) => {
    const context = deps.getContext();
    if (context.isGameOver || context.hasWinner || context.hasTimerWinner) {
      hide();
    } else if (!context.isWatchOnly && !context.isPlayerSideTurn) {
      restoreCooldown(nextMatchId);
    } else {
      hide();
    }
  };

  const update = (
    onConnect: boolean,
    record: MatchTimerRecord,
    nextMatchId: string,
  ) => {
    setStash(
      nextMatchId,
      record.color === "white" ? "white" : "black",
      record.timer,
    );
    const context = deps.getContext();
    const state = getStateFromStashes(nextMatchId);
    if (!state) {
      if (context.boardViewMode === "activeLive" && !waitsForStashes()) {
        fallback(nextMatchId);
      }
      return;
    }
    if (context.boardViewMode !== "activeLive") {
      if (state.timer?.state === "finished") {
        pendingResolutionOnRestore = onConnect;
      }
      return;
    }
    pendingResolutionOnRestore = null;
    if (!showCountdown(onConnect, state.timer, state.color)) {
      if (state.timer !== null && state.timer.state !== "idle") {
        hide();
      } else {
        fallback(nextMatchId);
      }
    }
  };

  return {
    reset,
    cancelVictoryClaim,
    clearCooldown,
    getMatchId,
    setStash,
    seed,
    startCooldown,
    restoreCooldown,
    waitsForStashes,
    showCountdown,
    restore,
    update,
  };
};
