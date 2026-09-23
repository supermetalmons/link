import type { AuthVerificationResponse } from "@mons/shared/auth";

export type WalletButtonUiState =
  "idle" | "connecting" | "verifying" | "not-found";

export type WalletAuthFlowOptions = {
  canStart: () => boolean;
  onStart: () => void;
  onVerified: (result: AuthVerificationResponse, mounted: boolean) => void;
  onError: (error: unknown) => void;
  onSettled?: (mounted: boolean) => void | Promise<void>;
};

type WalletAuthFlowDependencies<Proof> = {
  connect: () => Promise<Proof | null>;
  verify: (proof: Proof) => Promise<AuthVerificationResponse>;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

export const createWalletAuthFlowController = <Proof>({
  dependencies,
  notFoundDurationMs,
}: {
  dependencies: WalletAuthFlowDependencies<Proof>;
  notFoundDurationMs: number;
}) => {
  const scheduleTimeout = dependencies.setTimeout ?? setTimeout;
  const cancelTimeout = dependencies.clearTimeout ?? clearTimeout;
  const listeners = new Set<() => void>();
  let state: WalletButtonUiState = "idle";
  let options: WalletAuthFlowOptions | null = null;
  let mounted = true;
  let latestAction = 0;
  let runningAction: number | null = null;
  let notFoundTimeout: ReturnType<typeof setTimeout> | null = null;

  const clearNotFoundTimeout = () => {
    if (notFoundTimeout !== null) {
      cancelTimeout(notFoundTimeout);
      notFoundTimeout = null;
    }
  };

  const updateState = (nextState: WalletButtonUiState) => {
    if (!mounted || state === nextState) return;
    state = nextState;
    listeners.forEach((listener) => listener());
  };

  const start = async (): Promise<void> => {
    if (!mounted || runningAction !== null || !options?.canStart()) return;
    const callbacks = options;
    const action = ++latestAction;
    const isCurrent = () => action === latestAction;
    runningAction = action;
    clearNotFoundTimeout();
    updateState("connecting");
    try {
      callbacks.onStart();
      const proof = await dependencies.connect();
      if (!isCurrent() || proof === null) return;
      updateState("verifying");
      const result = await dependencies.verify(proof);
      if (isCurrent()) callbacks.onVerified(result, mounted);
    } catch (error) {
      if (isCurrent() && mounted) {
        if (error instanceof Error && error.message === "not found") {
          updateState("not-found");
          notFoundTimeout = scheduleTimeout(() => {
            notFoundTimeout = null;
            if (isCurrent()) updateState("idle");
          }, notFoundDurationMs);
        }
        callbacks.onError(error);
      }
    } finally {
      if (runningAction === action) runningAction = null;
      if (isCurrent()) {
        if (state !== "not-found") updateState("idle");
        await callbacks.onSettled?.(mounted);
      }
    }
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setOptions: (nextOptions: WalletAuthFlowOptions) => {
      options = nextOptions;
    },
    attach: () => {
      mounted = true;
    },
    detach: () => {
      mounted = false;
      clearNotFoundTimeout();
    },
    start,
    invalidateAction: () => {
      latestAction += 1;
      runningAction = null;
      clearNotFoundTimeout();
      updateState("idle");
    },
  };
};
