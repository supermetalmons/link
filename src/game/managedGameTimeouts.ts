import {
  decrementLifecycleCounter,
  incrementLifecycleCounter,
} from "../lifecycle/lifecycleDiagnostics";

const activeTimeoutIds = new Set<number>();

export const setManagedGameTimeout = (
  callback: () => void,
  delay: number,
  guard?: () => boolean,
): number => {
  incrementLifecycleCounter("gameTimeouts");
  const timeoutId = window.setTimeout(() => {
    if (activeTimeoutIds.has(timeoutId)) {
      activeTimeoutIds.delete(timeoutId);
      decrementLifecycleCounter("gameTimeouts");
    }
    if (guard && !guard()) {
      return;
    }
    callback();
  }, delay);
  activeTimeoutIds.add(timeoutId);
  return timeoutId;
};

export const clearManagedGameTimeout = (timeoutId: number | null): void => {
  if (timeoutId === null) {
    return;
  }
  if (activeTimeoutIds.has(timeoutId)) {
    activeTimeoutIds.delete(timeoutId);
    decrementLifecycleCounter("gameTimeouts");
  }
  clearTimeout(timeoutId);
};

export const clearAllManagedGameTimeouts = (): void => {
  activeTimeoutIds.forEach((timeoutId) => {
    clearTimeout(timeoutId);
    decrementLifecycleCounter("gameTimeouts");
  });
  activeTimeoutIds.clear();
};
