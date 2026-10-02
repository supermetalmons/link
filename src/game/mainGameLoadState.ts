type Listener = () => void;
type LoadState = {
  generation: number;
  phase: "loading" | "game" | "waiting" | "error";
  contentReady: boolean;
  canPlay: boolean;
  settled: boolean;
};
type Dependencies = {
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (id: number) => void;
  mark?: (name: string) => void;
};

export function createMainGameLoadState(dependencies: Dependencies) {
  let state: LoadState = {
    generation: 0,
    phase: "loading",
    contentReady: false,
    canPlay: false,
    settled: false,
  };
  let frame: number | null = null;
  const listeners = new Set<Listener>();
  const notify = () => listeners.forEach((listener) => listener());
  const settleAfterFrame = () => {
    if (state.settled || frame !== null) return;
    const generation = state.generation;
    frame = dependencies.requestFrame(() => {
      if (state.generation !== generation) return;
      frame = dependencies.requestFrame(() => {
        if (state.generation !== generation) return;
        frame = null;
        state = { ...state, settled: true };
        dependencies.mark?.("main-game:initial-view-ready");
        notify();
      });
    });
  };
  const markReady = (phase: LoadState["phase"], canPlay: boolean) => {
    if (state.phase !== phase || state.canPlay !== canPlay) {
      state = { ...state, phase, contentReady: phase === "game", canPlay };
      dependencies.mark?.(
        phase === "game"
          ? "main-game:content-ready"
          : "main-game:view-resolved",
      );
      if (canPlay) dependencies.mark?.("main-game:interaction-ready");
      notify();
    }
    settleAfterFrame();
  };
  return {
    getSnapshot: () => state,
    isLoaded: () => state.settled,
    onLoaded: (listener: Listener) => {
      if (state.settled) {
        listener();
        return () => {};
      }
      const onChange = () => {
        if (!state.settled) return;
        listeners.delete(onChange);
        listener();
      };
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    markRoutePrepared: () => dependencies.mark?.("main-game:route-prepared"),
    markContentReady: (canPlay: boolean) => markReady("game", canPlay),
    markWaiting: () => markReady("waiting", false),
    markError: () => markReady("error", false),
    reset: () => {
      if (frame !== null) dependencies.cancelFrame(frame);
      frame = null;
      state = {
        generation: state.generation + 1,
        phase: "loading",
        contentReady: false,
        canPlay: false,
        settled: false,
      };
      notify();
    },
  };
}

const mainGameLoadState = createMainGameLoadState({
  requestFrame: (callback) => {
    if (typeof requestAnimationFrame === "function")
      return requestAnimationFrame(callback);
    queueMicrotask(() => callback(0));
    return 0;
  },
  cancelFrame: (id) => {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  },
  mark: (name) => performance.mark(name),
});

export const getMainGameLoadState = mainGameLoadState.getSnapshot;
export const isMainGameLoaded = mainGameLoadState.isLoaded;
export const onMainGameLoaded = mainGameLoadState.onLoaded;
export const markMainGameRoutePrepared = mainGameLoadState.markRoutePrepared;
export const markMainGameContentReady = mainGameLoadState.markContentReady;
export const markMainGameWaiting = mainGameLoadState.markWaiting;
export const markMainGameError = mainGameLoadState.markError;
export const resetMainGameLoadedState = mainGameLoadState.reset;
