import { hideShinyCard } from "./shinyCardUiPort";
import { resetIslandOverlayState } from "./islandOverlayState";
type SimpleTransientUiHandler = () => void;
type NavigationTransientUiHandler = (options?: {
  preserveNavigationSelection?: boolean;
}) => void;
type BoardTransientUiHandler = (fadeOutVideos?: boolean) => void;

const noopSimpleHandler: SimpleTransientUiHandler = () => {};
const noopNavigationHandler: NavigationTransientUiHandler = () => {};
const noopBoardHandler: BoardTransientUiHandler = () => {};

let closeNavigationAndAppearancePopupHandler: NavigationTransientUiHandler =
  noopNavigationHandler;
let clearBottomControlsMatchScopeHandler: SimpleTransientUiHandler =
  noopSimpleHandler;
let closeAllKindsOfPopupsHandler: SimpleTransientUiHandler = noopSimpleHandler;
let closeProfilePopupHandler: SimpleTransientUiHandler = noopSimpleHandler;
let hideNotificationBannerHandler: SimpleTransientUiHandler = noopSimpleHandler;
let clearBoardTransientUiHandler: BoardTransientUiHandler = noopBoardHandler;

let hasBottomControlsHandler = false;
let hasMainMenuHandler = false;
let hasProfileHandler = false;
let hasBoardHandler = false;
let hasPendingCloseTransientUi = false;

const hasAllTransientUiHandlers = () => {
  return (
    hasBottomControlsHandler &&
    hasMainMenuHandler &&
    hasProfileHandler &&
    hasBoardHandler
  );
};

const runCloseTransientUi = () => {
  closeNavigationAndAppearancePopupHandler({
    preserveNavigationSelection: true,
  });
  clearBottomControlsMatchScopeHandler();
  closeAllKindsOfPopupsHandler();
  closeProfilePopupHandler();
  hideNotificationBannerHandler();
  hideShinyCard();
  resetIslandOverlayState();
  clearBoardTransientUiHandler(false);
};

const flushPendingCloseTransientUi = () => {
  if (!hasPendingCloseTransientUi) {
    return;
  }
  if (!hasAllTransientUiHandlers()) {
    return;
  }
  hasPendingCloseTransientUi = false;
  runCloseTransientUi();
};

export const registerBottomControlsTransientUiHandler = (
  handler: NavigationTransientUiHandler,
  clearMatchScopeHandler: SimpleTransientUiHandler = noopSimpleHandler,
) => {
  closeNavigationAndAppearancePopupHandler = handler;
  clearBottomControlsMatchScopeHandler = clearMatchScopeHandler;
  hasBottomControlsHandler = true;
  flushPendingCloseTransientUi();
  return () => {
    closeNavigationAndAppearancePopupHandler = noopNavigationHandler;
    clearBottomControlsMatchScopeHandler = noopSimpleHandler;
    hasBottomControlsHandler = false;
  };
};

export const registerMainMenuTransientUiHandler = (
  handler: SimpleTransientUiHandler,
) => {
  closeAllKindsOfPopupsHandler = handler;
  hasMainMenuHandler = true;
  flushPendingCloseTransientUi();
  return () => {
    closeAllKindsOfPopupsHandler = noopSimpleHandler;
    hasMainMenuHandler = false;
  };
};

export const registerProfileTransientUiHandler = (
  handler: SimpleTransientUiHandler,
  closePopupHandler: SimpleTransientUiHandler = noopSimpleHandler,
) => {
  hideNotificationBannerHandler = handler;
  closeProfilePopupHandler = closePopupHandler;
  hasProfileHandler = true;
  flushPendingCloseTransientUi();
  return () => {
    hideNotificationBannerHandler = noopSimpleHandler;
    closeProfilePopupHandler = noopSimpleHandler;
    hasProfileHandler = false;
  };
};

export const registerBoardTransientUiHandler = (
  handler: BoardTransientUiHandler,
) => {
  clearBoardTransientUiHandler = handler;
  hasBoardHandler = true;
  flushPendingCloseTransientUi();
  return () => {
    clearBoardTransientUiHandler = noopBoardHandler;
    hasBoardHandler = false;
  };
};

export const closeTransientUi = () => {
  if (!hasAllTransientUiHandlers()) {
    hasPendingCloseTransientUi = true;
    return;
  }
  hasPendingCloseTransientUi = false;
  runCloseTransientUi();
};
