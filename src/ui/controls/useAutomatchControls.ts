import { useCallback, useEffect, useReducer, useRef } from "react";
import { connection } from "../../connection/connection";
import type { NavigationGameItem } from "../../connection/connectionModels";
import {
  didClickAutomatchButton,
  dismissPendingAutomatchTransition,
} from "../../game/gameController";
import {
  decrementLifecycleCounter,
  incrementLifecycleCounter,
} from "../../lifecycle/lifecycleDiagnostics";
import { getCurrentRouteState } from "../../navigation/routeState";
import { transitionToHome } from "../../session/AppSessionManager";
import { soundPlayer } from "../../utils/SoundPlayer";
import {
  automatchControlsReducer,
  createAutomatchControlsState,
} from "./bottomControlsState";
import {
  NAVIGATION_PENDING_CANCEL_INTENT_TTL_MS,
  getCancelAutomatchRevealDeadlineMs,
  hasControlDeadlineElapsed,
} from "./controlTiming";

type CancelRevealPlan =
  { mode: "immediate" } | { mode: "delayed"; deadline: number };

type PendingCancelIntent = {
  inviteId: string;
  expiresAt: number;
  plan: CancelRevealPlan;
};

export const useAutomatchControls = ({
  profileId,
  createProfileRequestGuard,
  setOptimisticPendingAutomatch,
}: {
  profileId: string;
  createProfileRequestGuard: () => () => boolean;
  setOptimisticPendingAutomatch: (item: NavigationGameItem | null) => void;
}) => {
  const [state, dispatch] = useReducer(
    automatchControlsReducer,
    undefined,
    createAutomatchControlsState,
  );
  const revealPlanRef = useRef<CancelRevealPlan | null>(null);
  const pendingIntentRef = useRef<PendingCancelIntent | null>(null);
  const revealTimeoutRef = useRef<number | null>(null);
  const revealDeadlineRef = useRef<number | null>(null);

  const clearRevealTimer = useCallback(() => {
    if (revealTimeoutRef.current !== null) {
      window.clearTimeout(revealTimeoutRef.current);
      revealTimeoutRef.current = null;
      decrementLifecycleCounter("uiTimeouts");
    }
    revealDeadlineRef.current = null;
  }, []);

  const clearMatchScope = useCallback(() => {
    clearRevealTimer();
    revealPlanRef.current = null;
  }, [clearRevealTimer]);

  const reset = useCallback(() => {
    clearMatchScope();
    pendingIntentRef.current = null;
  }, [clearMatchScope]);

  const tryRevealCancelFromDeadline = useCallback(() => {
    if (!hasControlDeadlineElapsed(revealDeadlineRef.current, Date.now())) {
      return;
    }
    clearRevealTimer();
    dispatch({ type: "revealCancel" });
  }, [clearRevealTimer]);

  useEffect(() => {
    const handleDeadlineCheck = () => {
      if (document.visibilityState !== "hidden") {
        tryRevealCancelFromDeadline();
      }
    };
    handleDeadlineCheck();
    document.addEventListener("visibilitychange", handleDeadlineCheck);
    window.addEventListener("focus", handleDeadlineCheck);
    window.addEventListener("pageshow", handleDeadlineCheck);
    return () => {
      document.removeEventListener("visibilitychange", handleDeadlineCheck);
      window.removeEventListener("focus", handleDeadlineCheck);
      window.removeEventListener("pageshow", handleDeadlineCheck);
    };
  }, [tryRevealCancelFromDeadline]);

  useEffect(() => {
    clearRevealTimer();
    if (state.waiting && state.visible) {
      dispatch({ type: "finishCancellation" });
      const now = Date.now();
      const plan = revealPlanRef.current ?? {
        mode: "delayed",
        deadline: getCancelAutomatchRevealDeadlineMs(null, now),
      };
      revealPlanRef.current = plan;
      if (plan.mode === "immediate" || plan.deadline <= now) {
        dispatch({ type: "revealCancel" });
      } else {
        dispatch({ type: "hideCancel" });
        revealDeadlineRef.current = plan.deadline;
        revealTimeoutRef.current = window.setTimeout(() => {
          revealTimeoutRef.current = null;
          revealDeadlineRef.current = null;
          decrementLifecycleCounter("uiTimeouts");
          dispatch({ type: "revealCancel" });
        }, plan.deadline - now);
        incrementLifecycleCounter("uiTimeouts");
        tryRevealCancelFromDeadline();
      }
    } else {
      clearMatchScope();
      dispatch({ type: "resetCancel" });
    }
    return clearRevealTimer;
  }, [
    state.waiting,
    state.visible,
    state.revealRevision,
    clearRevealTimer,
    clearMatchScope,
    tryRevealCancelFromDeadline,
  ]);

  useEffect(() => {
    dispatch({ type: "finishCancellation" });
  }, [profileId]);

  useEffect(() => reset, [reset]);

  const setWaiting = useCallback(
    (waiting: boolean) => {
      if (waiting) {
        if (revealPlanRef.current === null) {
          const intent = pendingIntentRef.current;
          const route = getCurrentRouteState();
          if (intent && intent.expiresAt < Date.now()) {
            pendingIntentRef.current = null;
          } else if (
            intent &&
            route.mode === "invite" &&
            route.inviteId === intent.inviteId
          ) {
            revealPlanRef.current = intent.plan;
            pendingIntentRef.current = null;
          }
          revealPlanRef.current ??= { mode: "immediate" };
        }
        dispatch({ type: "enterWaiting" });
        return;
      }
      reset();
      setOptimisticPendingAutomatch(null);
      dispatch({ type: "leaveWaiting" });
    },
    [reset, setOptimisticPendingAutomatch],
  );

  const setEnabled = useCallback((enabled: boolean) => {
    dispatch({ type: "setEnabled", enabled });
  }, []);

  const setVisible = useCallback((visible: boolean) => {
    dispatch({ type: "setVisible", visible });
  }, []);

  const beginAutomatchFlow = useCallback(
    (options?: { skipSoundInit?: boolean }) => {
      const isAutomatchRequestCurrent = createProfileRequestGuard();
      reset();
      const deadline = getCancelAutomatchRevealDeadlineMs(null, Date.now());
      revealPlanRef.current = { mode: "delayed", deadline };
      if (!options?.skipSoundInit) {
        soundPlayer.initializeOnUserInteraction(false);
      }
      didClickAutomatchButton((response) => {
        if (!isAutomatchRequestCurrent()) {
          return;
        }
        const inviteId = response.ok ? response.inviteId : "";
        const mode = response.ok ? response.mode : "";
        if (mode === "pending" && inviteId) {
          pendingIntentRef.current = {
            inviteId,
            expiresAt: Date.now() + NAVIGATION_PENDING_CANCEL_INTENT_TTL_MS,
            plan: { mode: "delayed", deadline },
          };
          const item =
            connection.createOptimisticPendingAutomatchItem(inviteId);
          if (item) {
            setOptimisticPendingAutomatch(item);
          }
        } else if (mode === "matched") {
          pendingIntentRef.current = null;
          setOptimisticPendingAutomatch(null);
        } else {
          pendingIntentRef.current = null;
          setOptimisticPendingAutomatch(null);
          dismissPendingAutomatchTransition();
        }
      });
      dispatch({ type: "beginRequest" });
    },
    [createProfileRequestGuard, reset, setOptimisticPendingAutomatch],
  );

  const cancelAutomatch = useCallback(async () => {
    if (state.cancelDisabled) return;
    const isCancelRequestCurrent = createProfileRequestGuard();
    dispatch({ type: "requestCancellation" });
    try {
      const result = await connection.cancelAutomatch();
      if (!isCancelRequestCurrent()) {
        return;
      }
      if (result && result.ok) {
        setOptimisticPendingAutomatch(null);
        dismissPendingAutomatchTransition();
        await transitionToHome({ forceMatchScopeReset: true });
      } else {
        dispatch({ type: "finishCancellation" });
      }
    } catch (_) {
      if (!isCancelRequestCurrent()) {
        return;
      }
      dispatch({ type: "finishCancellation" });
    }
  }, [
    state.cancelDisabled,
    createProfileRequestGuard,
    setOptimisticPendingAutomatch,
  ]);

  const selectNavigationGame = useCallback(
    (inviteId: string, isPending: boolean) => {
      reset();
      if (isPending) {
        const plan: CancelRevealPlan = { mode: "immediate" };
        pendingIntentRef.current = {
          inviteId,
          expiresAt: Date.now() + NAVIGATION_PENDING_CANCEL_INTENT_TTL_MS,
          plan,
        };
        revealPlanRef.current = plan;
        dispatch({ type: "selectPending" });
      }
    },
    [reset],
  );

  return {
    state,
    beginAutomatchFlow,
    cancelAutomatch,
    setWaiting,
    setEnabled,
    setVisible,
    selectNavigationGame,
    clearMatchScope,
  };
};
