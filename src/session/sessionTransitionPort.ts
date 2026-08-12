import type { RouteState } from "../navigation/routeState";

export type SessionTransitionOptions = {
  replace?: boolean;
  skipNavigation?: boolean;
  resetProfileScope?: boolean;
  force?: boolean;
};

export type TransitionToHomeOptions = {
  resetProfileScope?: boolean;
  forceMatchScopeReset?: boolean;
  replace?: boolean;
};

export type SessionTransitionRuntime = {
  transition(
    target: RouteState,
    options?: SessionTransitionOptions,
  ): Promise<void>;
  transitionToHome(options?: TransitionToHomeOptions): Promise<void>;
  isTransitionInProgress(): boolean;
};

let runtime: SessionTransitionRuntime | null = null;

const getRuntime = (): SessionTransitionRuntime => {
  if (!runtime) {
    throw new Error("session-transition-runtime-not-bound");
  }
  return runtime;
};

export const bindSessionTransitionRuntime = (
  nextRuntime: SessionTransitionRuntime,
): SessionTransitionRuntime => {
  runtime = nextRuntime;
  return nextRuntime;
};

export const transition = (
  target: RouteState,
  options?: SessionTransitionOptions,
): Promise<void> => {
  const { transition } = getRuntime();
  return transition(target, options);
};

export const transitionToHome = (
  options?: TransitionToHomeOptions,
): Promise<void> => {
  const { transitionToHome } = getRuntime();
  return transitionToHome(options);
};

export const isTransitionInProgress = (): boolean => {
  const { isTransitionInProgress } = getRuntime();
  return isTransitionInProgress();
};
