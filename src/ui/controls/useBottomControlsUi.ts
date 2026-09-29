import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { MATCH_TIMER_DURATION_SECONDS } from "@mons/shared/timers";
import type { GameControlsPresentation } from "../../game/gameControlsModel";
import {
  getGameControlsSnapshot,
  resetGameControlsPresentation,
  updateGameControlsPresentation,
} from "../../game/gameControlsStore";
import {
  bottomControlsUiReducer,
  createBottomControlsUiState,
  type BottomControlsUiAction,
} from "./bottomControlsUiState";

export const useBottomControlsUi = () => {
  const [initialTimerConfig] = useState(() => ({
    duration: MATCH_TIMER_DURATION_SECONDS,
    progress: 0,
    requestDate: Date.now(),
  }));
  const initializedPresentation = useRef(false);
  const isMounted = useRef(false);
  useLayoutEffect(() => {
    isMounted.current = true;
    if (!initializedPresentation.current) {
      initializedPresentation.current = true;
      resetGameControlsPresentation(initialTimerConfig);
    }
    return () => {
      isMounted.current = false;
    };
  }, [initialTimerConfig]);
  const [popups, setPopups] = useState(
    () =>
      createBottomControlsUiState(
        getGameControlsSnapshot().presentation.gameControls.timer.config,
      ).popups,
  );
  const currentPopups = useRef(popups);
  const updatePresentation = useCallback(
    (updates: Partial<GameControlsPresentation>) => {
      if (isMounted.current) updateGameControlsPresentation(updates);
    },
    [],
  );
  const dispatch = useCallback((action: BottomControlsUiAction) => {
    if (!isMounted.current) return;
    const previous = {
      gameControls: getGameControlsSnapshot().presentation.gameControls,
      popups: currentPopups.current,
    };
    const next = bottomControlsUiReducer(previous, action);
    currentPopups.current = next.popups;
    updateGameControlsPresentation({ gameControls: next.gameControls });
    setPopups(next.popups);
  }, []);
  return { popups, dispatch, updatePresentation };
};
