import {
  getEventPrizeConfig,
  isEventPrizeRevealOpen,
} from "@mons/shared/event-prizes";
import { isMonsLinkAdmin } from "@mons/shared/events";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EventRecord } from "../../connection/connectionModels";
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

export function useEventModalController(devStubRecord: EventRecord | null) {
  const [modalState, setModalState] = useState(() => getEventModalState());
  const participantLookupModalStateRef = useRef(modalState);
  const lifecycle = useEventModalLifecycle({ modalState, devStubRecord });
  const { eventRecord, isLoading, isEventFresh, nowMs } = lifecycle;
  const displayedEventRecord = devStubRecord ?? eventRecord;
  const eventPrizeConfig = getEventPrizeConfig(modalState.eventId);
  const eventPrizes = eventPrizeConfig?.prizes ?? EMPTY_EVENT_PRIZES;
  const areEventPrizesConcealed = !isEventPrizeRevealOpen(
    displayedEventRecord?.status,
    displayedEventRecord?.startAtMs,
    nowMs,
  );
  const currentProfileId = storage.getProfileId("");
  const currentLoginUid = storage.getLoginId("");
  const participantsById = useMemo(
    () => displayedEventRecord?.participants ?? {},
    [displayedEventRecord],
  );
  const participants = useMemo(
    () => getSortedParticipants(displayedEventRecord),
    [displayedEventRecord],
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
      !devStubRecord && eventRecord?.status === "scheduled"
        ? eventRecord
        : null,
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
        displayedEventRecord,
        currentProfileId,
        currentLoginUid,
        eventProfileIds,
      ),
    [currentLoginUid, currentProfileId, displayedEventRecord, eventProfileIds],
  );
  const watchableMatch = useMemo(
    () =>
      getWatchableMatch(displayedEventRecord, currentProfileId, eventUiState),
    [currentProfileId, displayedEventRecord, eventUiState],
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
    devStubRecord,
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
    session: { modalState, ...lifecycle, displayedEventRecord },
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
