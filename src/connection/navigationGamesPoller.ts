export type NavigationGamesPollingDependencies<T> = {
  addInvalidationListener: (listener: () => void) => () => void;
  addVisibilityListener: (listener: () => void) => () => void;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  intervalMs: number;
  isActive: () => boolean;
  isVisible: () => boolean;
  load: () => Promise<T>;
  maxConsecutiveFailures: number;
  onError: (error: unknown) => void;
  onUpdate: (value: T) => void;
  setTimer: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
};

export function startNavigationGamesPolling<T>(
  dependencies: NavigationGamesPollingDependencies<T>,
): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let refreshQueued = false;
  let consecutiveFailures = 0;

  const clearScheduled = () => {
    if (timer !== null) {
      dependencies.clearTimer(timer);
      timer = null;
    }
  };
  const schedule = (delayMs: number) => {
    clearScheduled();
    if (disposed || !dependencies.isActive() || !dependencies.isVisible()) {
      return;
    }
    timer = dependencies.setTimer(() => {
      timer = null;
      void poll();
    }, delayMs);
  };
  const poll = async () => {
    if (disposed || !dependencies.isActive() || !dependencies.isVisible()) {
      return;
    }
    if (inFlight) {
      refreshQueued = true;
      return;
    }
    inFlight = true;
    try {
      const value = await dependencies.load();
      if (disposed || !dependencies.isActive()) return;
      consecutiveFailures = 0;
      dependencies.onUpdate(value);
    } catch (error) {
      if (disposed || !dependencies.isActive()) return;
      consecutiveFailures += 1;
      if (consecutiveFailures >= dependencies.maxConsecutiveFailures) {
        disposed = true;
        dependencies.onError(error);
        return;
      }
    } finally {
      inFlight = false;
      if (!disposed && dependencies.isActive()) {
        const delay = refreshQueued ? 0 : dependencies.intervalMs;
        refreshQueued = false;
        schedule(delay);
      }
    }
  };
  const refresh = () => {
    if (inFlight) refreshQueued = true;
    else schedule(0);
  };
  const visibilityChanged = () => {
    if (dependencies.isVisible()) refresh();
    else clearScheduled();
  };
  const removeInvalidation = dependencies.addInvalidationListener(refresh);
  const removeVisibility =
    dependencies.addVisibilityListener(visibilityChanged);
  refresh();

  return () => {
    disposed = true;
    clearScheduled();
    removeInvalidation();
    removeVisibility();
  };
}
