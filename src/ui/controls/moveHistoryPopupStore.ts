const reloadListeners = new Set<() => void>();
const selectionResetListeners = new Set<() => void>();
let popupIsOpen = false;
let popupIsFollowingLatest = false;

export const triggerMoveHistoryPopupReload = (): void => {
  reloadListeners.forEach((listener) => listener());
};

export const subscribeMoveHistoryPopupReload = (
  listener: () => void,
): (() => void) => {
  reloadListeners.add(listener);
  return () => reloadListeners.delete(listener);
};

export const triggerMoveHistoryPopupSelectionReset = (): void => {
  selectionResetListeners.forEach((listener) => listener());
};

export const subscribeMoveHistoryPopupSelectionReset = (
  listener: () => void,
): (() => void) => {
  selectionResetListeners.add(listener);
  return () => selectionResetListeners.delete(listener);
};

export const setMoveHistoryPopupState = (
  isOpen: boolean,
  isFollowingLatest: boolean,
): void => {
  popupIsOpen = isOpen;
  popupIsFollowingLatest = isFollowingLatest;
};

export const setMoveHistoryPopupFollowingLatest = (
  following: boolean,
): void => {
  popupIsFollowingLatest = following;
};

export const getMoveHistoryPopupFollowingLatest = (): boolean =>
  popupIsFollowingLatest;

export const isMoveHistoryPopupFollowingLatest = (): boolean =>
  popupIsOpen && popupIsFollowingLatest;
