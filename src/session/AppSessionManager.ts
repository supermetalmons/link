import {
  beginMatchSession,
  getCurrentSessionEpoch,
  getCurrentSessionId as getMatchSessionId,
  incrementSessionEpoch,
} from "../game/matchSession";
import { getLifecycleCounters } from "../lifecycle/lifecycleDiagnostics";
import {
  initializeNavigation,
  pushRoutePath,
  replaceRoutePath,
  subscribeToNavigationState,
} from "../navigation/appNavigation";
import {
  RouteState,
  getCurrentRouteState,
  getRoutePathForTarget,
} from "../navigation/routeState";
import { INVALID_SNAPSHOT_ROUTE_ERROR } from "./sessionErrors";
import {
  bindSessionTransitionRuntime,
  type SessionTransitionOptions,
  type TransitionToHomeOptions,
} from "./sessionTransitionPort";

type AppSessionTarget = RouteState;
type PendingTransitionRequest = {
  target: RouteState;
  options?: SessionTransitionOptions;
  waiters: Array<() => void>;
};

let initialized = false;
let isTransitioning = false;
let isApplyingNavigation = false;
let currentTarget: AppSessionTarget = getCurrentRouteState();
let pendingTransitionRequest: PendingTransitionRequest | null = null;

const waitForBoardRoot = async (timeoutMs = 30000) => {
  if (document.getElementById("monsboard")) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const startedAt = performance.now();
    const poll = () => {
      if (document.getElementById("monsboard")) {
        resolve();
      } else if (performance.now() - startedAt >= timeoutMs) {
        reject(new Error("monsboard-root-timeout"));
      } else {
        window.setTimeout(poll, 16);
      }
    };
    poll();
  });
};

const routeStatesMatch = (a: RouteState, b: RouteState) => {
  return (
    a.mode === b.mode &&
    a.path === b.path &&
    a.inviteId === b.inviteId &&
    a.snapshotId === b.snapshotId &&
    a.eventId === b.eventId &&
    a.autojoin === b.autojoin
  );
};

const isLobbyRoute = (target: RouteState): boolean => {
  return target.mode === "home" || target.mode === "event";
};

const mergeQueuedTransitionOptions = (
  existing?: SessionTransitionOptions,
  incoming?: SessionTransitionOptions,
): SessionTransitionOptions | undefined => {
  const merged: SessionTransitionOptions = {};
  if (incoming?.replace !== undefined) {
    merged.replace = incoming.replace;
  }
  if (incoming?.skipNavigation !== undefined) {
    merged.skipNavigation = incoming.skipNavigation;
  }
  if (existing?.force || incoming?.force) {
    merged.force = true;
  }
  if (existing?.resetProfileScope || incoming?.resetProfileScope) {
    merged.resetProfileScope = true;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
};

const createHomeTarget = (): RouteState => {
  return {
    mode: "home",
    path: "",
    inviteId: null,
    snapshotId: null,
    eventId: null,
    autojoin: false,
  };
};

const logTransition = (from: RouteState, to: RouteState) => {
  const counters = getLifecycleCounters();
  console.log("session-transition", {
    from: from.path,
    to: to.path,
    sessionId: getMatchSessionId(),
    epoch: getCurrentSessionEpoch(),
    counters,
  });
};

const applyPathForTarget = (target: RouteState, replace = false) => {
  const nextPath = getRoutePathForTarget(target);
  if (window.location.pathname === nextPath) {
    return;
  }
  isApplyingNavigation = true;
  if (replace) {
    replaceRoutePath(nextPath);
  } else {
    pushRoutePath(nextPath);
  }
  isApplyingNavigation = false;
};

const bootstrapForRoute = async (target: RouteState) => {
  await waitForBoardRoot();
  const gameController = await import("../game/gameController");
  await gameController.go(target);
  const mainGameLoadState = await import("../game/mainGameLoadState");
  mainGameLoadState.markMainGameLoaded();
};

const syncEventModalForLobbyTarget = async (target: RouteState) => {
  const eventModalController = await import("../ui/eventModalController");
  if (target.mode === "event" && target.eventId) {
    eventModalController.openEventModal(target.eventId, {
      restoreHomeOnClose: true,
    });
    return;
  }
  if (eventModalController.hasEventModalVisible()) {
    await eventModalController.closeEventModal({
      skipHomeTransition: true,
      reason: "route_change",
    });
  }
};

const runTransition = async (
  target: RouteState,
  options?: SessionTransitionOptions,
) => {
  if (isTransitioning) {
    return new Promise<void>((resolve) => {
      if (pendingTransitionRequest) {
        pendingTransitionRequest.target = target;
        pendingTransitionRequest.options = mergeQueuedTransitionOptions(
          pendingTransitionRequest.options,
          options,
        );
        pendingTransitionRequest.waiters.push(resolve);
      } else {
        pendingTransitionRequest = { target, options, waiters: [resolve] };
      }
    });
  }
  const from = currentTarget;
  if (!options?.force && routeStatesMatch(from, target)) {
    return;
  }
  const shouldUseLightweightLobbyTransition =
    !options?.force &&
    !options?.resetProfileScope &&
    isLobbyRoute(from) &&
    isLobbyRoute(target);
  isTransitioning = true;
  if (shouldUseLightweightLobbyTransition) {
    try {
      if (!options?.skipNavigation) {
        applyPathForTarget(target, options?.replace === true);
      }
      await syncEventModalForLobbyTarget(target);
      currentTarget = target;
      logTransition(from, target);
    } catch (error) {
      currentTarget = getCurrentRouteState();
      console.error("session-transition-light-failed", {
        from: from.path,
        to: target.path,
        error,
      });
    } finally {
      isTransitioning = false;
    }
    const queuedRequest = pendingTransitionRequest;
    pendingTransitionRequest = null;
    if (queuedRequest) {
      if (
        queuedRequest.options?.force ||
        !routeStatesMatch(queuedRequest.target, currentTarget)
      ) {
        await runTransition(queuedRequest.target, queuedRequest.options);
      }
      queuedRequest.waiters.forEach((resolve) => resolve());
    }
    return;
  }
  incrementSessionEpoch();
  try {
    const lifecycleManager = await import("../lifecycle/lifecycleManager");
    lifecycleManager.teardownMatchScope(target);
    if (options?.resetProfileScope) {
      lifecycleManager.teardownProfileScope();
    }
    if (!options?.skipNavigation) {
      applyPathForTarget(target, options?.replace === true);
    }
    beginMatchSession();
    await bootstrapForRoute(target);
    currentTarget = target;
    logTransition(from, target);
  } catch (error) {
    console.error("session-transition-failed", {
      from: from.path,
      to: target.path,
      error,
    });
    const shouldRecoverToHome =
      error instanceof Error && error.message === INVALID_SNAPSHOT_ROUTE_ERROR;
    try {
      const lifecycleManager = await import("../lifecycle/lifecycleManager");
      lifecycleManager.teardownMatchScope();
      const recoveryTarget = shouldRecoverToHome
        ? createHomeTarget()
        : getCurrentRouteState();
      if (shouldRecoverToHome) {
        applyPathForTarget(recoveryTarget, true);
      }
      beginMatchSession();
      await bootstrapForRoute(recoveryTarget);
      currentTarget = recoveryTarget;
      logTransition(from, recoveryTarget);
    } catch (recoveryError) {
      currentTarget = getCurrentRouteState();
      console.error("session-transition-recovery-failed", {
        from: from.path,
        to: target.path,
        recoveryError,
      });
    }
  } finally {
    isTransitioning = false;
  }
  const queuedRequest = pendingTransitionRequest;
  pendingTransitionRequest = null;
  if (queuedRequest) {
    if (
      queuedRequest.options?.force ||
      !routeStatesMatch(queuedRequest.target, currentTarget)
    ) {
      await runTransition(queuedRequest.target, queuedRequest.options);
    }
    queuedRequest.waiters.forEach((resolve) => resolve());
  }
};

export const transition = async (
  target: RouteState,
  options?: SessionTransitionOptions,
) => {
  await runTransition(target, options);
};

export const transitionToHome = async (options?: TransitionToHomeOptions) => {
  const homeTarget = createHomeTarget();
  const shouldForceMatchScopeReset = options?.forceMatchScopeReset === true;
  const activeTarget = currentTarget;
  if (
    !routeStatesMatch(activeTarget, homeTarget) ||
    shouldForceMatchScopeReset
  ) {
    await transition(homeTarget, {
      resetProfileScope: options?.resetProfileScope,
      force: shouldForceMatchScopeReset,
      replace: options?.replace,
    });
  } else if (options?.resetProfileScope) {
    const lifecycleManager = await import("../lifecycle/lifecycleManager");
    lifecycleManager.teardownProfileScope();
  }
};

export const isTransitionInProgress = (): boolean => {
  return isTransitioning;
};

export const getCurrentTarget = (): RouteState => {
  return currentTarget;
};

export const initializeAppSessionManager = () => {
  if (initialized) {
    return;
  }
  initialized = true;
  initializeNavigation();
  currentTarget = getCurrentRouteState();
  subscribeToNavigationState((routeState, source) => {
    if (source !== "push" && source !== "replace" && source !== "popstate") {
      return;
    }
    if (isApplyingNavigation) {
      return;
    }
    if (!isTransitioning && routeStatesMatch(routeState, currentTarget)) {
      return;
    }
    void transition(routeState, { skipNavigation: true });
  });
  void transition(currentTarget, { skipNavigation: true, force: true });
};

bindSessionTransitionRuntime({
  transition,
  transitionToHome,
  isTransitionInProgress,
});
