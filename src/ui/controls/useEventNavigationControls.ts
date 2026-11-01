import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connection } from "../../connection/connection";
import type {
  EventNavigationPreviewParticipant,
  EventRecord,
} from "../../connection/connectionModels";
import { subscribeToNavigationState } from "../../navigation/appNavigation";
import {
  getCurrentRouteState,
  type RouteState,
} from "../../navigation/routeState";
import { isTransitionInProgress } from "../../session/AppSessionManager";
import {
  getEventModalState,
  openEventModal,
  subscribeToEventModalState,
} from "../event/modalState";

const EVENT_MODAL_NAV_AUTOCLOSE_SUPPRESS_MS = 10000;
export const EVENT_CLOUD_MAX_AVATARS = 4;

type EventNavigationControlsOptions = {
  profileId: string;
  routeState: RouteState;
  isOnlineGame: boolean;
  getEventParticipantPreview: (
    eventId: string,
  ) => EventNavigationPreviewParticipant[];
};

const mapEventRecordToNavigationPreview = (
  eventRecord: EventRecord | null,
): EventNavigationPreviewParticipant[] => {
  if (!eventRecord) {
    return [];
  }
  return Object.values(eventRecord.participants)
    .sort((left, right) => left.joinedAtMs - right.joinedAtMs)
    .map((participant) => {
      const displayName = participant.displayName?.trim();
      const username = participant.username?.trim();
      const emojiId = participant.emojiId;
      return {
        profileId: participant.profileId?.trim() || null,
        displayName: displayName || username || null,
        emojiId,
        aura: participant.aura,
      };
    });
};

export function useEventNavigationControls({
  profileId,
  routeState,
  isOnlineGame,
  getEventParticipantPreview,
}: EventNavigationControlsOptions) {
  const [liveEventCloudAvatars, setLiveEventCloudAvatars] = useState<
    EventNavigationPreviewParticipant[]
  >([]);
  const initialEventModalState = getEventModalState();
  const pendingNavigationOpenedEventModalRequestedAtMsRef = useRef(0);
  const pendingNavigationOpenedEventModalRequestSeqRef = useRef(0);
  const wasEventModalVisibleRef = useRef(
    initialEventModalState.isOpen && !!initialEventModalState.eventId,
  );
  const activeEventModalEventIdRef = useRef<string | null>(
    initialEventModalState.isOpen ? initialEventModalState.eventId : null,
  );
  const [selectedEventModalId, setSelectedEventModalId] = useState<
    string | null
  >(initialEventModalState.isOpen ? initialEventModalState.eventId : null);
  const [retainedEventGame, setRetainedEventGame] = useState<{
    eventId: string;
    inviteId: string;
  } | null>(null);

  const eventCloudSubscriptionEventIdRef = useRef<string | null>(null);

  const isEventModalVisible = useCallback(() => {
    const modalState = getEventModalState();
    return modalState.isOpen && !!modalState.eventId;
  }, []);

  const shouldSuppressNavigationPopupProgrammaticAutoCloseForEventModal =
    useCallback(() => {
      if (isEventModalVisible()) {
        return true;
      }
      const requestedAtMs =
        pendingNavigationOpenedEventModalRequestedAtMsRef.current;
      if (requestedAtMs <= 0) {
        return false;
      }
      if (Date.now() - requestedAtMs > EVENT_MODAL_NAV_AUTOCLOSE_SUPPRESS_MS) {
        return false;
      }
      return (
        isTransitionInProgress() || getCurrentRouteState().mode === "event"
      );
    }, [isEventModalVisible]);

  useEffect(() => {
    return subscribeToEventModalState((state) => {
      const isVisible = state.isOpen && !!state.eventId;
      const wasVisible = wasEventModalVisibleRef.current;
      if (isVisible && state.eventId) {
        activeEventModalEventIdRef.current = state.eventId;
      }

      if (wasVisible && !isVisible) {
        pendingNavigationOpenedEventModalRequestSeqRef.current += 1;
        const closingEventId = activeEventModalEventIdRef.current;
        activeEventModalEventIdRef.current = null;
        if (
          state.lastCloseReason === "dismiss" &&
          getCurrentRouteState().mode === "event"
        ) {
          pendingNavigationOpenedEventModalRequestedAtMsRef.current =
            Date.now();
        } else {
          pendingNavigationOpenedEventModalRequestedAtMsRef.current = 0;
        }
        if (state.lastCloseReason === "launch_game" && closingEventId) {
          const route = getCurrentRouteState();
          setRetainedEventGame(
            route.mode === "invite" && route.inviteId
              ? { eventId: closingEventId, inviteId: route.inviteId }
              : null,
          );
        }
      } else if (isVisible) {
        pendingNavigationOpenedEventModalRequestedAtMsRef.current = 0;
      } else {
        activeEventModalEventIdRef.current = null;
      }

      wasEventModalVisibleRef.current = isVisible;
      setSelectedEventModalId(isVisible ? state.eventId : null);
    });
  }, []);

  useEffect(() => {
    return subscribeToNavigationState((route) => {
      setRetainedEventGame((current) =>
        route.mode === "invite" && current?.inviteId === route.inviteId
          ? current
          : null,
      );
    });
  }, []);

  useEffect(() => {
    eventCloudSubscriptionEventIdRef.current = null;
    setLiveEventCloudAvatars([]);
  }, [profileId]);

  const openEventFromNavigation = useCallback((eventId: string) => {
    const requestSeq =
      pendingNavigationOpenedEventModalRequestSeqRef.current + 1;
    pendingNavigationOpenedEventModalRequestSeqRef.current = requestSeq;
    pendingNavigationOpenedEventModalRequestedAtMsRef.current = Date.now();
    openEventModal(eventId);
    if (pendingNavigationOpenedEventModalRequestSeqRef.current === requestSeq) {
      pendingNavigationOpenedEventModalRequestedAtMsRef.current = 0;
      pendingNavigationOpenedEventModalRequestSeqRef.current += 1;
    }
  }, []);

  const clearPendingEventNavigation = useCallback(() => {
    pendingNavigationOpenedEventModalRequestedAtMsRef.current = 0;
    pendingNavigationOpenedEventModalRequestSeqRef.current += 1;
  }, []);

  const selectedNavigationItemId = selectedEventModalId
    ? `event_${selectedEventModalId}`
    : routeState.mode === "event" && routeState.eventId
      ? `event_${routeState.eventId}`
      : routeState.mode === "invite"
        ? routeState.inviteId
        : null;
  const routeInviteId =
    routeState.mode === "invite" ? routeState.inviteId : null;
  const hasCurrentInviteContext =
    !!routeInviteId &&
    connection.getActiveContextSnapshot()?.inviteId === routeInviteId;
  const currentInviteEventId =
    hasCurrentInviteContext && connection.isCurrentInviteEventOwned()
      ? connection.getCurrentInviteEventId()
      : null;
  const shouldRetainEventGameButton =
    !!retainedEventGame &&
    retainedEventGame.inviteId === routeInviteId &&
    (!hasCurrentInviteContext ||
      currentInviteEventId === retainedEventGame.eventId);
  const effectiveInviteEventId =
    currentInviteEventId ??
    (shouldRetainEventGameButton ? retainedEventGame.eventId : null);
  const isEventGameButtonVisible =
    (isOnlineGame && !!currentInviteEventId) || shouldRetainEventGameButton;

  useEffect(() => {
    if (retainedEventGame && !shouldRetainEventGameButton) {
      setRetainedEventGame((current) =>
        current === retainedEventGame ? null : current,
      );
    }
  }, [retainedEventGame, shouldRetainEventGameButton]);

  useEffect(() => {
    if (!effectiveInviteEventId) {
      eventCloudSubscriptionEventIdRef.current = null;
      setLiveEventCloudAvatars([]);
      return;
    }
    if (eventCloudSubscriptionEventIdRef.current === effectiveInviteEventId) {
      return;
    }
    eventCloudSubscriptionEventIdRef.current = effectiveInviteEventId;
    setLiveEventCloudAvatars(
      getEventParticipantPreview(effectiveInviteEventId).slice(
        0,
        EVENT_CLOUD_MAX_AVATARS,
      ),
    );
  }, [effectiveInviteEventId, getEventParticipantPreview]);

  useEffect(() => {
    if (!effectiveInviteEventId || !isEventGameButtonVisible) {
      return;
    }
    let disposed = false;

    const unsubscribe = connection.subscribeToEvent(
      effectiveInviteEventId,
      (eventRecord) => {
        if (disposed) {
          return;
        }
        const nextAvatars = mapEventRecordToNavigationPreview(
          eventRecord,
        ).slice(0, EVENT_CLOUD_MAX_AVATARS);
        setLiveEventCloudAvatars((previousAvatars) => {
          if (previousAvatars.length >= EVENT_CLOUD_MAX_AVATARS) {
            return previousAvatars;
          }
          if (previousAvatars.length === 0) {
            return nextAvatars.length > 0 ? nextAvatars : previousAvatars;
          }
          if (nextAvatars.length > previousAvatars.length) {
            return nextAvatars;
          }
          return previousAvatars;
        });
      },
    );

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [effectiveInviteEventId, isEventGameButtonVisible]);

  const eventCloudAvatars = useMemo(() => {
    if (!effectiveInviteEventId) {
      return [];
    }
    const liveFallback = liveEventCloudAvatars.slice(
      0,
      EVENT_CLOUD_MAX_AVATARS,
    );
    if (liveFallback.length > 0) {
      return liveFallback;
    }
    return getEventParticipantPreview(effectiveInviteEventId).slice(
      0,
      EVENT_CLOUD_MAX_AVATARS,
    );
  }, [
    effectiveInviteEventId,
    getEventParticipantPreview,
    liveEventCloudAvatars,
  ]);

  return {
    selectedNavigationItemId,
    effectiveInviteEventId,
    isEventGameButtonVisible,
    eventCloudAvatars,
    isEventModalVisible,
    shouldSuppressNavigationPopupProgrammaticAutoCloseForEventModal,
    openEventFromNavigation,
    clearPendingEventNavigation,
  };
}
