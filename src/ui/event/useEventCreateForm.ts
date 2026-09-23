import { useCallback, useEffect, useRef, useState } from "react";
import type { EventTelegramAnnouncements } from "@mons/shared/events";
import { createProfileEvent } from "../profileSurfaceDataPort";
import {
  getEventModalState,
  openEventModal,
  openEventModalPendingCreate,
  setEventModalPendingCreateError,
} from "../eventModalController";
import {
  getDefaultScheduledDateTimeInput,
  validateEventCreateSchedule,
  type EventScheduleFields,
} from "./eventCreateSchedule";

const getDefaultAnnouncements = (): EventTelegramAnnouncements => ({
  invite: false,
  matches: false,
  results: false,
});

export const useEventCreateForm = (onCreateStarted: () => void) => {
  const [schedule, setSchedule] = useState<EventScheduleFields>(() => {
    const defaults = getDefaultScheduledDateTimeInput();
    return {
      mode: "minutes",
      startsInMinutes: "5",
      scheduledDate: defaults.date,
      scheduledTime: defaults.time,
      scheduledTimezone: "local",
    };
  });
  const [isSundayMons, setIsSundayMons] = useState(false);
  const [telegramAnnouncements, setTelegramAnnouncements] =
    useState<EventTelegramAnnouncements>(getDefaultAnnouncements);
  const [isCreatingEvent, setIsCreatingEvent] = useState(false);
  const [error, setError] = useState("");
  const mountedRef = useRef(false);
  const creatingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setScheduleField = useCallback(
    <K extends keyof EventScheduleFields>(
      field: K,
      value: EventScheduleFields[K],
    ) => {
      setSchedule((current) => ({ ...current, [field]: value }));
      setError("");
    },
    [],
  );

  const setTelegramAnnouncement = useCallback(
    (key: keyof EventTelegramAnnouncements, checked: boolean) => {
      setTelegramAnnouncements((current) => ({ ...current, [key]: checked }));
    },
    [],
  );

  const resetForOpen = useCallback(() => {
    const defaults = getDefaultScheduledDateTimeInput();
    setSchedule((current) => ({
      ...current,
      mode: "minutes",
      scheduledDate: defaults.date,
      scheduledTime: defaults.time,
      scheduledTimezone: "local",
    }));
    setIsSundayMons(false);
    setTelegramAnnouncements(getDefaultAnnouncements());
    setError("");
  }, []);

  const submit = useCallback(() => {
    if (creatingRef.current) {
      return;
    }
    const validation = validateEventCreateSchedule(
      schedule,
      schedule.mode === "datetime"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : undefined,
    );
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    setError("");
    creatingRef.current = true;
    setIsCreatingEvent(true);
    onCreateStarted();
    openEventModalPendingCreate();
    void createProfileEvent(validation.schedule, {
      isSundayMons,
      telegramAnnouncements,
    })
      .then((result) => {
        if (!result.ok || !result.eventId) {
          setEventModalPendingCreateError("Failed to create event.");
          return;
        }
        const modalState = getEventModalState();
        if (!modalState.isOpen || !modalState.isPendingCreate) {
          return;
        }
        openEventModal(result.eventId);
      })
      .catch((error) => {
        const message =
          error &&
          typeof error === "object" &&
          "message" in error &&
          typeof (error as { message?: unknown }).message === "string"
            ? (error as { message: string }).message
            : "Failed to create event.";
        setEventModalPendingCreateError(message);
      })
      .finally(() => {
        creatingRef.current = false;
        if (mountedRef.current) {
          setIsCreatingEvent(false);
        }
      });
  }, [isSundayMons, onCreateStarted, schedule, telegramAnnouncements]);

  return {
    schedule,
    setScheduleField,
    isSundayMons,
    setIsSundayMons,
    telegramAnnouncements,
    setTelegramAnnouncement,
    isCreatingEvent,
    error,
    submit,
    resetForOpen,
  };
};
