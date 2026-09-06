import { pushRoutePath } from "../../navigation/appNavigation";
import {
  getCurrentRouteState,
  getRoutePathForTarget,
  getRouteWithEventOverlay,
  type RouteState,
} from "../../navigation/routeState";

export type EventModalCloseReason = "dismiss" | "launch_game" | "route_change";

export type EventModalState = {
  isOpen: boolean;
  eventId: string | null;
  lastCloseReason: EventModalCloseReason | null;
  isPendingCreate: boolean;
  pendingCreateError: string | null;
};

export const EVENT_MODAL_Z_INDEX = 100100;
export const EVENT_MODAL_AUTH_Z_INDEX = EVENT_MODAL_Z_INDEX + 1;

type EventModalListener = (state: EventModalState) => void;

let state: EventModalState = {
  isOpen: false,
  eventId: null,
  lastCloseReason: null,
  isPendingCreate: false,
  pendingCreateError: null,
};

const listeners = new Set<EventModalListener>();
let pendingGameLaunchInviteId: string | null = null;

const emit = () => {
  listeners.forEach((listener) => {
    try {
      listener(state);
    } catch {}
  });
};

export const getEventModalState = (): EventModalState => {
  return state;
};

export const subscribeToEventModalState = (
  listener: EventModalListener,
): (() => void) => {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
};

const applyState = (nextState: EventModalState, path?: string): void => {
  const previousState = state;
  state = nextState;
  try {
    if (
      path !== undefined &&
      path !==
        `${window.location.pathname}${window.location.search}${window.location.hash}`
    ) {
      pushRoutePath(path);
    }
  } catch (error) {
    state = previousState;
    throw error;
  }
  if (state !== previousState) {
    emit();
  }
};

const getOverlayPath = (eventId: string | null): string | undefined => {
  const route = getCurrentRouteState();
  if (
    route.eventId === eventId &&
    (eventId !== null || route.mode !== "event")
  ) {
    return undefined;
  }
  return getRoutePathForTarget(
    getRouteWithEventOverlay(route, eventId),
    window.location,
  );
};

const getOpenState = (eventId: string): EventModalState => {
  if (state.isOpen && state.eventId === eventId && !state.isPendingCreate) {
    return state;
  }
  return {
    isOpen: true,
    eventId,
    lastCloseReason: null,
    isPendingCreate: false,
    pendingCreateError: null,
  };
};

const getClosedState = (reason: EventModalCloseReason): EventModalState => {
  if (!state.isOpen) {
    return state;
  }
  return {
    isOpen: false,
    eventId: null,
    lastCloseReason: reason,
    isPendingCreate: false,
    pendingCreateError: null,
  };
};

export const syncEventModalToRoute = (route: RouteState): void => {
  if (route.eventId) {
    if (state.eventId !== route.eventId) {
      pendingGameLaunchInviteId = null;
    }
    applyState(getOpenState(route.eventId));
    return;
  }
  const reason =
    route.mode === "invite" &&
    route.inviteId === pendingGameLaunchInviteId &&
    pendingGameLaunchInviteId !== null
      ? "launch_game"
      : "route_change";
  pendingGameLaunchInviteId = null;
  applyState(getClosedState(reason));
};

export const prepareEventModalGameLaunch = (inviteId: string): void => {
  pendingGameLaunchInviteId = state.isOpen ? inviteId : null;
};

export const openEventModal = (eventId: string): void => {
  const normalizedEventId = typeof eventId === "string" ? eventId.trim() : "";
  if (!normalizedEventId) {
    return;
  }
  pendingGameLaunchInviteId = null;
  applyState(
    getOpenState(normalizedEventId),
    getOverlayPath(normalizedEventId),
  );
};

export const openEventModalPendingCreate = (): void => {
  pendingGameLaunchInviteId = null;
  applyState(getClosedState("dismiss"), getOverlayPath(null));
  applyState({
    isOpen: true,
    eventId: null,
    lastCloseReason: null,
    isPendingCreate: true,
    pendingCreateError: null,
  });
};

export const setEventModalPendingCreateError = (message: string): void => {
  if (!state.isOpen || !state.isPendingCreate) {
    return;
  }
  const normalizedMessage = message.trim();
  state = {
    ...state,
    pendingCreateError: normalizedMessage || "Failed to create event.",
  };
  emit();
};

export const closeEventModal = async (options?: {
  reason?: EventModalCloseReason;
}): Promise<void> => {
  const closeReason: EventModalCloseReason = options?.reason ?? "dismiss";
  pendingGameLaunchInviteId = null;
  applyState(getClosedState(closeReason), getOverlayPath(null));
};

export const hasEventModalVisible = (): boolean => {
  return state.isOpen;
};
