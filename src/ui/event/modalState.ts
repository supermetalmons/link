import { transitionToHome } from "../../session/sessionTransitionPort";

export type EventModalCloseReason = "dismiss" | "launch_game" | "route_change";

export type EventModalState = {
  isOpen: boolean;
  eventId: string | null;
  restoreHomeOnClose: boolean;
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
  restoreHomeOnClose: false,
  lastCloseReason: null,
  isPendingCreate: false,
  pendingCreateError: null,
};

const listeners = new Set<EventModalListener>();

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

export const openEventModal = (
  eventId: string,
  options?: { restoreHomeOnClose?: boolean },
): void => {
  const normalizedEventId = typeof eventId === "string" ? eventId.trim() : "";
  if (!normalizedEventId) {
    return;
  }
  state = {
    isOpen: true,
    eventId: normalizedEventId,
    restoreHomeOnClose: options?.restoreHomeOnClose === true,
    lastCloseReason: null,
    isPendingCreate: false,
    pendingCreateError: null,
  };
  emit();
};

export const openEventModalPendingCreate = (options?: {
  restoreHomeOnClose?: boolean;
}): void => {
  state = {
    isOpen: true,
    eventId: null,
    restoreHomeOnClose: options?.restoreHomeOnClose === true,
    lastCloseReason: null,
    isPendingCreate: true,
    pendingCreateError: null,
  };
  emit();
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
  skipHomeTransition?: boolean;
  reason?: EventModalCloseReason;
}): Promise<void> => {
  const closeReason: EventModalCloseReason = options?.reason ?? "dismiss";
  const shouldRestoreHome =
    state.isOpen &&
    state.restoreHomeOnClose &&
    options?.skipHomeTransition !== true;
  state = {
    isOpen: false,
    eventId: null,
    restoreHomeOnClose: false,
    lastCloseReason: closeReason,
    isPendingCreate: false,
    pendingCreateError: null,
  };
  emit();
  if (!shouldRestoreHome) {
    return;
  }
  await Promise.resolve();
  await transitionToHome();
};

export const hasEventModalVisible = (): boolean => {
  return state.isOpen;
};
