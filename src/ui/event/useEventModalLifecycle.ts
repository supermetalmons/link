import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { connection } from "../../connection/connection";
import type { EventRecord } from "../../connection/connectionModels";
import {
  EVENT_AUTO_RECOVERY_DELAY_MS,
  EVENT_AUTO_RECOVERY_MAX_ATTEMPTS_PER_REASON,
  EVENT_AUTO_RECOVERY_MIN_GAP_MS,
  getEventAutoRecoveryReason,
  getEventNowRefreshDelayMs,
  isLocalEventCreator,
  isLocalEventParticipant,
} from "./eventState";
import type { EventModalState } from "./modalState";

export type EventModalLifecycleOptions = {
  modalState: EventModalState;
};

export function useEventModalLifecycle({
  modalState,
}: EventModalLifecycleOptions) {
  const [eventRecord, setEventRecord] = useState<EventRecord | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isEventFresh, setIsEventFresh] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const loadTimingRef = useRef<{
    eventId: string;
    startedAt: number;
    displayed: boolean;
    fresh: boolean;
  } | null>(null);
  const eventAutoRecoveryTimeoutRef = useRef<number | null>(null);
  const eventAutoRecoveryAttemptsRef = useRef<Record<string, number>>({});
  const eventAutoRecoveryLastAttemptAtMsRef = useRef<Record<string, number>>(
    {},
  );
  const eventAutoRecoveryInFlightRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const eventAutoRecoveryInFlightSet = eventAutoRecoveryInFlightRef.current;
    return () => {
      if (eventAutoRecoveryTimeoutRef.current !== null) {
        window.clearTimeout(eventAutoRecoveryTimeoutRef.current);
        eventAutoRecoveryTimeoutRef.current = null;
      }
      eventAutoRecoveryInFlightSet.clear();
    };
  }, []);

  useEffect(() => {
    if (eventAutoRecoveryTimeoutRef.current !== null) {
      window.clearTimeout(eventAutoRecoveryTimeoutRef.current);
      eventAutoRecoveryTimeoutRef.current = null;
    }
    eventAutoRecoveryAttemptsRef.current = {};
    eventAutoRecoveryLastAttemptAtMsRef.current = {};
    eventAutoRecoveryInFlightRef.current.clear();
  }, [modalState.eventId, modalState.isOpen]);

  useEffect(() => {
    const eventId = modalState.eventId;
    if (!modalState.isOpen || !eventId) {
      loadTimingRef.current = null;
      setEventRecord(null);
      setIsEventFresh(false);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    loadTimingRef.current = {
      eventId,
      startedAt: performance.now(),
      displayed: false,
      fresh: false,
    };
    for (const name of [
      "event:open",
      "event:first-content",
      "event:first-fresh-content",
    ]) {
      performance.clearMarks(name);
      performance.clearMeasures(name);
    }
    performance.mark("event:open");
    const unsubscribeFreshness = connection.subscribeToEventFreshness(
      eventId,
      setIsEventFresh,
    );
    const unsubscribeEvent = connection.subscribeToEvent(
      eventId,
      (nextEvent) => {
        setEventRecord(nextEvent);
        setIsLoading(false);
      },
      () => setIsLoading(false),
    );
    return () => {
      unsubscribeEvent();
      unsubscribeFreshness();
    };
  }, [modalState.eventId, modalState.isOpen]);

  useLayoutEffect(() => {
    const timing = loadTimingRef.current;
    if (
      !modalState.isOpen ||
      !timing ||
      eventRecord?.eventId !== timing.eventId
    )
      return;
    const mark = (name: string) => {
      performance.mark(name);
      performance.measure(name, {
        start: timing.startedAt,
        end: performance.now(),
      });
    };
    if (!timing.displayed) {
      timing.displayed = true;
      mark("event:first-content");
    }
    if (isEventFresh && !timing.fresh) {
      timing.fresh = true;
      mark("event:first-fresh-content");
    }
  }, [eventRecord, isEventFresh, modalState.isOpen]);

  useEffect(() => {
    if (!modalState.isOpen || typeof window === "undefined") {
      return;
    }

    let isDisposed = false;
    let timeoutId: number | null = null;

    const scheduleNextTick = () => {
      if (isDisposed) {
        return;
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      const currentNowMs = Date.now();
      setNowMs(currentNowMs);
      timeoutId = window.setTimeout(
        scheduleNextTick,
        getEventNowRefreshDelayMs(
          eventRecord?.status ?? null,
          eventRecord?.startAtMs ?? null,
          currentNowMs,
        ),
      );
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        scheduleNextTick();
      }
    };

    scheduleNextTick();
    window.addEventListener("focus", scheduleNextTick);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      isDisposed = true;
      window.removeEventListener("focus", scheduleNextTick);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    eventRecord?.eventId,
    eventRecord?.startAtMs,
    eventRecord?.status,
    modalState.eventId,
    modalState.isOpen,
  ]);

  useEffect(() => {
    if (!modalState.isOpen || typeof window === "undefined") {
      return;
    }
    if (!modalState.eventId || !eventRecord) {
      if (eventAutoRecoveryTimeoutRef.current !== null) {
        window.clearTimeout(eventAutoRecoveryTimeoutRef.current);
        eventAutoRecoveryTimeoutRef.current = null;
      }
      return;
    }
    if (eventRecord.eventId !== modalState.eventId) {
      return;
    }
    const autoRecoveryReason = getEventAutoRecoveryReason(
      eventRecord,
      nowMs,
      isEventFresh,
    );
    if (!autoRecoveryReason) {
      if (eventAutoRecoveryTimeoutRef.current !== null) {
        window.clearTimeout(eventAutoRecoveryTimeoutRef.current);
        eventAutoRecoveryTimeoutRef.current = null;
      }
      return;
    }
    const canAttemptRecovery =
      autoRecoveryReason === "ended-missing-prize-assignments"
        ? isLocalEventParticipant(eventRecord)
        : isLocalEventCreator(eventRecord);
    if (!canAttemptRecovery) {
      return;
    }

    const attemptKey = `${eventRecord.eventId}:${autoRecoveryReason}`;
    const attempts = eventAutoRecoveryAttemptsRef.current[attemptKey] ?? 0;
    if (attempts >= EVENT_AUTO_RECOVERY_MAX_ATTEMPTS_PER_REASON) {
      return;
    }
    if (eventAutoRecoveryInFlightRef.current.has(attemptKey)) {
      return;
    }
    const lastAttemptAtMs =
      eventAutoRecoveryLastAttemptAtMsRef.current[attemptKey] ?? 0;
    if (Date.now() - lastAttemptAtMs < EVENT_AUTO_RECOVERY_MIN_GAP_MS) {
      return;
    }

    if (eventAutoRecoveryTimeoutRef.current !== null) {
      window.clearTimeout(eventAutoRecoveryTimeoutRef.current);
    }

    const targetEventId = eventRecord.eventId;
    eventAutoRecoveryTimeoutRef.current = window.setTimeout(() => {
      eventAutoRecoveryTimeoutRef.current = null;

      const inFlightSet = eventAutoRecoveryInFlightRef.current;
      if (inFlightSet.has(attemptKey)) {
        return;
      }

      const currentAttempts =
        eventAutoRecoveryAttemptsRef.current[attemptKey] ?? 0;
      if (currentAttempts >= EVENT_AUTO_RECOVERY_MAX_ATTEMPTS_PER_REASON) {
        return;
      }

      eventAutoRecoveryAttemptsRef.current[attemptKey] = currentAttempts + 1;
      eventAutoRecoveryLastAttemptAtMsRef.current[attemptKey] = Date.now();
      inFlightSet.add(attemptKey);

      void connection
        .syncEventState(targetEventId)
        .catch(() => {})
        .finally(() => {
          inFlightSet.delete(attemptKey);
        });
    }, EVENT_AUTO_RECOVERY_DELAY_MS);

    return () => {
      if (eventAutoRecoveryTimeoutRef.current !== null) {
        window.clearTimeout(eventAutoRecoveryTimeoutRef.current);
        eventAutoRecoveryTimeoutRef.current = null;
      }
    };
  }, [eventRecord, isEventFresh, modalState.eventId, modalState.isOpen, nowMs]);

  return { eventRecord, isLoading, isEventFresh, nowMs };
}
