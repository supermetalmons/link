import {
  decrementLifecycleCounter,
  incrementLifecycleCounter,
} from "../lifecycle/lifecycleDiagnostics";

const timeoutIds = new Set<number>();
const rafIds = new Set<number>();

export const trackBoardTimeout = (timeoutId: number): void => {
  timeoutIds.add(timeoutId);
  incrementLifecycleCounter("boardTimeouts");
};

export const releaseTrackedBoardTimeout = (timeoutId: number): void => {
  if (!timeoutIds.has(timeoutId)) {
    return;
  }
  timeoutIds.delete(timeoutId);
  decrementLifecycleCounter("boardTimeouts");
};

export const setManagedBoardTimeout = (
  callback: () => void,
  delay: number,
): number => {
  const timeoutId = window.setTimeout(() => {
    releaseTrackedBoardTimeout(timeoutId);
    callback();
  }, delay);
  trackBoardTimeout(timeoutId);
  return timeoutId;
};

export const cancelManagedBoardTimeout = (timeoutId: number | null): void => {
  if (timeoutId === null) {
    return;
  }
  releaseTrackedBoardTimeout(timeoutId);
  clearTimeout(timeoutId);
};

export const clearTrackedBoardTimeouts = (): void => {
  timeoutIds.forEach((timeoutId) => {
    clearTimeout(timeoutId);
    decrementLifecycleCounter("boardTimeouts");
  });
  timeoutIds.clear();
};

export const setManagedBoardRaf = (callback: FrameRequestCallback): number => {
  let rafId = 0;
  rafId = window.requestAnimationFrame((timestamp) => {
    if (rafIds.has(rafId)) {
      rafIds.delete(rafId);
      decrementLifecycleCounter("boardRaf");
    }
    callback(timestamp);
  });
  rafIds.add(rafId);
  incrementLifecycleCounter("boardRaf");
  return rafId;
};

export const cancelManagedBoardRaf = (rafId: number | null): void => {
  if (rafId === null) {
    return;
  }
  if (rafIds.has(rafId)) {
    rafIds.delete(rafId);
    decrementLifecycleCounter("boardRaf");
  }
  cancelAnimationFrame(rafId);
};

export const clearTrackedBoardRafs = (): void => {
  rafIds.forEach((rafId) => {
    cancelAnimationFrame(rafId);
    decrementLifecycleCounter("boardRaf");
  });
  rafIds.clear();
};
