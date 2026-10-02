import type { EventPrizeConfig } from "@mons/shared/event-prizes";
import { EVENT_POSTPONE_OPTIONS_MINUTES } from "@mons/shared/events";
import { useCallback, useEffect, useRef, useState } from "react";
import { connection } from "../../connection/connection";
import type {
  EventParticipant,
  EventPrizeId,
  EventRecord,
} from "../../connection/connectionModels";
import {
  getCurrentRouteState,
  getCurrentViewUrl,
} from "../../navigation/routeState";
import { storage } from "../../utils/storage";
import { openProfileSignInPopupForEvent } from "../identity/profileUiPort";
import { getParticipantDisplayName } from "./eventPresentation";
import {
  PENDING_JOIN_POLL_INTERVAL_MS,
  PENDING_JOIN_POLL_TIMEOUT_MS,
  canLeaveEvent,
  getActivePendingMatches,
  getMatchSideLabel,
  canSelectEventPrize as isEventPrizeSelectionAvailable,
  isLocalEventCreator,
  type EventProfileIds,
} from "./eventState";
import {
  closeEventModal,
  getEventModalState,
  prepareEventModalGameLaunch,
  type EventModalState,
} from "./modalState";
import type { EventPrizeSelection } from "./useEventPrizeSelection";

export type EventModalActionsOptions = {
  modalState: EventModalState;
  eventRecord: EventRecord | null;
  isEventFresh: boolean;
  isLoading: boolean;
  nowMs: number;
  currentProfileId: string;
  eventProfileIds: EventProfileIds;
  isResolvingEventProfileIds: boolean;
  eventPrizeConfig: EventPrizeConfig | null;
  isPrizeSelectionPending: EventPrizeSelection["isPending"];
  togglePrizeSelection: EventPrizeSelection["toggle"];
  canManageDisqualifications: boolean;
  removableScheduledParticipants: EventParticipant[];
};

export function useEventModalActions({
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
}: EventModalActionsOptions) {
  const [isJoining, setIsJoining] = useState(false);
  const activeJoinRequestRef = useRef<object | null>(null);
  const [isLeaving, setIsLeaving] = useState(false);
  const activeLeaveRequestRef = useRef<object | null>(null);
  const [isDisqualifying, setIsDisqualifying] = useState(false);
  const [isPostponing, setIsPostponing] = useState(false);
  const [isRemovingParticipant, setIsRemovingParticipant] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [pendingJoinEventId, setPendingJoinEventId] = useState<string | null>(
    null,
  );
  const [pendingJoinRequestedAtMs, setPendingJoinRequestedAtMs] = useState(0);
  const copyResetTimeoutRef = useRef<number | null>(null);
  const disposeParticipationRequests = useCallback(() => {
    activeJoinRequestRef.current = null;
    activeLeaveRequestRef.current = null;
  }, []);
  const resetParticipationRequests = useCallback(() => {
    activeJoinRequestRef.current = null;
    setIsJoining(false);
    activeLeaveRequestRef.current = null;
    setIsLeaving(false);
  }, []);

  useEffect(() => {
    setIsPostponing(false);
    setIsRemovingParticipant(false);
  }, [modalState.eventId, modalState.isOpen]);

  useEffect(() => {
    if (modalState.isOpen && modalState.eventId) return;
    if (copyResetTimeoutRef.current !== null) {
      window.clearTimeout(copyResetTimeoutRef.current);
      copyResetTimeoutRef.current = null;
    }
    setCopyState("idle");
    setIsDisqualifying(false);
    setIsPostponing(false);
    setIsRemovingParticipant(false);
    setPendingJoinEventId(null);
    setPendingJoinRequestedAtMs(0);
  }, [modalState.eventId, modalState.isOpen]);

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current);
        copyResetTimeoutRef.current = null;
      }
    };
  }, []);

  const submitJoin = useCallback((eventId: string) => {
    if (activeJoinRequestRef.current) return;
    const request = {};
    activeJoinRequestRef.current = request;
    setIsJoining(true);
    void connection
      .joinEvent(eventId)
      .catch(() => {})
      .finally(() => {
        if (activeJoinRequestRef.current === request) {
          activeJoinRequestRef.current = null;
          setIsJoining(false);
        }
      });
  }, []);

  useEffect(() => {
    if (
      !modalState.isOpen ||
      !modalState.eventId ||
      eventRecord?.eventId !== modalState.eventId ||
      pendingJoinEventId !== modalState.eventId
    ) {
      return;
    }
    const requestedAtMs =
      pendingJoinRequestedAtMs > 0 ? pendingJoinRequestedAtMs : Date.now();
    const intervalId = window.setInterval(() => {
      if (Date.now() - requestedAtMs >= PENDING_JOIN_POLL_TIMEOUT_MS) {
        setPendingJoinEventId(null);
        setPendingJoinRequestedAtMs(0);
        return;
      }
      if (
        getEventModalState() !== modalState ||
        storage.getProfileId("") === "" ||
        activeLeaveRequestRef.current ||
        isPrizeSelectionPending()
      ) {
        return;
      }
      const eventId = pendingJoinEventId;
      setPendingJoinEventId(null);
      setPendingJoinRequestedAtMs(0);
      if (!eventId) {
        return;
      }
      submitJoin(eventId);
    }, PENDING_JOIN_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    eventRecord?.eventId,
    modalState,
    pendingJoinEventId,
    pendingJoinRequestedAtMs,
    isPrizeSelectionPending,
    submitJoin,
  ]);

  const handlePrizeSelectionClick = useCallback(
    (prizeId: EventPrizeId) => {
      if (
        !eventPrizeConfig ||
        !isEventFresh ||
        isLoading ||
        activeJoinRequestRef.current ||
        activeLeaveRequestRef.current ||
        !isEventPrizeSelectionAvailable(
          eventRecord,
          currentProfileId,
          Date.now(),
        )
      ) {
        return;
      }
      togglePrizeSelection(prizeId);
    },
    [
      currentProfileId,
      eventRecord,
      eventPrizeConfig,
      isEventFresh,
      isLoading,
      togglePrizeSelection,
    ],
  );

  const copyEventLinkToClipboard = useCallback(
    (link?: string) => {
      if (!modalState.eventId || typeof window === "undefined") {
        return;
      }
      connection.writeEventLinkToClipboard(modalState.eventId, link);
      setCopyState("copied");
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }
      copyResetTimeoutRef.current = window.setTimeout(() => {
        copyResetTimeoutRef.current = null;
        setCopyState("idle");
      }, 1200);
    },
    [modalState.eventId],
  );

  const handleCopyClick = useCallback(() => {
    copyEventLinkToClipboard();
  }, [copyEventLinkToClipboard]);

  const handleShareClick = useCallback(async () => {
    if (!modalState.eventId || typeof window === "undefined") {
      return;
    }
    const link = getCurrentViewUrl();
    const shareData = {
      url: link,
      title: "Play Mons",
    };
    if (typeof navigator.share !== "function") {
      copyEventLinkToClipboard(link);
      return;
    }
    if (typeof navigator.canShare === "function") {
      let canShareData = false;
      try {
        canShareData = navigator.canShare(shareData);
      } catch {
        canShareData = false;
      }
      if (!canShareData) {
        copyEventLinkToClipboard(link);
        return;
      }
    }
    try {
      await navigator.share(shareData);
    } catch (error) {
      const errorName =
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        typeof (error as { name?: unknown }).name === "string"
          ? (error as { name: string }).name
          : "";
      if (errorName === "AbortError") {
        return;
      }
      copyEventLinkToClipboard(link);
    }
  }, [copyEventLinkToClipboard, modalState.eventId]);

  const handleJoinClick = useCallback(() => {
    if (
      !modalState.eventId ||
      !modalState.isOpen ||
      getEventModalState() !== modalState ||
      eventRecord?.eventId !== modalState.eventId ||
      activeJoinRequestRef.current ||
      activeLeaveRequestRef.current ||
      isPrizeSelectionPending()
    ) {
      return;
    }
    if (storage.getProfileId("") === "") {
      setPendingJoinEventId(modalState.eventId);
      setPendingJoinRequestedAtMs(Date.now());
      openProfileSignInPopupForEvent();
      return;
    }
    setPendingJoinEventId(null);
    setPendingJoinRequestedAtMs(0);
    submitJoin(modalState.eventId);
  }, [eventRecord?.eventId, isPrizeSelectionPending, modalState, submitJoin]);

  const handleLeaveClick = useCallback(async () => {
    const profileId = storage.getProfileId("");
    const loginUid = storage.getLoginId("");
    if (
      !modalState.eventId ||
      !modalState.isOpen ||
      getEventModalState() !== modalState ||
      eventRecord?.eventId !== modalState.eventId ||
      !isEventFresh ||
      isResolvingEventProfileIds ||
      isLoading ||
      activeJoinRequestRef.current ||
      activeLeaveRequestRef.current ||
      isPrizeSelectionPending() ||
      !canLeaveEvent(
        eventRecord,
        profileId,
        Date.now(),
        loginUid,
        eventProfileIds,
      )
    ) {
      return;
    }
    const request = {};
    activeLeaveRequestRef.current = request;
    setIsLeaving(true);
    try {
      await connection.leaveEvent(modalState.eventId);
    } catch (error) {
      if (
        activeLeaveRequestRef.current !== request ||
        getEventModalState() !== modalState ||
        storage.getProfileId("") !== profileId ||
        storage.getLoginId("") !== loginUid ||
        (error instanceof Error && error.message === "authentication-changed")
      ) {
        return;
      }
      const message = error instanceof Error ? error.message.trim() : "";
      window.alert(message || "Failed to leave event. Please try again.");
    } finally {
      if (activeLeaveRequestRef.current === request) {
        activeLeaveRequestRef.current = null;
        if (getEventModalState() === modalState) {
          setIsLeaving(false);
        }
      }
    }
  }, [
    eventRecord,
    eventProfileIds,
    isEventFresh,
    isLoading,
    isPrizeSelectionPending,
    isResolvingEventProfileIds,
    modalState,
  ]);

  const openMatch = useCallback(async (inviteId: string) => {
    if (!inviteId) {
      return;
    }
    const currentRoute = getCurrentRouteState();
    if (currentRoute.mode === "invite" && currentRoute.inviteId === inviteId) {
      await closeEventModal({ reason: "launch_game" });
      return;
    }
    prepareEventModalGameLaunch(inviteId);
    connection.connectToInvite(inviteId);
  }, []);

  const handleDisqualifyClick = useCallback(() => {
    if (
      !canManageDisqualifications ||
      !modalState.eventId ||
      !eventRecord ||
      eventRecord.status !== "active" ||
      isDisqualifying
    ) {
      return;
    }

    const activeMatches = getActivePendingMatches(eventRecord);
    if (activeMatches.length <= 0) {
      return;
    }

    const selectionLines = activeMatches.map(({ label, match }, index) => {
      const hostLabel = getMatchSideLabel(match, "host");
      const guestLabel = getMatchSideLabel(match, "guest");
      return `${index + 1}. ${label}: ${hostLabel} vs ${guestLabel}`;
    });
    const rawSelection = window.prompt(
      `Select active game to disqualify:\n${selectionLines.join("\n")}`,
      "1",
    );
    if (!rawSelection) {
      return;
    }
    const selectedIndex = Math.floor(Number(rawSelection)) - 1;
    const selected = activeMatches[selectedIndex];
    if (!selected) {
      return;
    }

    const hostLabel = getMatchSideLabel(selected.match, "host");
    const guestLabel = getMatchSideLabel(selected.match, "guest");
    const didConfirm = window.confirm(
      `disqualify ${hostLabel} and ${guestLabel}?`,
    );
    if (!didConfirm) {
      return;
    }

    setIsDisqualifying(true);
    void connection
      .disqualifyEventMatchWinners(modalState.eventId, selected.match.matchKey)
      .catch((error) => {
        const rawMessage =
          typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof (error as { message?: unknown }).message === "string"
            ? (error as { message: string }).message.trim()
            : "";
        window.alert(
          rawMessage ||
            "Failed to disqualify selected match. Please try again.",
        );
      })
      .finally(() => {
        setIsDisqualifying(false);
      });
  }, [
    canManageDisqualifications,
    eventRecord,
    isDisqualifying,
    modalState.eventId,
  ]);

  const handlePostponeClick = useCallback(() => {
    if (
      !modalState.eventId ||
      !eventRecord ||
      eventRecord.status !== "scheduled" ||
      nowMs >= eventRecord.startAtMs ||
      !isLocalEventCreator(eventRecord) ||
      isPostponing
    ) {
      return;
    }
    const rawSelection = window.prompt(
      `Postpone by how many minutes?\n${EVENT_POSTPONE_OPTIONS_MINUTES.join(" / ")}`,
      "5",
    );
    if (!rawSelection) {
      return;
    }
    const selectedMinutes = Math.floor(Number(rawSelection.trim()));
    if (
      !EVENT_POSTPONE_OPTIONS_MINUTES.includes(selectedMinutes as 5 | 10 | 15)
    ) {
      window.alert("Please enter 5, 10, or 15.");
      return;
    }
    const didConfirm = window.confirm(
      `postpone event by ${selectedMinutes} minutes?`,
    );
    if (!didConfirm) {
      return;
    }
    setIsPostponing(true);
    void connection
      .postponeEventStart(modalState.eventId, selectedMinutes)
      .catch((error) => {
        const rawMessage =
          typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof (error as { message?: unknown }).message === "string"
            ? (error as { message: string }).message.trim()
            : "";
        window.alert(
          rawMessage || "Failed to postpone event start. Please try again.",
        );
      })
      .finally(() => {
        setIsPostponing(false);
      });
  }, [eventRecord, isPostponing, modalState.eventId, nowMs]);

  const handleRemoveParticipantClick = useCallback(() => {
    if (
      !modalState.eventId ||
      !eventRecord ||
      eventRecord.status !== "scheduled" ||
      nowMs >= eventRecord.startAtMs ||
      !isLocalEventCreator(eventRecord) ||
      isRemovingParticipant ||
      removableScheduledParticipants.length <= 0
    ) {
      return;
    }
    const selectionLines = removableScheduledParticipants.map(
      (participant, index) =>
        `${index + 1}. ${getParticipantDisplayName(participant)}`,
    );
    const rawSelection = window.prompt(
      `Select participant to remove:\n${selectionLines.join("\n")}`,
      "1",
    );
    if (!rawSelection) {
      return;
    }
    const selectedIndex = Math.floor(Number(rawSelection)) - 1;
    const selectedParticipant = removableScheduledParticipants[selectedIndex];
    if (!selectedParticipant || !selectedParticipant.profileId) {
      return;
    }
    const didConfirm = window.confirm(
      `remove ${getParticipantDisplayName(selectedParticipant)} from this event?`,
    );
    if (!didConfirm) {
      return;
    }

    setIsRemovingParticipant(true);
    void connection
      .removeEventParticipant(modalState.eventId, selectedParticipant.profileId)
      .catch((error) => {
        const rawMessage =
          typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof (error as { message?: unknown }).message === "string"
            ? (error as { message: string }).message.trim()
            : "";
        window.alert(
          rawMessage ||
            "Failed to remove selected participant. Please try again.",
        );
      })
      .finally(() => {
        setIsRemovingParticipant(false);
      });
  }, [
    eventRecord,
    isRemovingParticipant,
    modalState.eventId,
    nowMs,
    removableScheduledParticipants,
  ]);

  return {
    participation: {
      isJoining,
      isLeaving,
      join: handleJoinClick,
      leave: handleLeaveClick,
      selectPrize: handlePrizeSelectionClick,
    },
    administration: {
      isDisqualifying,
      isPostponing,
      isRemovingParticipant,
      disqualify: handleDisqualifyClick,
      postpone: handlePostponeClick,
      removeParticipant: handleRemoveParticipantClick,
    },
    navigation: {
      copyState,
      copy: handleCopyClick,
      share: handleShareClick,
      openMatch,
    },
    resetParticipationRequests,
    disposeParticipationRequests,
  };
}
