import {
  getEventPrizeConfig,
  isEventPrizeRevealOpen,
} from "@mons/shared/event-prizes";
import { isMonsLinkAdmin } from "@mons/shared/events";
import { useEffect, useMemo, useRef, useState } from "react";
import { storage } from "../../utils/storage";
import { EMPTY_EVENT_PRIZES } from "./eventLayout";
import {
  getActivePendingMatches,
  getCurrentUiState,
  getSortedParticipants,
  getWatchableMatch,
  isLocalEventCreator,
} from "./eventState";
import { getEventModalState, subscribeToEventModalState } from "./modalState";
import { useEventModalActions } from "./useEventModalActions";
import { useEventModalLifecycle } from "./useEventModalLifecycle";
import { useEventParticipantCard } from "./useEventParticipantCard";
import { useEventPrizeSelection } from "./useEventPrizeSelection";
import { useEventProfileIds } from "./useEventProfileIds";

export function useEventModalController() {
  const [modalState, setModalState] = useState(() => getEventModalState());
  const participantLookupModalStateRef = useRef(modalState);
  const lifecycle = useEventModalLifecycle({ modalState });
  const { eventRecord, isLoading, isEventFresh, nowMs } = lifecycle;
  const eventPrizeConfig = getEventPrizeConfig(modalState.eventId);
  const eventPrizes = eventPrizeConfig?.prizes ?? EMPTY_EVENT_PRIZES;
  const areEventPrizesConcealed = !isEventPrizeRevealOpen(
    eventRecord?.status,
    eventRecord?.startAtMs,
    nowMs,
  );
  const currentProfileId = storage.getProfileId("");
  const currentLoginUid = storage.getLoginId("");
  const participantsById = useMemo(
    () => eventRecord?.participants ?? {},
    [eventRecord],
  );
  const participants = useMemo(
    () => getSortedParticipants(eventRecord),
    [eventRecord],
  );
  const prizeSelection = useEventPrizeSelection({
    eventId: modalState.eventId,
    isOpen: modalState.isOpen,
    currentProfileId,
    prizeConfig: eventPrizeConfig,
    concealed: areEventPrizesConcealed,
    participants,
  });
  const {
    isUpdating: isUpdatingPrizeSelection,
    isPending: isPrizeSelectionPending,
    toggle: togglePrizeSelection,
  } = prizeSelection;
  const { profileIds: eventProfileIds, pending: isResolvingEventProfileIds } =
    useEventProfileIds(
      eventRecord?.status === "scheduled" ? eventRecord : null,
      currentProfileId,
      currentLoginUid,
      modalState,
    );
  const removableScheduledParticipants = useMemo(() => {
    if (!eventRecord || eventRecord.status !== "scheduled") {
      return [];
    }
    if (nowMs >= eventRecord.startAtMs || !isLocalEventCreator(eventRecord)) {
      return [];
    }
    const creatorProfileId = eventRecord.createdByProfileId?.trim() ?? "";
    const creatorLoginUid = eventRecord.createdByLoginUid?.trim() ?? "";
    return getSortedParticipants(eventRecord).filter((participant) => {
      const profileId = participant.profileId?.trim() ?? "";
      const loginUid = participant.loginUid?.trim() ?? "";
      if (!profileId) {
        return false;
      }
      if (creatorProfileId && profileId === creatorProfileId) {
        return false;
      }
      if (creatorLoginUid && loginUid === creatorLoginUid) {
        return false;
      }
      return true;
    });
  }, [eventRecord, nowMs]);
  const eventUiState = useMemo(
    () =>
      getCurrentUiState(
        eventRecord,
        currentProfileId,
        currentLoginUid,
        eventProfileIds,
      ),
    [currentLoginUid, currentProfileId, eventRecord, eventProfileIds],
  );
  const watchableMatch = useMemo(
    () => getWatchableMatch(eventRecord, currentProfileId, eventUiState),
    [currentProfileId, eventRecord, eventUiState],
  );
  const currentUsername = storage.getUsername("").trim().toLowerCase();
  const canManageDisqualifications = isMonsLinkAdmin(currentUsername);
  const livePendingMatches = useMemo(
    () => getActivePendingMatches(eventRecord),
    [eventRecord],
  );
  const participantCard = useEventParticipantCard(modalState);
  const { invalidate: invalidateParticipantLookups } = participantCard;
  const actions = useEventModalActions({
    modalState,
    eventRecord,
    isEventFresh,
    isLoading,
    nowMs,
    currentProfileId,
    eventProfileIds,
    isResolvingEventProfileIds,
    eventPrizeConfig,
    isPrizeSelectionPending,
    togglePrizeSelection,
    canManageDisqualifications,
    removableScheduledParticipants,
  });
  const { resetParticipationRequests, disposeParticipationRequests } = actions;

  useEffect(() => {
    const unsubscribe = subscribeToEventModalState((nextState) => {
      if (participantLookupModalStateRef.current !== nextState) {
        resetParticipationRequests();
        participantLookupModalStateRef.current = nextState;
        invalidateParticipantLookups();
      }
      setModalState(nextState);
    });
    return () => {
      unsubscribe();
      disposeParticipationRequests();
      invalidateParticipantLookups();
    };
  }, [
    disposeParticipationRequests,
    invalidateParticipantLookups,
    resetParticipationRequests,
  ]);

  return {
    session: { modalState, ...lifecycle },
    identity: {
      currentProfileId,
      currentLoginUid,
      eventProfileIds,
      isResolvingEventProfileIds,
    },
    participants: {
      participants,
      participantsById,
      eventUiState,
      watchableMatch,
      openParticipant: participantCard.open,
    },
    prizes: {
      eventPrizeConfig,
      eventPrizes,
      areEventPrizesConcealed,
      prizeSelection,
      isUpdatingPrizeSelection,
    },
    administration: {
      ...actions.administration,
      canManageDisqualifications,
      livePendingMatches,
      removableScheduledParticipants,
    },
    participation: actions.participation,
    navigation: actions.navigation,
  };
}

export type EventModalController = ReturnType<typeof useEventModalController>;
