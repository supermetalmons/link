import { createMatchTimerController } from "../../src/game/matchTimerController.ts";

/**
 * @typedef {import("../../src/game/matchTimerController.ts").MatchTimerContext} MatchTimerContext
 * @typedef {Parameters<typeof createMatchTimerController>[0]} MatchTimerDependencies
 * @typedef {["countdown", ...Parameters<MatchTimerDependencies["showCountdown"]>]
 *   | ["hideCountdown"] | ["hideButtons"] | ["claim"]
 *   | ["progress", ...Parameters<MatchTimerDependencies["showProgress"]>]
 *   | ["terminal", ...Parameters<MatchTimerDependencies["onTerminal"]>]} MatchTimerEvent
 */

/**
 * @param {Partial<MatchTimerContext>} [overrides]
 * @param {() => Partial<MatchTimerContext>} [readContext]
 * @param {(event: MatchTimerEvent) => void} [onEvent]
 */
export function createMatchTimerHarness(
  overrides = {},
  readContext = () => ({}),
  onEvent = () => {},
) {
  let now = 1_000;
  let session = 1;
  let nextTimer = 0;
  /** @type {Set<string> | null} */
  let allowedMatchIds = null;
  /** @type {Map<number, { delay: number; run(): void }>} */
  const timers = new Map();
  /** @type {MatchTimerEvent[]} */
  const events = [];
  /** @param {MatchTimerEvent} event */
  const emit = (event) => {
    events.push(event);
    onEvent(event);
  };
  /** @type {MatchTimerContext} */
  const context = {
    isOnlineGame: true,
    isReconnect: false,
    didConnect: true,
    isWatchOnly: false,
    isGameOver: false,
    hasWinner: false,
    hasTimerWinner: false,
    isPlayerSideTurn: false,
    boardViewMode: "activeLive",
    turnNumber: 4,
    activeColor: "black",
    activeMatchId: "match",
    fallbackMatchId: null,
    ...overrides,
  };
  const controller = createMatchTimerController({
    getContext: () => ({ ...context, ...readContext() }),
    matchBelongsToCurrentInvite: (id) =>
      allowedMatchIds === null || allowedMatchIds.has(id),
    now: () => now,
    createSessionGuard: () => {
      const expected = session;
      return () => session === expected;
    },
    setTimeout(callback, delay, guard) {
      const id = ++nextTimer;
      timers.set(id, {
        delay,
        run() {
          timers.delete(id);
          if (!guard || guard()) callback();
        },
      });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    showCountdown: (...args) => emit(["countdown", ...args]),
    hideCountdown: () => emit(["hideCountdown"]),
    hideButtons: () => emit(["hideButtons"]),
    showProgress: (...args) => emit(["progress", ...args]),
    enableVictoryClaim: () => emit(["claim"]),
    onTerminal: (...args) => emit(["terminal", ...args]),
  });
  return {
    controller,
    context,
    timers,
    events,
    /** @param {number} milliseconds */
    advance: (milliseconds) => (now += milliseconds),
    /** @param {number} milliseconds */
    setNow: (milliseconds) => (now = milliseconds),
    invalidateSession: () => session++,
    /** @param {...string} ids */
    allowMatches: (...ids) => (allowedMatchIds = new Set(ids)),
  };
}
