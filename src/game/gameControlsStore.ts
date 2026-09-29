import { MATCH_TIMER_DURATION_SECONDS } from "@mons/shared/timers";
import {
  createGameControlsState,
  type TimerConfig,
} from "../ui/controls/bottomControlsState";
import {
  createGameControlsContext,
  createGameControlsPresentation,
  type GameControlsContext,
  type GameControlsPresentation,
  type GameControlsSnapshot,
} from "./gameControlsModel";

const hasChanges = <T extends object>(current: T, updates: Partial<T>) =>
  (Object.keys(updates) as Array<keyof T>).some(
    (key) => !Object.is(current[key], updates[key]),
  );

export function createGameControlsStore(initialTimerConfig: TimerConfig) {
  let snapshot: GameControlsSnapshot = {
    context: createGameControlsContext(),
    presentation: createGameControlsPresentation(
      createGameControlsState(initialTimerConfig),
    ),
  };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    updateContext: (updates: Partial<GameControlsContext>) => {
      if (!hasChanges(snapshot.context, updates)) return;
      snapshot = { ...snapshot, context: { ...snapshot.context, ...updates } };
      notify();
    },
    updatePresentation: (updates: Partial<GameControlsPresentation>) => {
      if (!hasChanges(snapshot.presentation, updates)) return;
      snapshot = {
        ...snapshot,
        presentation: { ...snapshot.presentation, ...updates },
      };
      notify();
    },
    resetPresentation: (timerConfig: TimerConfig) => {
      snapshot = {
        ...snapshot,
        presentation: createGameControlsPresentation(
          createGameControlsState(timerConfig),
        ),
      };
      notify();
    },
  };
}

const gameControlsStore = createGameControlsStore({
  duration: MATCH_TIMER_DURATION_SECONDS,
  progress: 0,
  requestDate: Date.now(),
});

export const getGameControlsSnapshot = gameControlsStore.getSnapshot;
export const subscribeGameControls = gameControlsStore.subscribe;
export const updateGameControlsContext = gameControlsStore.updateContext;
export const updateGameControlsPresentation =
  gameControlsStore.updatePresentation;
export const resetGameControlsPresentation =
  gameControlsStore.resetPresentation;
