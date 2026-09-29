import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { EventPrizeConfig } from "@mons/shared/event-prizes";
import { connection } from "../../connection/connection";
import type {
  EventParticipant,
  EventPrizeId,
  EventPrizeSelections,
} from "../../connection/connectionModels";
import { EVENT_MODAL_Z_INDEX } from "./modalState";
import {
  PRIZE_AVATAR_APPEAR_DURATION_MS,
  PRIZE_AVATAR_DISAPPEAR_DURATION_MS,
  PRIZE_AVATAR_MOVE_DURATION_MS,
  type PendingPrizeAvatarAnimations,
} from "./eventLayout";
import {
  createEventPrizeSelectionCoordinator,
  type EventPrizeSelectionCoordinator,
} from "./prizeSelectionCoordinator";

export type UseEventPrizeSelectionOptions = {
  eventId: string | null;
  isOpen: boolean;
  currentProfileId: string;
  prizeConfig: EventPrizeConfig | null;
  concealed: boolean;
  participants: readonly EventParticipant[];
};

export type EventPrizeSelection = {
  selections: EventPrizeSelections;
  isUpdating: boolean;
  isPending: () => boolean;
  toggle: (prizeId: EventPrizeId) => void;
  loadedImageIds: ReadonlySet<EventPrizeId>;
  markImageLoaded: (prizeId: EventPrizeId) => void;
  registerAvatar: (profileId: string, element: HTMLSpanElement | null) => void;
};

const shouldReducePrizeAvatarMotion = (): boolean => {
  return (
    typeof window === "undefined" ||
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  );
};

const animatePrizeAvatarExit = (
  element: HTMLSpanElement,
  onComplete: () => void,
): (() => void) | null => {
  if (
    shouldReducePrizeAvatarMotion() ||
    typeof element.animate !== "function"
  ) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const clone = element.cloneNode(true) as HTMLSpanElement;
  clone.setAttribute("aria-hidden", "true");
  Object.assign(clone.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    pointerEvents: "none",
    transform: "none",
    transformOrigin: "center",
    zIndex: `${EVENT_MODAL_Z_INDEX + 3}`,
  });
  document.body.appendChild(clone);
  let animation: Animation;
  try {
    animation = clone.animate(
      [
        { opacity: 1, transform: "scale(1)" },
        { opacity: 0, transform: "scale(0.78)" },
      ],
      {
        duration: PRIZE_AVATAR_DISAPPEAR_DURATION_MS,
        easing: "ease-out",
        fill: "forwards",
      },
    );
  } catch {
    clone.remove();
    return null;
  }
  let isComplete = false;
  const complete = () => {
    if (isComplete) {
      return;
    }
    isComplete = true;
    clone.remove();
    onComplete();
  };
  animation.addEventListener("finish", complete, { once: true });
  animation.addEventListener("cancel", complete, { once: true });
  return () => {
    animation.cancel();
    complete();
  };
};

const animatePrizeAvatarPlacement = (
  element: HTMLSpanElement,
  previousRect: DOMRect | undefined,
): void => {
  if (
    shouldReducePrizeAvatarMotion() ||
    typeof element.animate !== "function"
  ) {
    return;
  }
  element.getAnimations().forEach((animation) => animation.cancel());
  const nextRect = element.getBoundingClientRect();
  if (nextRect.width <= 0 || nextRect.height <= 0) {
    return;
  }
  if (!previousRect) {
    element.animate(
      [
        { opacity: 0, transform: "scale(0.76)" },
        { opacity: 1, transform: "scale(1)" },
      ],
      {
        duration: PRIZE_AVATAR_APPEAR_DURATION_MS,
        easing: "ease-out",
      },
    );
    return;
  }
  const deltaX = previousRect.left - nextRect.left;
  const deltaY = previousRect.top - nextRect.top;
  if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
    return;
  }
  element.animate(
    [
      { transform: `translate(${deltaX}px, ${deltaY}px)` },
      { transform: "translate(0, 0)" },
    ],
    {
      duration: PRIZE_AVATAR_MOVE_DURATION_MS,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    },
  );
};

export const useEventPrizeSelection = ({
  eventId,
  isOpen,
  currentProfileId,
  prizeConfig,
  concealed,
  participants,
}: UseEventPrizeSelectionOptions): EventPrizeSelection => {
  const [isUpdatingPrizeSelection, setIsUpdatingPrizeSelection] =
    useState(false);
  const [eventPrizeSelections, setEventPrizeSelections] =
    useState<EventPrizeSelections>({});
  const [loadedPrizeImageIds, setLoadedPrizeImageIds] = useState<
    ReadonlySet<EventPrizeId>
  >(() => new Set());
  const prizeSelectionAvatarRefs = useRef<Map<string, HTMLSpanElement>>(
    new Map(),
  );
  const committedPrizeSelectionsRef = useRef<EventPrizeSelections>({});
  const hasReceivedInitialPrizeSelectionsRef = useRef(false);
  const isHydratingInitialPrizeSelectionsRef = useRef(false);
  const pendingPrizeAvatarAnimationsRef =
    useRef<PendingPrizeAvatarAnimations | null>(null);
  const activePrizeAvatarExitCleanupsRef = useRef<Map<string, () => void>>(
    new Map(),
  );
  const prizeSelectionCoordinatorRef =
    useRef<EventPrizeSelectionCoordinator | null>(null);
  const markPrizeImageLoaded = useCallback((prizeId: EventPrizeId) => {
    setLoadedPrizeImageIds((current) => {
      if (current.has(prizeId)) {
        return current;
      }
      const next = new Set(current);
      next.add(prizeId);
      return next;
    });
  }, []);
  const clearPrizeAvatarExitAnimations = useCallback(() => {
    const cleanups = Array.from(
      activePrizeAvatarExitCleanupsRef.current.values(),
    );
    activePrizeAvatarExitCleanupsRef.current.clear();
    cleanups.forEach((cleanup) => cleanup());
  }, []);
  const applyEventPrizeSelections = useCallback(
    (nextSelections: EventPrizeSelections) => {
      const previousSelections = committedPrizeSelectionsRef.current;
      if (
        !hasReceivedInitialPrizeSelectionsRef.current ||
        isHydratingInitialPrizeSelectionsRef.current
      ) {
        hasReceivedInitialPrizeSelectionsRef.current = true;
        isHydratingInitialPrizeSelectionsRef.current = true;
        pendingPrizeAvatarAnimationsRef.current = null;
        setEventPrizeSelections(nextSelections);
        return;
      }

      for (const profileId of Object.keys(nextSelections)) {
        activePrizeAvatarExitCleanupsRef.current.get(profileId)?.();
      }
      const profileIds = new Set([
        ...Object.keys(previousSelections),
        ...Object.keys(nextSelections),
      ]);
      const didChange = Array.from(profileIds).some(
        (profileId) =>
          previousSelections[profileId] !== nextSelections[profileId],
      );

      if (!didChange) {
        setEventPrizeSelections(nextSelections);
        return;
      }

      if (shouldReducePrizeAvatarMotion()) {
        pendingPrizeAvatarAnimationsRef.current = null;
        setEventPrizeSelections(nextSelections);
        return;
      }

      const previousRects = new Map<string, DOMRect>();
      for (const [profileId, element] of prizeSelectionAvatarRefs.current) {
        if (!previousSelections[profileId] || !element.isConnected) {
          continue;
        }
        previousRects.set(profileId, element.getBoundingClientRect());
        if (!nextSelections[profileId]) {
          activePrizeAvatarExitCleanupsRef.current.get(profileId)?.();
          let cleanup: (() => void) | null = null;
          cleanup = animatePrizeAvatarExit(element, () => {
            if (
              cleanup &&
              activePrizeAvatarExitCleanupsRef.current.get(profileId) ===
                cleanup
            ) {
              activePrizeAvatarExitCleanupsRef.current.delete(profileId);
            }
          });
          if (cleanup) {
            activePrizeAvatarExitCleanupsRef.current.set(profileId, cleanup);
          }
        }
      }
      const enteringProfileIds = new Set(
        Array.from(profileIds).filter(
          (profileId) =>
            !previousSelections[profileId] && !!nextSelections[profileId],
        ),
      );
      pendingPrizeAvatarAnimationsRef.current = {
        previousRects,
        enteringProfileIds,
      };
      setEventPrizeSelections(nextSelections);
    },
    [],
  );
  useLayoutEffect(() => {
    setLoadedPrizeImageIds(new Set());
  }, [eventId, isOpen, prizeConfig]);

  useLayoutEffect(() => {
    prizeSelectionCoordinatorRef.current?.dispose();
    prizeSelectionCoordinatorRef.current = null;
    clearPrizeAvatarExitAnimations();
    committedPrizeSelectionsRef.current = {};
    hasReceivedInitialPrizeSelectionsRef.current = false;
    isHydratingInitialPrizeSelectionsRef.current = false;
    pendingPrizeAvatarAnimationsRef.current = null;
    setEventPrizeSelections({});
    setIsUpdatingPrizeSelection(false);
    if (!isOpen || !eventId || !prizeConfig) {
      return;
    }
    let isActive = true;
    const coordinator = currentProfileId
      ? createEventPrizeSelectionCoordinator({
          profileId: currentProfileId,
          mutate: (prizeId) =>
            connection.toggleEventPrizeSelection(prizeConfig.eventId, prizeId),
          onPendingChange: setIsUpdatingPrizeSelection,
          onSelectionsChange: applyEventPrizeSelections,
        })
      : null;
    prizeSelectionCoordinatorRef.current = coordinator;
    const unsubscribe = connection.subscribeToEventPrizeSelections(
      eventId,
      (selections) => {
        if (!isActive) return;
        if (coordinator) {
          coordinator.receiveAuthoritative(selections);
        } else {
          applyEventPrizeSelections(selections);
        }
      },
      (error) => {
        if (!isActive) return;
        console.error("Error subscribing to event prize selections:", error);
      },
    );
    return () => {
      isActive = false;
      unsubscribe();
      coordinator?.dispose();
      clearPrizeAvatarExitAnimations();
      if (prizeSelectionCoordinatorRef.current === coordinator) {
        prizeSelectionCoordinatorRef.current = null;
      }
    };
  }, [
    applyEventPrizeSelections,
    clearPrizeAvatarExitAnimations,
    currentProfileId,
    prizeConfig,
    eventId,
    isOpen,
  ]);

  useLayoutEffect(() => {
    committedPrizeSelectionsRef.current = eventPrizeSelections;
    isHydratingInitialPrizeSelectionsRef.current = false;
    if (concealed) {
      pendingPrizeAvatarAnimationsRef.current = null;
      clearPrizeAvatarExitAnimations();
      return;
    }
    const pendingAnimations = pendingPrizeAvatarAnimationsRef.current;
    if (!pendingAnimations) {
      return;
    }

    const profileIds = new Set([
      ...pendingAnimations.previousRects.keys(),
      ...pendingAnimations.enteringProfileIds,
    ]);
    const remainingPreviousRects = new Map<string, DOMRect>();
    const remainingEnteringProfileIds = new Set<string>();

    for (const profileId of profileIds) {
      if (!eventPrizeSelections[profileId]) {
        continue;
      }
      const previousRect = pendingAnimations.previousRects.get(profileId);
      const isEntering =
        pendingAnimations.enteringProfileIds.has(profileId) && !previousRect;
      const element = prizeSelectionAvatarRefs.current.get(profileId);
      if (!element?.isConnected) {
        if (previousRect) {
          remainingPreviousRects.set(profileId, previousRect);
        }
        if (isEntering) {
          remainingEnteringProfileIds.add(profileId);
        }
        continue;
      }
      animatePrizeAvatarPlacement(
        element,
        isEntering ? undefined : previousRect,
      );
    }

    pendingPrizeAvatarAnimationsRef.current =
      remainingPreviousRects.size > 0 || remainingEnteringProfileIds.size > 0
        ? {
            previousRects: remainingPreviousRects,
            enteringProfileIds: remainingEnteringProfileIds,
          }
        : null;
  }, [
    concealed,
    clearPrizeAvatarExitAnimations,
    eventPrizeSelections,
    loadedPrizeImageIds,
    participants,
  ]);
  const isPending = useCallback(
    () => prizeSelectionCoordinatorRef.current?.isPending() ?? false,
    [],
  );
  const toggle = useCallback((prizeId: EventPrizeId) => {
    prizeSelectionCoordinatorRef.current?.toggle(prizeId);
  }, []);
  const registerAvatar = useCallback(
    (profileId: string, element: HTMLSpanElement | null) => {
      if (element) {
        prizeSelectionAvatarRefs.current.set(profileId, element);
      } else {
        prizeSelectionAvatarRefs.current.delete(profileId);
      }
    },
    [],
  );

  return {
    selections: eventPrizeSelections,
    isUpdating: isUpdatingPrizeSelection,
    isPending,
    toggle,
    loadedImageIds: loadedPrizeImageIds,
    markImageLoaded: markPrizeImageLoaded,
    registerAvatar,
  };
};
