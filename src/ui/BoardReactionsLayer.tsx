import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  bindBoardVideoReactionHandler,
  unbindBoardVideoReactionHandler,
} from "./controls/boardReactionPort";

const VIDEO_CONTAINER_HEIGHT_GRID = "12.5%";
const VIDEO_CONTAINER_HEIGHT_IMAGE = "13.5%";
const VIDEO_CONTAINER_MAX_HEIGHT = "min(20vh, 180px)";
const VIDEO_CONTAINER_ASPECT_RATIO = "1";
const VIDEO_CONTAINER_Z_INDEX = 10000;
const VIDEO_REACTION_APPEAR_MS = 400;
const VIDEO_REACTION_FADE_OUT_MS = 200;
const VIDEO_REACTION_CLEAR_FADE_OUT_MS = 120;
const VIDEO_REACTION_DEFAULT_LIFETIME_MS = 7000;
const VIDEO_REACTION_MIN_LIFETIME_MS = 1000;
const VIDEO_REACTION_MAX_LIFETIME_MS = 12000;
const VIDEO_REACTION_END_GRACE_MS = 700;

const getVideoReactionPlaybackLifetimeMs = (videoElement: HTMLVideoElement) => {
  const currentTimeSeconds =
    Number.isFinite(videoElement.currentTime) && videoElement.currentTime > 0
      ? videoElement.currentTime
      : 0;
  const durationMs =
    Number.isFinite(videoElement.duration) && videoElement.duration > 0
      ? Math.max(0, videoElement.duration - currentTimeSeconds) * 1000 +
        VIDEO_REACTION_END_GRACE_MS
      : VIDEO_REACTION_DEFAULT_LIFETIME_MS;
  return Math.min(
    VIDEO_REACTION_MAX_LIFETIME_MS,
    Math.max(VIDEO_REACTION_MIN_LIFETIME_MS, durationMs),
  );
};

const getErrorName = (error: unknown) =>
  error && typeof error === "object" && "name" in error
    ? String((error as { name?: unknown }).name)
    : "";

const playVideoReactionElement = (
  videoElement: HTMLVideoElement | null,
  onCannotPlay: () => void,
) => {
  if (!videoElement || document.visibilityState !== "visible") {
    return;
  }

  const playPromise = videoElement.play() as Promise<void> | undefined;
  void playPromise?.catch((error: unknown) => {
    const errorName = getErrorName(error);
    if (
      errorName === "AbortError" ||
      document.visibilityState !== "visible" ||
      !videoElement.isConnected ||
      videoElement.ended
    ) {
      return;
    }
    onCannotPlay();
  });
};

const startVideoReactionElement = (
  videoElement: HTMLVideoElement | null,
  onCannotPlay: () => void,
) => {
  if (!videoElement) {
    return;
  }
  videoElement.muted = true;
  videoElement.playsInline = true;
  try {
    videoElement.currentTime = 0;
  } catch {}
  playVideoReactionElement(videoElement, onCannotPlay);
};

const isVideoReactionElementError = (
  event: React.SyntheticEvent<HTMLVideoElement>,
) => event.currentTarget === event.target;

const useVideoReactionSlot = (
  setTrackedTimeout: (callback: () => void, delay: number) => number,
  clearTrackedTimeout: (timeoutId: number | null) => void,
) => {
  const [id, setId] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  const [appearing, setAppearing] = useState(false);
  const [instance, setInstance] = useState(0);
  const dismissTimeoutRef = useRef<number | null>(null);
  const dismissDeadlineRef = useRef<number | null>(null);
  const appearingTimeoutRef = useRef<number | null>(null);
  const lifetimeTimeoutRef = useRef<number | null>(null);
  const lifetimeDeadlineRef = useRef<number | null>(null);
  const instanceRef = useRef(0);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);

  const clearDismissTimeout = useCallback(() => {
    clearTrackedTimeout(dismissTimeoutRef.current);
    dismissTimeoutRef.current = null;
    dismissDeadlineRef.current = null;
  }, [clearTrackedTimeout]);

  const clearAppearingTimeout = useCallback(() => {
    clearTrackedTimeout(appearingTimeoutRef.current);
    appearingTimeoutRef.current = null;
  }, [clearTrackedTimeout]);

  const clearLifetimeTimeout = useCallback(() => {
    clearTrackedTimeout(lifetimeTimeoutRef.current);
    lifetimeTimeoutRef.current = null;
    lifetimeDeadlineRef.current = null;
  }, [clearTrackedTimeout]);

  const dismiss = useCallback(
    (durationMs: number) => {
      clearDismissTimeout();
      clearLifetimeTimeout();
      setAppearing(false);
      setFading(true);
      dismissDeadlineRef.current = Date.now() + durationMs;
      dismissTimeoutRef.current = setTrackedTimeout(() => {
        setVisible(false);
        setFading(false);
        setId(null);
        dismissTimeoutRef.current = null;
        dismissDeadlineRef.current = null;
      }, durationMs);
    },
    [clearDismissTimeout, clearLifetimeTimeout, setTrackedTimeout],
  );

  const fadeOut = useCallback(() => {
    dismiss(VIDEO_REACTION_FADE_OUT_MS);
  }, [dismiss]);

  const fadeOutInstance = useCallback(
    (targetInstance: number) => {
      if (instanceRef.current !== targetInstance) {
        return;
      }
      fadeOut();
    },
    [fadeOut],
  );

  const scheduleLifetimeTimeout = useCallback(
    (durationMs: number, targetInstance: number) => {
      if (
        instanceRef.current !== targetInstance ||
        dismissTimeoutRef.current !== null
      ) {
        return;
      }
      clearLifetimeTimeout();
      lifetimeDeadlineRef.current = Date.now() + durationMs;
      lifetimeTimeoutRef.current = setTrackedTimeout(() => {
        if (instanceRef.current !== targetInstance) {
          return;
        }
        lifetimeTimeoutRef.current = null;
        lifetimeDeadlineRef.current = null;
        fadeOut();
      }, durationMs);
    },
    [clearLifetimeTimeout, fadeOut, setTrackedTimeout],
  );

  const show = useCallback(
    (stickerId: number) => {
      const nextInstance = instanceRef.current + 1;
      instanceRef.current = nextInstance;
      clearDismissTimeout();
      clearAppearingTimeout();
      setId(stickerId);
      setInstance(nextInstance);
      setVisible(true);
      setFading(false);
      setAppearing(true);
      scheduleLifetimeTimeout(VIDEO_REACTION_DEFAULT_LIFETIME_MS, nextInstance);
      appearingTimeoutRef.current = setTrackedTimeout(() => {
        setAppearing(false);
        appearingTimeoutRef.current = null;
      }, VIDEO_REACTION_APPEAR_MS);
    },
    [
      clearAppearingTimeout,
      clearDismissTimeout,
      scheduleLifetimeTimeout,
      setTrackedTimeout,
    ],
  );

  const clearNow = useCallback(() => {
    clearDismissTimeout();
    clearAppearingTimeout();
    clearLifetimeTimeout();
    setVisible(false);
    setFading(false);
    setAppearing(false);
    setId(null);
  }, [clearAppearingTimeout, clearDismissTimeout, clearLifetimeTimeout]);

  const setElementRef = useCallback(
    (videoElement: HTMLVideoElement | null) => {
      videoElementRef.current = videoElement;
      startVideoReactionElement(videoElement, () => {
        fadeOutInstance(instance);
      });
    },
    [fadeOutInstance, instance],
  );

  const syncAfterPageResume = useCallback(
    (now: number) => {
      if (!visible) {
        return;
      }

      if (fading) {
        const dismissDeadline = dismissDeadlineRef.current;
        if (dismissDeadline !== null && now >= dismissDeadline) {
          clearDismissTimeout();
          setVisible(false);
          setFading(false);
          setAppearing(false);
          setId(null);
        }
        return;
      }

      const videoElement = videoElementRef.current;
      const deadline = lifetimeDeadlineRef.current;
      if (
        (deadline !== null && now >= deadline) ||
        videoElement?.ended === true
      ) {
        dismiss(VIDEO_REACTION_CLEAR_FADE_OUT_MS);
        return;
      }

      playVideoReactionElement(videoElement, () => {
        dismiss(VIDEO_REACTION_CLEAR_FADE_OUT_MS);
      });
    },
    [clearDismissTimeout, dismiss, fading, visible],
  );

  const resetTimeoutRefs = useCallback(() => {
    dismissTimeoutRef.current = null;
    dismissDeadlineRef.current = null;
    appearingTimeoutRef.current = null;
    lifetimeTimeoutRef.current = null;
    lifetimeDeadlineRef.current = null;
  }, []);

  return {
    appearing,
    clearNow,
    dismiss,
    fadeOutInstance,
    fading,
    id,
    instance,
    resetTimeoutRefs,
    scheduleLifetimeTimeout,
    setElementRef,
    show,
    syncAfterPageResume,
    visible,
  };
};

type BoardVideoReactionProps = Pick<
  ReturnType<typeof useVideoReactionSlot>,
  | "appearing"
  | "fadeOutInstance"
  | "fading"
  | "id"
  | "instance"
  | "scheduleLifetimeTimeout"
  | "setElementRef"
  | "visible"
>;

const BoardVideoReaction: React.FC<BoardVideoReactionProps> = ({
  appearing,
  fadeOutInstance,
  fading,
  id,
  instance,
  scheduleLifetimeTimeout,
  setElementRef,
  visible,
}) => {
  if (!visible || id === null) {
    return null;
  }

  return (
    <video
      key={`${id}-${instance}`}
      ref={setElementRef}
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        transform: appearing
          ? "translate(-50%, -50%) scale(0.3) rotate(-10deg)"
          : fading
            ? "translate(-50%, -50%) scale(0.8) rotate(0deg)"
            : "translate(-50%, -50%) scale(1) rotate(0deg)",
        width: "100%",
        height: "100%",
        opacity: appearing ? 0 : fading ? 0 : 1,
        transition: appearing
          ? "opacity 0.3s ease-out, transform 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55)"
          : fading
            ? "opacity 0.2s ease-in, transform 0.2s ease-in"
            : "opacity 0.3s ease-out, transform 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55)",
      }}
      autoPlay
      muted
      preload="auto"
      playsInline
      onEnded={() => {
        fadeOutInstance(instance);
      }}
      onError={(event) => {
        if (isVideoReactionElementError(event)) {
          fadeOutInstance(instance);
        }
      }}
      onPlaying={(event) => {
        scheduleLifetimeTimeout(
          getVideoReactionPlaybackLifetimeMs(event.currentTarget),
          instance,
        );
      }}
    >
      <source
        src={`https://cdn.lil.org/mons/emojipack/swagpack/video/${id}.mov`}
        type='video/quicktime; codecs="hvc1"'
      />
      <source
        src={`https://cdn.lil.org/mons/emojipack/swagpack/video/${id}.webm`}
        type="video/webm"
      />
    </video>
  );
};

export type BoardReactionsLayerHandle = {
  resetTimeoutRefs(): void;
  clear(fadeOutVideos?: boolean): void;
};

type BoardReactionsLayerProps = {
  ref?: React.Ref<BoardReactionsLayerHandle>;
  viewportRect: Pick<DOMRect, "left" | "top" | "width" | "height"> | null;
  isPangchiuBoardLayout: boolean;
  setTrackedTimeout(callback: () => void, delay: number): number;
  clearTrackedTimeout(timeoutId: number | null): void;
  wagerLayer: React.ReactNode;
  children: React.ReactNode;
};

export const BoardReactionsLayer: React.FC<BoardReactionsLayerProps> = ({
  ref,
  viewportRect,
  isPangchiuBoardLayout,
  setTrackedTimeout,
  clearTrackedTimeout,
  wagerLayer,
  children,
}) => {
  const opponent = useVideoReactionSlot(setTrackedTimeout, clearTrackedTimeout);
  const player = useVideoReactionSlot(setTrackedTimeout, clearTrackedTimeout);
  const {
    clearNow: clearOpponentNow,
    dismiss: dismissOpponent,
    resetTimeoutRefs: resetOpponentTimeoutRefs,
    show: showOpponent,
    syncAfterPageResume: syncOpponentAfterPageResume,
    visible: opponentVisible,
  } = opponent;
  const {
    clearNow: clearPlayerNow,
    dismiss: dismissPlayer,
    resetTimeoutRefs: resetPlayerTimeoutRefs,
    show: showPlayer,
    syncAfterPageResume: syncPlayerAfterPageResume,
    visible: playerVisible,
  } = player;

  useEffect(() => {
    return () => {
      resetOpponentTimeoutRefs();
      resetPlayerTimeoutRefs();
    };
  }, [resetOpponentTimeoutRefs, resetPlayerTimeoutRefs]);

  useImperativeHandle(
    ref,
    () => ({
      resetTimeoutRefs() {
        resetOpponentTimeoutRefs();
        resetPlayerTimeoutRefs();
      },
      clear(fadeOutVideos = true) {
        if (!fadeOutVideos) {
          clearOpponentNow();
          clearPlayerNow();
          return;
        }
        if (opponentVisible) {
          dismissOpponent(VIDEO_REACTION_CLEAR_FADE_OUT_MS);
        } else {
          clearOpponentNow();
        }
        if (playerVisible) {
          dismissPlayer(VIDEO_REACTION_CLEAR_FADE_OUT_MS);
        } else {
          clearPlayerNow();
        }
      },
    }),
    [
      clearOpponentNow,
      clearPlayerNow,
      dismissOpponent,
      dismissPlayer,
      opponentVisible,
      playerVisible,
      resetOpponentTimeoutRefs,
      resetPlayerTimeoutRefs,
    ],
  );

  useLayoutEffect(() => {
    const boundHandler = bindBoardVideoReactionHandler(
      (opponent, stickerId) => {
        if (opponent) {
          showOpponent(stickerId);
        } else {
          showPlayer(stickerId);
        }
      },
    );
    return () => unbindBoardVideoReactionHandler(boundHandler);
  }, [showOpponent, showPlayer]);

  const syncAfterPageResume = useCallback(() => {
    if (document.visibilityState === "hidden") {
      return;
    }
    const now = Date.now();
    syncOpponentAfterPageResume(now);
    syncPlayerAfterPageResume(now);
  }, [syncOpponentAfterPageResume, syncPlayerAfterPageResume]);

  useEffect(() => {
    document.addEventListener("visibilitychange", syncAfterPageResume);
    window.addEventListener("focus", syncAfterPageResume);
    window.addEventListener("pageshow", syncAfterPageResume);
    return () => {
      document.removeEventListener("visibilitychange", syncAfterPageResume);
      window.removeEventListener("focus", syncAfterPageResume);
      window.removeEventListener("pageshow", syncAfterPageResume);
    };
  }, [syncAfterPageResume]);

  const topVideoReactionStyle = {
    top: isPangchiuBoardLayout ? "7.05%" : "7.02%",
    height: isPangchiuBoardLayout
      ? VIDEO_CONTAINER_HEIGHT_IMAGE
      : VIDEO_CONTAINER_HEIGHT_GRID,
  };
  const bottomVideoReactionStyle = {
    top: isPangchiuBoardLayout ? "89.65%" : "85.22%",
    height: isPangchiuBoardLayout
      ? VIDEO_CONTAINER_HEIGHT_IMAGE
      : VIDEO_CONTAINER_HEIGHT_GRID,
  };

  if (!viewportRect) {
    return null;
  }

  return (
    <div
      style={{
        position: "fixed",
        left: `${viewportRect.left}px`,
        top: `${viewportRect.top}px`,
        width: `${viewportRect.width}px`,
        height: `${viewportRect.height}px`,
        pointerEvents: "none",
      }}
    >
      {wagerLayer}
      <div
        style={{
          position: "absolute",
          left: "50%",
          transform: "translate(-50%, -100%)",
          ...topVideoReactionStyle,
          maxHeight: VIDEO_CONTAINER_MAX_HEIGHT,
          aspectRatio: VIDEO_CONTAINER_ASPECT_RATIO,
          zIndex: VIDEO_CONTAINER_Z_INDEX,
          pointerEvents: "none",
          touchAction: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: "100%",
            height: "100%",
            pointerEvents: "none",
          }}
        />
        <BoardVideoReaction {...opponent} />
      </div>
      <div
        style={{
          position: "absolute",
          left: "50%",
          transform: "translateX(-50%)",
          ...bottomVideoReactionStyle,
          maxHeight: VIDEO_CONTAINER_MAX_HEIGHT,
          aspectRatio: VIDEO_CONTAINER_ASPECT_RATIO,
          zIndex: VIDEO_CONTAINER_Z_INDEX,
          pointerEvents: "none",
          touchAction: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: "100%",
            height: "100%",
            pointerEvents: "none",
          }}
        />
        <BoardVideoReaction {...player} />
      </div>
      {children}
    </div>
  );
};
