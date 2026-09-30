import { useCallback, useEffect, useRef, useState } from "react";
import {
  didSelectRematchSeriesMatch,
  getRematchSeriesNavigatorItems,
  preloadRematchSeriesScores,
  type RematchSeriesNavigatorItem,
} from "../../game/gameController";
import {
  subscribeMoveHistoryPopupReload,
  triggerMoveHistoryPopupSelectionReset,
} from "./moveHistoryPopupStore";

type RematchSeriesOptions = {
  setMatchScopedTimeout: (callback: () => void, delay: number) => number;
  clearTrackedMatchScopedTimeout: (timeoutId: number | null) => void;
};

const readRematchSeriesItems = (): RematchSeriesNavigatorItem[] => {
  try {
    return getRematchSeriesNavigatorItems();
  } catch {
    return [];
  }
};

const hasMissingHistoricalScores = (items: RematchSeriesNavigatorItem[]) =>
  items.some(
    (item) =>
      !item.isActiveMatch &&
      !item.isPendingResponse &&
      (item.whiteScore === null || item.blackScore === null),
  );

export function useRematchSeries({
  setMatchScopedTimeout,
  clearTrackedMatchScopedTimeout,
}: RematchSeriesOptions) {
  const [, setHistoryUiVersion] = useState(0);
  const [isSelecting, setIsSelecting] = useState(false);
  const selectionLockRef = useRef(false);

  useEffect(() => {
    return subscribeMoveHistoryPopupReload(() => {
      setHistoryUiVersion((value) => value + 1);
    });
  }, []);

  const items = readRematchSeriesItems();
  const matchesKey = items.map((item) => item.matchId).join("|");

  useEffect(() => {
    if (matchesKey === "") return;

    let isDisposed = false;
    let retryTimeoutId: number | null = null;
    let retryCount = 0;

    const runPreload = async () => {
      let didChange = false;
      try {
        didChange = await preloadRematchSeriesScores();
      } catch {
        didChange = false;
      }
      if (isDisposed) return;
      if (didChange) setHistoryUiVersion((value) => value + 1);
      if (!hasMissingHistoricalScores(readRematchSeriesItems())) return;
      if (retryCount >= 8) return;

      retryCount += 1;
      retryTimeoutId = setMatchScopedTimeout(() => {
        void runPreload();
      }, 650);
    };

    void runPreload();

    return () => {
      isDisposed = true;
      if (retryTimeoutId !== null) {
        clearTrackedMatchScopedTimeout(retryTimeoutId);
      }
    };
  }, [clearTrackedMatchScopedTimeout, matchesKey, setMatchScopedTimeout]);

  const selectMatch = useCallback(async (matchId: string) => {
    if (selectionLockRef.current) return;

    selectionLockRef.current = true;
    setIsSelecting(true);
    try {
      const didSwitch = await didSelectRematchSeriesMatch(matchId);
      if (didSwitch) triggerMoveHistoryPopupSelectionReset();
    } finally {
      selectionLockRef.current = false;
      setIsSelecting(false);
    }
  }, []);

  return { items, isSelecting, selectMatch };
}
