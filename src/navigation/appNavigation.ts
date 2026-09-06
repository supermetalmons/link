import { type RouteState, getCurrentRouteState } from "./routeState";

type RouteEventSource = "init" | "push" | "replace" | "popstate";
type RouteListener = (state: RouteState, source: RouteEventSource) => void;

const listeners = new Set<RouteListener>();
let hasPopstateListener = false;
let isHandlingPopstate = false;

const notifyListeners = (source: RouteEventSource) => {
  const routeState = getCurrentRouteState();
  listeners.forEach((listener) => {
    listener(routeState, source);
  });
};

const ensurePopstateListener = () => {
  if (hasPopstateListener) {
    return;
  }
  hasPopstateListener = true;
  window.addEventListener("popstate", () => {
    if (isHandlingPopstate) {
      return;
    }
    isHandlingPopstate = true;
    try {
      notifyListeners("popstate");
    } finally {
      isHandlingPopstate = false;
    }
  });
};

export const subscribeToNavigationState = (listener: RouteListener) => {
  ensurePopstateListener();
  listeners.add(listener);
  listener(getCurrentRouteState(), "init");
  return () => {
    listeners.delete(listener);
  };
};

export const pushRoutePath = (path: string) => {
  window.history.pushState({ path }, "", path);
  notifyListeners("push");
};

export const replaceRoutePath = (path: string) => {
  window.history.replaceState({ path }, "", path);
  notifyListeners("replace");
};

export const initializeNavigation = () => {
  ensurePopstateListener();
};
